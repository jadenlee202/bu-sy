"""Run: python -m pytest"""
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import campus  # noqa: E402
import community_events  # noqa: E402
import main  # noqa: E402
from analytics import classify, hourly_time_weighted, latest_at, time_weighted_percentile  # noqa: E402

client = TestClient(main.app)
COD = "COD_Bosch_Office_1_Clemente"


@pytest.fixture(autouse=True)
def temp_event_store(tmp_path, monkeypatch):
    monkeypatch.setattr(community_events, "STORE", tmp_path / "events.json")


# ---------- analytics ----------
def t(hms):
    return datetime.fromisoformat(f"2015-11-09T{hms}")


SERIES = [(t("07:00:00"), 0), (t("09:00:00"), 4), (t("09:30:00"), 2), (t("20:00:00"), 0)]
END = t("20:00:00")


def test_classify_thresholds():
    assert classify(0.39) == "quiet"
    assert classify(0.40) == "moderate"
    assert classify(0.75) == "busy"
    assert classify(0.9, tolerance=1.25) == "moderate"
    assert classify(None) == "unknown"


def test_latest_at_holds_until_next_and_stops_at_coverage_end():
    assert latest_at(SERIES, t("06:59:59"), END) is None          # before first: unavailable, not 0
    assert latest_at(SERIES, t("09:15:00"), END)[1] == 4
    assert latest_at(SERIES, t("09:30:00"), END)[1] == 2          # "at or before"
    assert latest_at(SERIES, t("20:00:01"), END) is None          # never past the window


def test_hourly_is_time_weighted_not_row_averaged():
    hours = hourly_time_weighted(SERIES, 7, 20, END)
    assert hours[0] == 0                       # 7-8 AM
    assert hours[2] == 3.0                     # 9-10: 30 min at 4 + 30 min at 2
    assert hours[3] == 2.0                     # held at 2 afterwards


def test_percentile_weights_by_time():
    # 2h at 0, 30m at 4, 10.5h at 2 -> the 90th percentile of time is 2, not 4
    assert time_weighted_percentile([(SERIES, END)], 0.9) == 2


# ---------- facilities ----------
def test_facility_list_and_playback():
    rows = {f["facility_id"]: f for f in client.get("/api/facilities?at=18:00").json()}
    fitrec = rows["fitrec-synthetic"]
    assert fitrec["occupancy_count"] == 741 and fitrec["busyness"] == "busy"
    assert fitrec["data_mode"] == "synthetic" and fitrec["capacity_is_illustrative"]
    cod = rows[COD]
    assert cod["data_mode"] == "historical_playback"
    assert cod["timezone"] is None and cod["capacity"] is None


def test_unavailable_outside_recorded_hours():
    d = client.get("/api/facilities/fitrec-synthetic?at=06:30").json()
    assert d["occupancy_count"] is None and d["busyness"] == "unknown" and d["areas"] == []


def test_cod_history_keeps_source_timestamps():
    h = client.get(f"/api/facilities/{COD}/history").json()
    assert h["day"] == "2015-11-09" and h["timezone"] is None
    assert h["observations"][0]["observed_at"] == "2015-11-09T07:00:00"  # no offset invented
    assert h["typical"] and h["busyness_reference"] == 4


def test_history_404s():
    assert client.get("/api/facilities/nope/history").status_code == 404
    assert client.get(f"/api/facilities/{COD}/history?date=2016-03-05").status_code == 404


# ---------- community events (unofficial meetups) ----------
EVENTS = "/api/community-events"


def new_event(**overrides):
    body = {
        "title": "Basketball run", "place": "Basketball · Floor 2 (4 courts)", "note": "Court 4",
        "date": (date.today() + timedelta(days=3)).isoformat(), "start": "18:00", "end": "20:00",
        "host": "Ben", "spots": 3, "invite_only": True, "token": "host-token-1",
    }
    return {**body, **overrides}


def as_device(token):
    return {"X-BUsy-Device": token}


def create(**overrides):
    r = client.post(EVENTS, json=new_event(**overrides))
    assert r.status_code == 201, r.text
    return r.json()


