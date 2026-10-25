"""Run: python -m pytest"""
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fastapi.testclient import TestClient  # noqa: E402

import campus  # noqa: E402
import main  # noqa: E402
from analytics import classify, hourly_time_weighted, latest_at, time_weighted_percentile  # noqa: E402

client = TestClient(main.app)
COD = "COD_Bosch_Office_1_Clemente"


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
    assert "access-control-allow-credentials" not in r.headers


def test_cors_credentials_only_for_listed_origins():
    """The calendar cookie may cross origins only to sites named in BUSY_CORS_ORIGINS."""
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.testclient import TestClient

    assert main.cors_options(None)["allow_credentials"] is False
    assert main.cors_options("*")["allow_credentials"] is False
    options = main.cors_options("https://site.test, https://other.test")
    assert options["allow_origins"] == ["https://site.test", "https://other.test"]
    assert options["allow_credentials"] is True

    app = FastAPI()
    app.add_middleware(CORSMiddleware, **options)
    app.get("/ping")(lambda: {"ok": True})
    listed = TestClient(app).get("/ping", headers={"Origin": "https://site.test"})
    assert listed.headers["access-control-allow-origin"] == "https://site.test"
    assert listed.headers["access-control-allow-credentials"] == "true"
    stranger = TestClient(app).get("/ping", headers={"Origin": "https://evil.test"})
    assert "access-control-allow-origin" not in stranger.headers
