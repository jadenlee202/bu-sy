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