def join(eid, token, code=None, name="Al"):
    return client.post(f"{EVENTS}/{eid}/join", json={"token": token, "name": name, "code": code})


def test_invite_only_flow():
    event = create()
    code, eid = event["invite_code"], event["id"]
    assert event["is_host"] and event["going_count"] == 1

    assert join(eid, "guest-token-1", "NOPE").status_code == 403
    assert join(eid, "guest-token-1").status_code == 403                 # no code at all
    ok = join(eid, "guest-token-1", f"  {code.lower().replace('-', ' ')} ")  # case/spacing forgiven
    assert ok.status_code == 200 and ok.json()["joined"]
    assert join(eid, "guest-token-2", code).status_code == 200
    assert join(eid, "guest-token-3", code).status_code == 409          # 3 spots incl. the host

    assert client.post(f"{EVENTS}/{eid}/leave", json={"token": "host-token-1"}).status_code == 400
    assert client.post(f"{EVENTS}/{eid}/cancel", json={"token": "guest-token-1"}).status_code == 403
    assert client.post(f"{EVENTS}/{eid}/cancel", json={"token": "host-token-1"}).status_code == 204
    assert join(eid, "guest-token-4", code).status_code == 404          # cancelled = gone


def test_invite_code_is_only_shown_to_the_host():
    event = create()
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}", event["invite_code"])
    for viewer in ({}, as_device("guest-token-1")):
        listed = client.get(EVENTS, headers=viewer).json()
        assert all(e["invite_code"] is None for e in listed)
    mine = [e for e in client.get(EVENTS, headers=as_device("host-token-1")).json() if e["is_host"]]
    assert mine[0]["invite_code"] == event["invite_code"]
    # Joining never reveals the code either.
    assert join(event["id"], "guest-token-1", event["invite_code"]).json()["invite_code"] is None


def test_device_token_is_not_read_from_the_url():
    create()
    via_query = client.get(f"{EVENTS}?token=host-token-1").json()
    assert not any(e["is_host"] for e in via_query)


def test_responses_never_include_tokens_or_attendee_names():
    eid = create(invite_only=False)["id"]
    join(eid, "guest-token-1", name="Secret Name")
    for e in client.get(EVENTS, headers=as_device("guest-token-1")).json():
        assert set(e) == {"id", "title", "place", "note", "date", "start", "end", "host", "spots",
                          "invite_only", "example", "going_count", "joined", "is_host", "invite_code"}
    assert "Secret Name" not in client.get(EVENTS).text


def test_repeated_join_does_not_duplicate():
    eid = create(invite_only=False, spots=None)["id"]
    for _ in range(3):
        assert join(eid, "guest-token-1").json()["going_count"] == 2
    assert join(eid, "host-token-1").json()["going_count"] == 2           # host is already going


def test_leave_only_removes_yourself():
    eid = create(invite_only=False, spots=None)["id"]
    join(eid, "guest-token-1")
    join(eid, "guest-token-2")
    r = client.post(f"{EVENTS}/{eid}/leave", json={"token": "guest-token-1"})
    assert r.json()["going_count"] == 2 and not r.json()["joined"]
    assert join(eid, "guest-token-2").json()["joined"]


def test_capacity_holds_under_concurrent_joins():
    eid = create(invite_only=False, spots=5)["id"]
    body = lambda i: community_events.JoinRequest(token=f"guest-token-{i:03d}", name="x")  # noqa: E731

    def attempt(i):
        try:
            community_events.join_event(eid, body(i))
            return True
        except HTTPException as e:
            assert e.status_code == 409
            return False

    with ThreadPoolExecutor(max_workers=16) as pool:
        joined = sum(pool.map(attempt, range(40)))
    assert joined == 4                                                   # 5 spots incl. the host
    assert join(eid, "late-token-1").status_code == 409


def test_events_without_a_limit_are_still_capped():
    eid = create(invite_only=False, spots=None)["id"]
    for i in range(community_events.MAX_ATTENDEES - 1):
        community_events.join_event(eid, community_events.JoinRequest(token=f"guest-token-{i:04d}", name="x"))
    assert join(eid, "one-more-token").status_code == 409


