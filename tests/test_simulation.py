"""Simulated campus places: generation, provenance and labels.

Small fixtures here are made up for the test (SYNTHETIC FIXTURE). Nothing downloads.
Run: python -m pytest
"""
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "data"))

from fastapi.testclient import TestClient  # noqa: E402

import generate_campus_simulation as gen  # noqa: E402
import main  # noqa: E402
import sources  # noqa: E402

client = TestClient(main.app)
PROV = main.PROVENANCE
REFERENCES = {"COD_Bosch_Office_1_Clemente", "CAMPUS_GYM_HISTORICAL_REFERENCE"}


def sim_rows():
    with open(gen.OUT_CSV, newline="", encoding="utf-8") as f:
        return [(r["facility_id"], r["timestamp"], int(r["occupancy_count"])) for r in csv.DictReader(f)]


# ---------- transformation steps ----------
def at(hms):
    return datetime.fromisoformat(f"2016-12-05T{hms}-08:00")


def test_resampling_keeps_zero_and_leaves_gaps_empty():
    rows = [(at("06:00:00"), 0), (at("06:10:00"), 4), (at("06:20:00"), 6), (at("07:30:00"), 9)]  # SYNTHETIC FIXTURE
    profile = gen.gym_day_profile(rows, hold_min=30, window=(6, 8))
    assert profile[6 * 60] == 0                       # zero is a value
    assert profile[6 * 60 + 15] == 4
    assert profile[6 * 60 + 45] == 6                  # 25 min old: still held
    assert 7 * 60 not in profile                      # 40 min since the last reading: empty, not 0, not 6
    assert profile[7 * 60 + 30] == 9


def test_demo_clock_is_a_relabelling_not_a_timezone_conversion():
    assert gen.demo_time(6 * 60) == "2026-10-19T06:00:00"     # 06:00 -08:00 at the source stays 06:00
    rows = sim_rows()
    first_fitrec = min(t for fid, t, _ in rows if fid.startswith("SYN_BU_FITREC"))
    assert first_fitrec == "2026-10-19T06:00:00"              # FitRec's sample hours start at 6 AM


def test_interpolation_follows_the_documented_knots():
    assert gen.interpolate(gen.DINING_KNOTS, 12) == 0.75
    assert gen.interpolate(gen.DINING_KNOTS, 12.5) == pytest.approx(0.70)


# ---------- generated output ----------
def test_generation_is_deterministic_and_matches_the_committed_files(tmp_path, monkeypatch):
    monkeypatch.setattr(gen, "OUT_CSV", tmp_path / "sim.csv")
    monkeypatch.setattr(gen, "OUT_JSON", tmp_path / "prov.json")
    gen.main()
    first = (gen.OUT_CSV.read_bytes(), gen.OUT_JSON.read_bytes())
    gen.main()
    assert (gen.OUT_CSV.read_bytes(), gen.OUT_JSON.read_bytes()) == first
    assert first[0] == (ROOT / "data" / "campus_simulation_occupancy.csv").read_bytes()
    assert first[1] == (ROOT / "data" / "simulation_provenance.json").read_bytes()


def test_counts_are_whole_and_nonnegative():
    rows = sim_rows()
    assert rows and all(c >= 0 for _, _, c in rows)


def test_fitrec_is_one_building_count_equal_to_the_scaled_gym_count():
    sim = next(s for s in PROV["simulations"] if s["id"] == "fitrec-from-campus-gym")
    meta, gym_rows, _ = gen.load_gym()
    profile = gen.gym_day_profile(gym_rows, meta["gap_policy"]["max_hold_minutes"], tuple(sim["window"]))
    fitrec_rows = [(fid, t, c) for fid, t, c in sim_rows() if fid.startswith("SYN_BU_FITREC")]
    assert {fid for fid, _, _ in fitrec_rows} == {"SYN_BU_FITREC"}     # one series: no courts, pools or rooms
    assert {t: c for _, t, c in fitrec_rows} == {
        gen.demo_time(m): round(c * sim["parameters"]["scale"]) for m, c in profile.items()}
    assert sim["targets"] == [{"facility_id": "fitrec-synthetic", "name": "FitRec (whole building)", "capacity": 870}]


# ---------- provenance ----------
def test_every_simulated_place_has_exactly_one_mapping():
    targets = [t["facility_id"] for s in PROV["simulations"] for t in s["targets"]]
    assert len(targets) == len(set(targets))
    assert set(targets) == {fid for fid, f in main.FACILITIES.items() if f.campus_eligible}
    assert not REFERENCES & set(targets)


