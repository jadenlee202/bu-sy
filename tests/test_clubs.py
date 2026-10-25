"""Club directory: API, capacity/waitlist rules, organizer gating, busyness hint. Run: python -m pytest"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import clubs  # noqa: E402
import main  # noqa: E402
from analytics import classify, hourly_time_weighted, time_weighted_mean  # noqa: E402

client = TestClient(main.app)
CLUBS = "/api/clubs"
ORG = "organizer-token-1"


@pytest.fixture(autouse=True)
def temp_club_store(tmp_path, monkeypatch):
    monkeypatch.setattr(clubs, "STORE", tmp_path / "clubs.json")


def new_club(**overrides):
    body = {
        "name": "Chess Club", "category": "Social", "description": "Casual and rated games.",
        "activities": "Weekly games", "meeting_day": "Wednesday", "meeting_start": "18:00", "meeting_end": "19:00",
        "location_id": "mugar-synthetic", "location_text": "Mugar, 2nd floor", "officers": [{"role": "President", "name": "Ann"}],
        "contact": "chess@bu.edu", "requirements": "", "requires_approval": False, "capacity": 3, "waitlist": True,
        "upcoming": [], "token": ORG,
    }
    return {**body, **overrides}


def create(**overrides):
    r = client.post(CLUBS, json=new_club(**overrides))
    assert r.status_code == 201, r.text
    return r.json()


def application(token, **overrides):
    return {"token": token, "name": "Sam Student", "email": "sam@bu.edu", "year": "Sophomore",
            "contact": "", "reason": "", "availability": "", **overrides}


def apply(cid, token, **overrides):
    return client.post(f"{CLUBS}/{cid}/apply", json=application(token, **overrides))


def device(token):
    return {"X-BUsy-Device": token}


def apps(cid, token=ORG):
    return client.get(f"{CLUBS}/{cid}/applications", headers=device(token))


def decide(cid, app_id, decision, token=ORG):
    return client.post(f"{CLUBS}/{cid}/applications/{app_id}/decide", json={"token": token, "decision": decision})


def my_status(cid, token):
    return client.get(f"{CLUBS}/{cid}", headers=device(token)).json()["my_application"]


# ---------- busyness hint (data science) ----------
def t(hms):
    return datetime.fromisoformat(f"2015-11-09T{hms}")


SERIES = [(t("07:00:00"), 0), (t("09:00:00"), 4), (t("09:30:00"), 2), (t("20:00:00"), 0)]


def test_time_weighted_mean_counts_each_second_once_and_skips_gaps():
    assert time_weighted_mean(SERIES, t("09:00:00"), t("10:00:00"), t("20:00:00")) == (3.0, 3600)
    assert time_weighted_mean(SERIES, t("06:00:00"), t("07:00:00"), t("20:00:00")) == (None, 0)   # before data: none, not 0
    mean, covered = time_weighted_mean(SERIES, t("09:00:00"), t("10:00:00"), t("20:00:00"), timedelta(minutes=15))
    assert (mean, covered) == (3.0, 1800)                     # 15-min holds: half the hour is a gap, left out


def test_meeting_hint_matches_the_existing_hourly_analytics():
    f = main.FACILITIES["fitrec-synthetic"]
    day = f.default_day
    hour = hourly_time_weighted(f.days[day], 18, 19, f.coverage_end(day), f.max_hold)[0]
    hint = clubs.meeting_busyness(f, "18:00", "19:00")
    assert abs(hint["estimate"] - hour) <= 0.5
    assert hint["level"] == classify(hour / f.capacity)
    assert hint["coverage"] == 1.0
    assert "Estimate" in hint["basis"] and "simulated" in hint["basis"] and "weekday isn't modeled" in hint["basis"]


def test_meeting_hint_is_honest_about_missing_data():
    mugar = main.FACILITIES["mugar-synthetic"]                 # synthetic 08:00-23:00
    assert clubs.meeting_busyness(None, "18:00", "19:00") is None
    assert clubs.meeting_busyness(mugar, None, None) is None
    early = clubs.meeting_busyness(mugar, "06:30", "08:30")    # 25% covered
    assert early["level"] == "unknown" and early["estimate"] is None
    cod = main.FACILITIES["COD_Bosch_Office_1_Clemente"]
    assert clubs.meeting_busyness(cod, "09:00", "10:00") is None   # historical references never qualify


# ---------- create, browse ----------
def test_create_club_and_list_it_without_private_fields():
    club = create()
    assert club["is_organizer"] and club["status"] == "Open" and club["spots_left"] == 3
    assert club["busyness_hint"]["level"] in {"quiet", "moderate", "busy"}
    listed = {c["id"]: c for c in client.get(CLUBS, headers=device("someone-else-1")).json()}
    other = listed[club["id"]]
    assert not other["is_organizer"]
    assert "organizer_token" not in other and "applications" not in other


def test_seed_clubs_cover_every_status_and_are_labelled():
    seeds = [c for c in client.get(CLUBS).json() if c["example"]]
    assert len(seeds) == len(clubs.SEED_CLUBS)
    assert {c["status"] for c in seeds} == {"Open", "Waitlist", "Full"}
    assert {c["category"] for c in seeds} == set(clubs.CATEGORIES)


def test_missing_details_stay_empty_not_invented():
    board = next(c for c in client.get(CLUBS).json() if c["name"] == "Board Game Night")
    assert board["meeting_day"] is None and board["meeting_start"] is None and board["next_meeting"] is None
    assert board["officers"] == [] and board["contact"] == "" and board["busyness_hint"] is None


# ---------- sign-up, duplicates, capacity, waitlist ----------
def test_sign_up_is_approved_or_pending_by_club_setting():
    open_club = create()
    assert apply(open_club["id"], "student-token-1").json()["my_application"]["status"] == "approved"
    reviewed = create(name="Debate", requires_approval=True)
    r = apply(reviewed["id"], "student-token-1").json()
    assert r["my_application"]["status"] == "pending" and r["members"] == 0 and r["spots_left"] == 2


def test_duplicate_sign_up_is_refused():
    cid = create()["id"]
    assert apply(cid, "student-token-1").status_code == 200
    r = apply(cid, "student-token-1")
    assert r.status_code == 409 and "already applied" in r.json()["detail"]
    assert client.get(f"{CLUBS}/{cid}").json()["members"] == 1


def test_full_club_offers_the_waitlist_never_an_unbounded_join():
    cid = create(capacity=2)["id"]
    apply(cid, "student-token-1")
    apply(cid, "student-token-2")
    r = apply(cid, "student-token-3")
    assert r.status_code == 409 and "waitlist" in r.json()["detail"]
    w = apply(cid, "student-token-3", join_waitlist=True).json()
    assert w["my_application"] == {**w["my_application"], "status": "waitlisted", "position": 1}
    assert w["members"] == 2 and w["status"] == "Waitlist"
    nowait = create(name="Tiny", capacity=1, waitlist=False)["id"]
    apply(nowait, "student-token-1")
    r = apply(nowait, "student-token-2", join_waitlist=True)
    assert r.status_code == 409 and "isn't taking waitlist" in r.json()["detail"]
    assert client.get(f"{CLUBS}/{nowait}").json()["status"] == "Full"


def test_capacity_holds_under_concurrent_sign_ups():
    cid = create(capacity=5)["id"]

    def attempt(i):
        try:
            clubs.apply(cid, clubs.Application(**application(f"student-token-{i:03d}")), main.FACILITIES)
            return True
        except HTTPException as e:
            assert e.status_code == 409
            return False

    with ThreadPoolExecutor(max_workers=16) as pool:
        joined = sum(pool.map(attempt, range(40)))
    assert joined == 5
    assert client.get(f"{CLUBS}/{cid}").json()["members"] == 5


def test_withdrawing_moves_the_waitlist_up_in_order():
    cid = create(capacity=1)["id"]
    apply(cid, "student-token-1")
    apply(cid, "student-token-2", join_waitlist=True)
    apply(cid, "student-token-3", join_waitlist=True)
    assert my_status(cid, "student-token-3")["position"] == 2
    r = client.post(f"{CLUBS}/{cid}/withdraw", json={"token": "student-token-1"})
    assert r.status_code == 200 and r.json()["my_application"] is None
    assert my_status(cid, "student-token-2")["status"] == "approved"
    assert my_status(cid, "student-token-3") == {**my_status(cid, "student-token-3"), "status": "waitlisted", "position": 1}
    assert client.post(f"{CLUBS}/{cid}/withdraw", json={"token": "student-token-1"}).status_code == 404


def test_waitlist_moves_to_pending_when_the_club_needs_approval():
    cid = create(capacity=1, requires_approval=True)["id"]
    apply(cid, "student-token-1")
    apply(cid, "student-token-2", join_waitlist=True)
    first = next(a for a in apps(cid).json() if a["status"] == "pending")
    decide(cid, first["id"], "reject")
    assert my_status(cid, "student-token-2")["status"] == "pending"      # moved up, still needs approval


# ---------- approval flow ----------
def test_officer_approval_flow():
    cid = create(capacity=1, requires_approval=True)["id"]
    apply(cid, "student-token-1", name="Pat", email="PAT@bu.edu", reason="I love chess")
    apply(cid, "student-token-2", join_waitlist=True)
    listed = apps(cid).json()
    assert [a["status"] for a in listed] == ["pending", "waitlisted"]
    assert listed[0]["email"] == "pat@bu.edu" and listed[0]["reason"] == "I love chess"
    waiting = listed[1]
    assert decide(cid, waiting["id"], "approve").status_code == 409     # no free spot yet
    assert decide(cid, listed[0]["id"], "approve").json()["members"] == 1
    assert my_status(cid, "student-token-1")["status"] == "approved"
    decide(cid, listed[0]["id"], "reject")                               # removing a member frees the spot
    assert my_status(cid, "student-token-1")["status"] == "rejected"
    assert my_status(cid, "student-token-2")["status"] == "pending"
    r = apply(cid, "student-token-1")
    assert r.status_code == 409 and "declined" in r.json()["detail"]
    assert decide(cid, listed[0]["id"], "approve").status_code == 409   # declined stays declined


def test_edit_capacity_rules():
    cid = create(capacity=1)["id"]
    apply(cid, "student-token-1")
    apply(cid, "student-token-2", join_waitlist=True)
    edited = client.post(f"{CLUBS}/{cid}/edit", json=new_club(capacity=2, description="Bigger room now"))
    assert edited.status_code == 200 and edited.json()["description"] == "Bigger room now"
    assert my_status(cid, "student-token-2")["status"] == "approved"     # raising capacity moves the waitlist up
    r = client.post(f"{CLUBS}/{cid}/edit", json=new_club(capacity=1))
    assert r.status_code == 409 and "already approved" in r.json()["detail"]


# ---------- organizer-only gating (demo-grade) ----------
def test_only_the_organizer_can_edit_or_review():
    cid = create()["id"]
    apply(cid, "student-token-1", name="Private Person", email="private@bu.edu")
    app_id = apps(cid).json()[0]["id"]
    for token in ("student-token-1", "someone-else-1"):
        assert apps(cid, token).status_code == 403
        assert client.post(f"{CLUBS}/{cid}/edit", json=new_club(token=token, name="Hijacked")).status_code == 403
        assert decide(cid, app_id, "reject", token=token).status_code == 403
    assert client.get(f"{CLUBS}/{cid}/applications").status_code == 403                 # no token at all
    assert client.get(f"{CLUBS}/{cid}/applications?token={ORG}").status_code == 403      # never read from the URL
    assert client.get(f"{CLUBS}/{cid}").json()["name"] == "Chess Club"


def test_students_never_see_other_students_data():
    cid = create()["id"]
    apply(cid, "student-token-1", name="Private Person", email="private@bu.edu", reason="secret reason")
    for viewer in ({}, device("student-token-2"), device("student-token-1")):
        text = client.get(CLUBS, headers=viewer).text + client.get(f"{CLUBS}/{cid}", headers=viewer).text
        for leak in ("Private Person", "private@bu.edu", "secret reason", "student-token-1", ORG):
            assert leak not in text
    mine = client.get(f"{CLUBS}/{cid}", headers=device("student-token-1")).json()["my_application"]
    assert set(mine) == {"id", "status", "created_at", "position"}


def test_sample_clubs_have_no_organizer():
    seed = client.get(CLUBS).json()[0]
    assert seed["example"]
    apply(seed["id"], "student-token-1", name="Real Student", email="real@bu.edu")
    for token in ("example", "", "None", ORG, "student-token-1"):
        assert apps(seed["id"], token).status_code == 403
        assert not client.get(f"{CLUBS}/{seed['id']}", headers=device(token)).json()["is_organizer"]
    assert apply(seed["id"], "m0").status_code == 422           # placeholder members can't be impersonated


def test_organizer_cannot_apply_to_their_own_club():
    cid = create()["id"]
    assert apply(cid, ORG).status_code == 400


# ---------- validation ----------
@pytest.mark.parametrize("overrides", [
    dict(email="sam@gmail.com"), dict(email="sam@bu.edu.evil.com"), dict(email="not an email"),
    dict(name="   "), dict(name="x" * 61), dict(name="line\nbreak"), dict(year="Freshman"),
    dict(reason="r" * 501), dict(availability="a" * 121), dict(contact="c" * 81), dict(token="short"),
])
def test_application_validation(overrides):
    cid = create()["id"]
    body = {**application("student-token-1"), **overrides}
    assert client.post(f"{CLUBS}/{cid}/apply", json=body).status_code == 422


@pytest.mark.parametrize("overrides", [
    dict(name=""), dict(name="  "), dict(name="n" * 61), dict(category="Gaming"), dict(description=""),
    dict(description="d" * 601), dict(meeting_day="Funday"), dict(meeting_start="18:00", meeting_end=None),
    dict(meeting_start="19:00", meeting_end="18:00"), dict(meeting_start="7pm", meeting_end="8pm"),
    dict(capacity=0), dict(capacity=501), dict(location_id="COD_Bosch_Office_1_Clemente"), dict(location_id="moon"),
    dict(officers=[{"role": "P", "name": "x"}] * 6), dict(upcoming=[{"date": "2020-01-01", "note": ""}]),
    dict(upcoming=[{"date": (date.today() + timedelta(days=200)).isoformat(), "note": ""}]),
    dict(token="short"),
])
def test_club_validation(overrides):
    assert client.post(CLUBS, json=new_club(**overrides)).status_code == 422


def test_school_email_is_normalized_and_long_text_keeps_line_breaks():
    cid = create()["id"]
    apply(cid, "student-token-1", email="  Sam.Lee@BU.EDU ", reason="Line one\nLine two")
    a = apps(cid).json()[0]
    assert a["email"] == "sam.lee@bu.edu" and a["reason"] == "Line one\nLine two"


# ---------- storage and static mode ----------
def test_unknown_club_404s():
    assert client.get(f"{CLUBS}/nope").status_code == 404
    assert apply("nope", "student-token-1").status_code == 404


def test_unreadable_store_gives_a_clear_error():
    clubs.STORE.write_text("{not json", encoding="utf-8")
    r = client.get(CLUBS)
    assert r.status_code == 503 and "clubs.json" in r.json()["detail"]


def test_saves_are_atomic():
    create()
    assert clubs.STORE.exists() and not clubs.STORE.with_suffix(".tmp").exists()


def test_static_seed_matches_the_server_and_has_no_tokens():
    """If this fails, run `python server/export_static.py` and commit web/data/."""
    exported = json.loads((Path(main.WEB_DIR) / "data" / "clubs_seed.json").read_text(encoding="utf-8"))
    assert exported == json.loads(json.dumps(clubs.static_seed(main.FACILITIES)))
    text = json.dumps(exported)
    assert "token" not in text and "applications" not in text
    api_hints = {c["name"]: c["busyness_hint"] for c in client.get(CLUBS).json() if c["example"]}
    assert {c["name"]: c["busyness_hint"] for c in exported["clubs"]} == api_hints