def test_ended_events_cannot_be_joined(monkeypatch):
    eid = create(invite_only=False)["id"]
    later = datetime.combine(date.today() + timedelta(days=4), datetime.min.time())
    monkeypatch.setattr(community_events, "_now", lambda: later)
    r = join(eid, "guest-token-1")
    assert r.status_code == 410
    assert not any(e["id"] == eid for e in client.get(EVENTS).json())    # and it's no longer listed


@pytest.mark.parametrize("overrides", [
    dict(start="20:00", end="18:00"),
    dict(start="23:00", end="99:99"),       # used to be stored, then crash every listing
    dict(start="7:00", end="08:00"),
    dict(end="24:00"),
    dict(title=""), dict(title="   "), dict(host="  "),
    dict(title="x" * 61), dict(place="y" * 61), dict(note="z" * 81), dict(host="h" * 31),
    dict(title="line\nbreak"), dict(note="tab\there"),
    dict(spots=1), dict(spots=201),
    dict(date="2020-01-01"),                # already over
    dict(date=(date.today() + timedelta(days=61)).isoformat()),
    dict(token="short"),
])
def test_event_validation(overrides):
    assert client.post(EVENTS, json=new_event(**overrides)).status_code == 422


def test_join_validation():
    eid = create()["id"]
    assert join(eid, "guest-token-1", name="   ").status_code == 422
    assert join(eid, "guest-token-1", code="X" * 17).status_code == 422
    assert join(eid, "ex0").status_code == 422                           # example attendees can't be impersonated


def test_text_is_stored_as_given_not_interpreted():
    title = '<img src=x onerror="alert(1)">'
    assert create(title=title, invite_only=False)["title"] == title   # escaping is the screen's job (esc())


def test_listing_survives_bad_stored_data():
    create(invite_only=False)
    events = json.loads(community_events.STORE.read_text(encoding="utf-8"))
    events.append({**events[-1], "id": "broken", "end": "99:99"})      # e.g. written before validation
    community_events.STORE.write_text(json.dumps(events), encoding="utf-8")
    r = client.get(EVENTS)
    assert r.status_code == 200 and "broken" not in {e["id"] for e in r.json()}
    assert join("broken", "guest-token-1").status_code == 410


def test_unreadable_store_gives_a_clear_error():
    community_events.STORE.write_text("{not json", encoding="utf-8")
    r = client.get(EVENTS)
    assert r.status_code == 503 and "community_events.json" in r.json()["detail"]


def test_saves_are_atomic_and_old_events_are_pruned(monkeypatch):
    eid = create(invite_only=False)["id"]
    assert not community_events.STORE.with_suffix(".tmp").exists()
    later = datetime.combine(date.today() + timedelta(days=6), datetime.min.time())
    monkeypatch.setattr(community_events, "_now", lambda: later)
    create(invite_only=False, date=(date.today() + timedelta(days=7)).isoformat())
    stored = {e["id"] for e in json.loads(community_events.STORE.read_text(encoding="utf-8"))}
    assert eid not in stored


def test_upcoming_event_cap(monkeypatch):
    upcoming = len(client.get(EVENTS).json())                              # examples still ahead today
    monkeypatch.setattr(community_events, "MAX_UPCOMING", upcoming + 1)
    create(invite_only=False)
    assert client.post(EVENTS, json=new_event()).status_code == 503


def test_seed_events_are_upcoming_examples():
    events = client.get(EVENTS).json()
    assert events and all(e["example"] for e in events)


def test_static_export_has_no_codes_or_tokens():
    seeds = static("community_events_seed.json")
    text = json.dumps(seeds)
    assert seeds and "invite_code" not in text and "token" not in text


# ---------- planner data (/api/campus) ----------
def test_campus_places_are_synthetic_campus_only():
    data = client.get("/api/campus").json()
    assert data["label"] == "Demo · Synthetic campus data"
    assert data["places"] and all(p["data_mode"] == "synthetic" for p in data["places"])
    assert COD not in {p["facility_id"] for p in data["places"]}
    assert data["travel_basis"] == "Sample walking time"