def test_mappings_are_complete_and_cite_only_used_datasets():
    datasets = {d["id"]: d for d in PROV["datasets"]}
    for d in datasets.values():
        assert all(d[k] for k in ("title", "creators", "url", "license", "metric", "original_location", "status"))
    for s in PROV["simulations"]:
        for k in ("transformations", "assumptions", "limits", "units", "window", "parameters", "label"):
            assert s[k], (s["id"], k)
        if s["basis"] == "reference_dataset":
            assert datasets[s["dataset_id"]]["status"] == "used" and s["source_fields"] and s["source_period"]
        else:
            assert s["dataset_id"] is None and s["label"] == "Modeled (no dataset)"   # no misleading citation
    assert {d["status"] for d in datasets.values()} >= {"used", "evaluated_not_used", "reference_only"}


# ---------- app contract ----------
def test_api_labels_simulated_places_and_leaves_references_unsimulated():
    rows = {f["facility_id"]: f for f in client.get("/api/facilities?at=12:00").json()}
    for fid, f in rows.items():
        if fid in REFERENCES:
            assert f["simulation"] is None and not f["campus_eligible"]
        else:
            assert f["simulation"]["basis"] in ("reference_dataset", "modeled") and f["campus_eligible"]
            assert "Not a BU measurement" in f["source"]
    assert rows["mugar-synthetic"]["simulation"]["basis"] == "modeled"
    assert rows["warren-dining-synthetic"]["source"].startswith("Modeled profile (no dataset)")


def test_no_area_schedule_or_reservation_is_served():
    """FitRec is tracked as one building: no courts, pools, rooms, classes or reservations."""
    assert "areas" not in client.get("/api/facilities/fitrec-synthetic?at=18:00").json()
    assert "areas" not in client.get("/api/facilities/fitrec-synthetic/history").json()
    assert client.get("/api/schedule").status_code == 404 and client.get("/api/programs").status_code == 404
    places = [p for p in client.get("/api/campus").json()["places"] if p["facility_id"] == "fitrec-synthetic"]
    assert len(places) == 1 and places[0]["place_id"] == "fitrec-synthetic" and "closures" not in places[0]


def test_historical_references_keep_their_own_records():
    gym = main.FACILITIES["CAMPUS_GYM_HISTORICAL_REFERENCE"]
    assert gym.facility_name == "Campus Gym — Historical Reference" and gym.simulation is None
    assert gym.days[gym.default_day][0][0].utcoffset() is not None   # source offsets, not the demo clock
    places = {p["facility_id"] for p in client.get("/api/campus").json()["places"]}
    assert not places & REFERENCES


def test_static_sources_match_the_api():
    static = json.loads((ROOT / "web" / "data" / "sources.json").read_text(encoding="utf-8"))
    assert static == client.get("/api/sources").json() == PROV


def test_a_missing_simulated_slot_is_no_data(tmp_path, monkeypatch):
    rows = [r for r in csv.DictReader(open(gen.OUT_CSV, encoding="utf-8"))
            if not (r["facility_id"] == "SYN_BU_MUGAR_LIBRARY" and r["timestamp"].endswith("T15:00:00"))]
    path = tmp_path / "sim.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["facility_id", "timestamp", "occupancy_count"])
        w.writeheader()
        w.writerows(rows)
    monkeypatch.setattr(sources, "SIMULATION_CSV", path)
    mugar = next(f for f in sources.load_synthetic() if f.facility_id == "mugar-synthetic")
    from analytics import latest_at
    day = mugar.default_day
    assert latest_at(mugar.days[day], mugar.at(day, datetime.min.time().replace(hour=15, minute=5)),
                     mugar.coverage_end(day), mugar.max_hold) is None
    assert latest_at(mugar.days[day], mugar.at(day, datetime.min.time().replace(hour=15, minute=20)),
                     mugar.coverage_end(day), mugar.max_hold) is not None


def test_every_campus_history_covers_its_own_observations():
    """A day ending at midnight must not be reported as ending at 00:00 (the page would show no data all day)."""
    for fid, f in main.FACILITIES.items():
        if not f.campus_eligible:
            continue
        h = client.get(f"/api/facilities/{fid}/history").json()
        assert h["coverage_end"] >= h["observations"][-1]["observed_at"][11:19], fid
        assert h["max_hold_minutes"] == PROV["grid_minutes"]
