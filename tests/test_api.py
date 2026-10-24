"""Run: python -m pytest"""
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fastapi.testclient import TestClient  # noqa: E402

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


# ---------- community events ----------
def new_event(**overrides):
    body = {
        "title": "Basketball run", "place": "Basketball · Floor 2 (4 courts)", "note": "Court 4",
        "date": (date.today() + timedelta(days=3)).isoformat(), "start": "18:00", "end": "20:00",
        "host": "Ben", "spots": 3, "invite_only": True, "token": "host-token-1",
    }
    return {**body, **overrides}


def test_invite_only_flow():
    r = client.post("/api/community-events", json=new_event())
    assert r.status_code == 201
    event = r.json()
    code, eid = event["invite_code"], event["id"]
    assert code and event["is_host"] and event["going_count"] == 1

    # Guests never see the code.
    listed = client.get("/api/community-events?token=guest-token-1").json()
    assert all(e["invite_code"] is None for e in listed)

    join = f"/api/community-events/{eid}/join"
    assert client.post(join, json={"token": "guest-token-1", "name": "Al", "code": "NOPE"}).status_code == 403
    ok = client.post(join, json={"token": "guest-token-1", "name": "Al", "code": code.lower()})
    assert ok.status_code == 200 and ok.json()["joined"]
    again = client.post(join, json={"token": "guest-token-1", "name": "Al", "code": code})
    assert again.json()["going_count"] == 2                      # joining twice is a no-op
    client.post(join, json={"token": "guest-token-2", "name": "Bo", "code": code})
    assert client.post(join, json={"token": "guest-token-3", "name": "Cy", "code": code}).status_code == 409

    assert client.post(f"/api/community-events/{eid}/leave", json={"token": "host-token-1"}).status_code == 400
    assert client.post(f"/api/community-events/{eid}/cancel", json={"token": "guest-token-1"}).status_code == 403
    assert client.post(f"/api/community-events/{eid}/cancel", json={"token": "host-token-1"}).status_code == 204


def test_event_validation():
    assert client.post("/api/community-events", json=new_event(start="20:00", end="18:00")).status_code == 422
    assert client.post("/api/community-events", json=new_event(title="")).status_code == 422


def test_seed_events_are_upcoming_examples():
    events = client.get("/api/community-events").json()
    assert events and all(e["example"] for e in events)


# ---------- verified facility metadata (feature/verified-facility-info) ----------

def _by_id():
    return {f["facility_id"]: f for f in client.get("/api/facilities?at=12:00").json()}


def test_verified_info_separate_from_occupancy():
    """Verified hours must not change occupancy provenance for a synthetic place."""
    f = _by_id()["fitrec-synthetic"]
    # verified_info is present...
    assert f["verified_info"] is not None
    assert f["verified_info"]["hours_source_url"].startswith("https://www.bu.edu/fitrec")
    # ...but occupancy is still clearly synthetic and unchanged.
    assert f["data_mode"] == "synthetic"
    assert f["measurement_method"] == "synthetic"
    assert "synthetic" in f["source"].lower()
    assert f["capacity_is_illustrative"] is True


def test_opening_hours_populated_only_when_verified():
    """FitRec has a verified regular schedule; dining halls do not (left unknown)."""
    rows = _by_id()
    fitrec = rows["fitrec-synthetic"]
    assert fitrec["opening_hours"] is not None
    assert fitrec["opening_hours"]["weekly"]["0"] == "06:00-23:00"  # Monday
    assert fitrec["opening_hours"]["source_url"].startswith("https://www.bu.edu/fitrec")
    # Dining halls: meal windows were not pinned to dates -> unknown, not invented.
    warren = rows["warren-dining-synthetic"]
    assert warren["opening_hours"] is None


def test_unverified_facility_has_no_verified_info():
    """COD was not researched as a BU place; it must carry no verified metadata."""
    cod = _by_id()[COD]
    assert cod["verified_info"] is None
    assert cod["opening_hours"] is None


def test_schedule_kinds_are_distinguished():
    """Regular, holiday and special-event schedules are kept separate, not merged."""
    fitrec = _by_id()["fitrec-synthetic"]
    kinds = {h["schedule_kind"] for h in fitrec["verified_info"]["hours"]}
    assert "regular" in kinds
    assert "holiday" in kinds   # Oct 12 adjusted + Thanksgiving closure


def test_dining_hall_is_not_a_study_destination():
    """A dining hall must not auto-qualify as a study space."""
    for fid in ("warren-dining-synthetic", "marciano-dining-synthetic",
                "west-dining-synthetic", "fenway-dining-synthetic"):
        info = _by_id()[fid]["verified_info"]
        assert info["study_friendly"] is False, f"{fid} wrongly marked study-friendly"
        assert "meal" in info["access_summary"].lower()  # access is gated


def test_library_is_a_confirmed_study_destination():
    """Mugar is explicitly confirmed study-friendly."""
    info = _by_id()["mugar-synthetic"]["verified_info"]
    assert info["study_friendly"] is True


def test_walking_time_never_claims_exact_or_verified_routing():
    """Hand-estimated walking times must flag themselves as not exact/not routing."""
    for fid, info in [(k, v) for k, v in
                      {f["facility_id"]: f["verified_info"] for f in
                       client.get("/api/facilities?at=12:00").json()}.items()
                      if v and v.get("walking")]:
        w = info["walking"]
        assert w["is_exact"] is False, f"{fid} walking claims exact"
        assert w["is_verified_routing"] is False, f"{fid} walking claims verified routing"
        assert isinstance(w["minutes_approx"], int)


def test_verified_info_records_source_and_checked_date():
    """Every verified fact group must carry a source URL and a checked date."""
    info = _by_id()["fitrec-synthetic"]["verified_info"]
    assert info["hours_source_url"] and info["hours_checked"]
    assert info["access_source_url"] and info["access_checked"]
    assert info["amenities_source_url"] and info["amenities_checked"]


def test_open_questions_are_preserved():
    """Unresolved questions are surfaced, not dropped."""
    info = _by_id()["fitrec-synthetic"]["verified_info"]
    assert isinstance(info["open_questions"], list)
    assert len(info["open_questions"]) >= 1


def test_detail_endpoint_also_carries_verified_info():
    """FacilityDetail inherits verified_info from FacilitySummary."""
    d = client.get("/api/facilities/fitrec-synthetic?at=18:00").json()
    assert d["verified_info"] is not None
    assert d["opening_hours"] is not None