def test_campus_hours_closures_and_amenities_are_labelled():
    places = {p["place_id"]: p for p in client.get("/api/campus").json()["places"]}
    basement = places["fitrec-synthetic:basketball-court-basement"]
    assert basement["closures"] == [{"start": "19:00", "end": "21:00", "source": "sample schedule",
                                     "reason": "Reserved: Intramural basketball (sample)"}]
    assert places["fenway-dining-synthetic"]["hours"] is None
    assert places["fenway-dining-synthetic"]["hours_basis"] == "unknown"
    assert places["mugar-synthetic"]["hours_basis"] == "illustrative"
    assert all(p["amenities_basis"] == "illustrative" for p in places.values())


def test_campus_travel_leaves_missing_routes_unknown():
    pairs = {frozenset((t["from_id"], t["to_id"])) for t in client.get("/api/campus").json()["travel"]}
    assert frozenset(("west", "fenway")) not in pairs      # unknown, not zero


def write_campus(tmp_path, mutate):
    raw = json.loads(campus.PLACES_JSON.read_text(encoding="utf-8"))
    mutate(raw)
    path = tmp_path / "campus.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def test_campus_loader_refuses_cod_as_a_place(tmp_path):
    def add_cod(raw):
        raw["facilities"][COD] = {"location": "mugar", "hours": [["07:00", "20:00"]]}
        raw["places"].append({"facility_id": COD, "activities": ["study"]})
    with pytest.raises(ValueError, match="not a campus destination"):
        campus.load_campus(main.FACILITIES, write_campus(tmp_path, add_cod))


@pytest.mark.parametrize("mutate, message", [
    (lambda r: r["places"].append({"facility_id": "nope", "activities": ["eat"]}), "unknown facility"),
    (lambda r: r["facilities"]["mugar-synthetic"].update(hours=[["09:00", "08:00"]]), "increasing"),
    (lambda r: r["facilities"]["mugar-synthetic"].update(hours=[["9am", "17:00"]]), "HH:MM"),
    (lambda r: r["places"][0].update(amenities={"wifi": True}), "unknown amenities"),
    (lambda r: r["scenarios"][0].update({"from": "mars"}), "unknown location"),
])
def test_campus_loader_rejects_bad_data(tmp_path, mutate, message):
    with pytest.raises(ValueError, match=message):
        campus.load_campus(main.FACILITIES, write_campus(tmp_path, mutate))


def test_travel_loader_rejects_duplicates_and_unknown_places(tmp_path):
    ids = {"a", "b"}
    dup = tmp_path / "dup.csv"
    dup.write_text("from_location,to_location,walk_minutes\na,b,5\nb,a,6\n", encoding="utf-8")
    with pytest.raises(ValueError, match="twice"):
        campus.load_travel(dup, ids)
    bad = tmp_path / "bad.csv"
    bad.write_text("from_location,to_location,walk_minutes\na,z,5\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unknown location"):
        campus.load_travel(bad, ids)


# ---------- static mode == API mode ----------
STATIC = Path(main.WEB_DIR) / "data"


def static(name):
    return json.loads((STATIC / name).read_text(encoding="utf-8"))


def test_static_export_matches_the_api():
    """The planner engine gets identical input in both modes. If this fails, run
    `python server/export_static.py` and commit web/data/."""
    assert static("campus.json") == client.get("/api/campus").json()
    assert static("facilities.json") == client.get("/api/facilities?at=12:00").json()
    for facility_id in main.FACILITIES:
        assert static(f"history/{facility_id}.json") == client.get(f"/api/facilities/{facility_id}/history").json()


def test_api_allows_cross_origin_reads():
    """A site on another origin can use ?api=… (no credentials involved)."""
    r = client.get("/api/campus", headers={"Origin": "https://example.github.io"})
    assert r.headers["access-control-allow-origin"] == "*"
