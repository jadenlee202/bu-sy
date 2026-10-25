"""ROBOD (library) and NOVANIMAL (canteen sales) imports, and the Mugar and dining simulations.

Fixtures here are small and made up for the test (SYNTHETIC FIXTURE). Nothing downloads.
Run: python -m pytest
"""
import csv
import io
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "data"))

from fastapi.testclient import TestClient  # noqa: E402

import generate_campus_simulation as gen  # noqa: E402
import import_novanimal as nov  # noqa: E402
import import_robod as rob  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
PROV = main.PROVENANCE
SIMS = {s["id"]: s for s in PROV["simulations"]}
SGT = timezone(timedelta(hours=8))


def robod_csv(rows):
    """SYNTHETIC FIXTURE in ROBOD's column layout (a subset of its 35 columns)."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["timestamp", "wifi_connected_devices [number]", "occupant_presence [binary]", "occupant_count [number]"])
    w.writerows(rows)
    out.seek(0)
    return out


def nova_csv(rows):
    """SYNTHETIC FIXTURE in NOVANIMAL's layout (semicolon-separated, a subset of its columns)."""
    head = ["transaction_id", "trans_date", "date", "article_description", "qty_weight", "total_amount", "shop_description"]
    return io.StringIO("\n".join(";".join(map(str, r)) for r in [head, *rows]) + "\n")


# ---------- ROBOD import ----------
def test_robod_timestamps_keep_their_offset():
    t = rob.parse_time("2021-09-07 13:05 +08:00")
    assert t.utcoffset() == timedelta(hours=8) and (t.hour, t.minute) == (13, 5)   # not moved to Boston time
    with pytest.raises(ValueError):
        rob.parse_time("2021-09-07 13:05")                                          # an offset is required


def test_robod_validates_counts_and_keeps_zero_distinct_from_missing():
    records, problems, disagree = rob.parse(robod_csv([
        ["2021-09-13 08:00 +08:00", "7", "0", "0"],      # zero is a reading; Wi-Fi devices are not people
        ["2021-09-13 08:05 +08:00", "3", "1", "2"],
        ["2021-09-13 08:10 +08:00", "3", "1", ""],       # missing
        ["2021-09-13 08:15 +08:00", "3", "1", "NA"],     # missing
        ["2021-09-13 08:20 +08:00", "3", "1", "-1"],     # negative
        ["2021-09-13 08:25 +08:00", "3", "1", "1.5"],    # not a whole number
        ["2021-09-13 08:30 +08:00", "3", "1", "x"],      # not a number
        ["13/09/2021 08:35", "3", "1", "1"],             # unparseable
        ["2021-09-13 08:40 +08:00", "3", "0", "2"],      # presence disagrees with the count
    ]))
    assert [(t.isoformat(), c) for t, c, _ in records] == [
        ("2021-09-13T08:00:00+08:00", 0), ("2021-09-13T08:05:00+08:00", 2), ("2021-09-13T08:40:00+08:00", 2)]
    assert [p[1] for p in problems] == ["missing count", "missing count", "negative count", "count is not a whole number",
                                        "count is not a number", "unparseable timestamp or no offset"]
    assert disagree == 1


def test_robod_duplicate_timestamps_collapse_or_drop():
    t = datetime(2021, 9, 13, 9, 0, tzinfo=SGT)
    kept, identical, conflicting = rob.dedupe([(t, 2, 2), (t, 2, 3), (t + timedelta(minutes=5), 1, 4),
                                               (t + timedelta(minutes=5), 4, 5), (t + timedelta(minutes=10), 3, 6)])
    assert [(x[0].minute, x[1]) for x in kept] == [(0, 2), (10, 3)]
    assert identical == 1 and conflicting[0]["counts"] == [1, 4]      # neither conflicting value is guessed


def test_robod_import_is_deterministic_and_missing_file_exits_cleanly(tmp_path, monkeypatch):
    raw = tmp_path / "room5.csv"
    raw.write_text(robod_csv([["2021-09-13 08:00 +08:00", "1", "1", "1"],
                              ["2021-09-13 08:05 +08:00", "1", "0", "0"]]).getvalue(), encoding="utf-8")
    for name in ("OUT_CSV", "OUT_JSON", "OUT_MD"):
        monkeypatch.setattr(rob, name, tmp_path / name)
    monkeypatch.setattr(rob, "SOURCE_JSON", tmp_path / "none.json")
    rob.run(raw)
    first = [(tmp_path / n).read_bytes() for n in ("OUT_CSV", "OUT_JSON", "OUT_MD")]
    rob.run(raw)
    assert [(tmp_path / n).read_bytes() for n in ("OUT_CSV", "OUT_JSON", "OUT_MD")] == first
    assert first[0].decode().splitlines()[1:] == ["ROBOD_ROOM5_LIBRARY,2021-09-13T08:00:00+08:00,1",
                                                  "ROBOD_ROOM5_LIBRARY,2021-09-13T08:05:00+08:00,0"]
    monkeypatch.setattr(sys, "argv", ["import_robod.py", "--csv", str(tmp_path / "absent.csv")])
    with pytest.raises(SystemExit, match="not found"):
        rob.main()


# ---------- NOVANIMAL import ----------
def test_novanimal_groups_lines_into_purchases_not_people():
    rows, problems = nov.parse(nova_csv([
        [1, "2017-10-02T11:14:07Z", "2017-10-02", "World", 1, 7, "Vista"],
        [1, "2017-10-02T11:14:07Z", "2017-10-02", "Kitchen", 1, 19, "Vista"],          # second article, same purchase
        [2, "2017-10-02T11:20:00Z", "2017-10-02", "Favorite", 1, 14, "Vista"],
        [2, "2017-10-02T11:20:00Z", "2017-10-02", "Favorite", 1, 14, "Vista"],         # identical line, same purchase
        [3, "2017-10-02T11:31:00Z", "2017-10-02", "Favorite", 3, 21, "Vista"],         # three menus, one purchase
        [4, "2017-10-02T11:40:00Z", "2017-10-02", "Hot and Cold", 0.388, 8.9, "Vista"],  # kg, not people
        [5, "2017-10-02T11:41:00Z", "2017-10-02", "Kitchen", -1, -13, "Vista"],        # refund
        [6, "2017-10-02T11:50:00Z", "2017-10-02", "World", 1, 7, "Vista"],
        [6, "2017-10-02T12:10:00Z", "2017-10-02", "World", 1, 7, "Vista"],             # one ID, two clock times
        [1, "2017-10-02T11:16:00Z", "2017-10-02", "World", 1, 7, "Grüental"],          # same ID, other canteen
        [7, "2017-10-03T11:00:00Z", "2017-10-02", "World", 1, 7, "Vista"],             # date disagrees
        [8, "2017-10-02 11:00:00", "2017-10-02", "World", 1, 7, "Vista"],              # not the export format
    ]))
    assert [p[1] for p in problems] == ["date doesn't match trans_date", "unrecognised trans_date"]
    purchases, report = nov.group(rows)
    assert sorted((k[0], k[2]) for k in purchases) == [("Grüental", "1"), ("Vista", "1"), ("Vista", "2"),
                                                       ("Vista", "3"), ("Vista", "4")]
    assert report["repeated_identical_lines"] == 1
    assert [r["transaction_id"] for r in report["refunds_excluded"]] == ["5"]
    assert [r["transaction_id"] for r in report["conflicting_times_dropped"]] == ["6"]
    assert report["transaction_ids_reused_across_canteen_or_date"] == 1
    assert report["purchases_kept"] == 5            # 10 valid lines, 7 menus + 0.388 kg: still 5 purchases


def test_novanimal_wall_clock_is_not_converted():
    rows, _ = nov.parse(nova_csv([[1, "2017-10-02T11:14:07Z", "2017-10-02", "World", 1, 7, "Vista"],
                                  [2, "2017-11-06T11:14:07Z", "2017-11-06", "World", 1, 7, "Vista"]]))
    purchases, _ = nov.group(rows)
    # "Z" is read as the canteen's wall clock on both sides of the summer-time change: 11:14 stays 11:14.
    assert sorted(w.isoformat() for w in purchases.values()) == ["2017-10-02T11:14:07", "2017-11-06T11:14:07"]
    ev = nov.clock_evidence(purchases)
    assert ev["Vista before 2017-10-29"]["median"] == ev["Vista from 2017-10-29"]["median"] == "11:14"


def test_novanimal_intervals_keep_zeros_inside_a_day_and_nothing_outside():
    purchases = {("Vista", "2017-10-02", "1"): datetime(2017, 10, 2, 11, 5),
                 ("Vista", "2017-10-02", "2"): datetime(2017, 10, 2, 11, 14, 59),
                 ("Vista", "2017-10-02", "3"): datetime(2017, 10, 2, 11, 46)}
    assert nov.intervals(purchases) == [("Vista", "2017-10-02T11:00:00", 2), ("Vista", "2017-10-02T11:15:00", 0),
                                        ("Vista", "2017-10-02T11:30:00", 0), ("Vista", "2017-10-02T11:45:00", 1)]


def test_novanimal_missing_file_exits_cleanly(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["import_novanimal.py", "--csv", str(tmp_path / "absent.csv")])
    with pytest.raises(SystemExit, match="not found"):
        nov.main()


def test_generator_names_missing_inputs(tmp_path):
    with pytest.raises(SystemExit, match="absent.csv"):
        gen.require(tmp_path / "absent.csv")


# ---------- Mugar from ROBOD ----------
def test_slot_means_are_time_weighted_and_leave_gaps_empty():
    day = [(datetime(2021, 9, 13, 9, m, tzinfo=SGT), c) for m, c in ((0, 0), (5, 3), (10, 6), (30, 9))]  # SYNTHETIC
    means = gen.slot_means(day, timedelta(minutes=5), 8 * 60, 22 * 60)
    assert means[9 * 60] == pytest.approx(3.0)          # (0 + 3 + 6) / 3, each for 5 minutes
    assert 9 * 60 + 15 not in means                      # 09:15-09:30: no reading within 5 minutes: no data, not 0
    assert means[9 * 60 + 30] == pytest.approx(9.0)      # covered for 5 of 15 minutes: averaged over covered time
    late = [(datetime(2021, 9, 13, 23, 58, tzinfo=SGT), 4)]
    assert gen.slot_means(late, timedelta(minutes=5), 0, 24 * 60) == {23 * 60 + 45: pytest.approx(4.0)}   # stops at midnight


def test_mugar_profile_uses_the_demo_weekday_only():
    mon, tue = date(2021, 9, 13), date(2021, 9, 14)
    days = {d: [(datetime.combine(d, datetime.min.time(), SGT) + timedelta(hours=10, minutes=m), c) for m in (0, 5, 10)]
            for d, c in ((mon, 4), (tue, 50))}      # SYNTHETIC FIXTURE
    days[date(2021, 9, 20)] = [(datetime(2021, 9, 20, 10, m, tzinfo=SGT), 2) for m in (0, 5, 10)]
    profile, used = gen.mugar_profile(days, timedelta(minutes=5), (8, 22))
    assert used == [mon, date(2021, 9, 20)] and profile == {600: pytest.approx(3.0)}
    assert gen.supported_hours(days, 0) == (10, 11)


def test_mugar_output_follows_robod_and_leaves_unsupported_hours_empty():
    sim = SIMS["mugar-from-robod-library"]
    meta, days = gen.load_robod()
    window = tuple(sim["window"])
    profile, _ = gen.mugar_profile(days, timedelta(minutes=meta["gap_policy"]["max_hold_minutes"]), window)
    rows = {t[11:16]: c for fid, t, c in sim_rows() if fid == "SYN_BU_MUGAR_LIBRARY"}
    assert rows == {gen.hhmm(m): round(v * sim["parameters"]["scale"]) for m, v in profile.items()}
    assert sim["parameters"]["scale"] == round(0.75 * 600 / sim["parameters"]["room_typical_high"], 4)
    gap = [p for p in sim["periods"] if p["basis"] == "unavailable"]
    assert gap and not [t for t in rows if gap[0]["start"] <= t < gap[0]["end"]]      # no values, not zeros
    late = client.get("/api/facilities/mugar-synthetic?at=22:30").json()
    assert late["occupancy_count"] is None and late["busyness"] == "unknown"
    assert "Not simulated" in late["busyness_basis"]
    assert sim["parameters"]["mugar_illustrative_capacity"] == 600                     # not the room's maximum


# ---------- dining from NOVANIMAL ----------
def test_diners_are_a_trailing_sum_over_the_dwell_time():
    intervals = {660: 4, 675: 6, 690: 2}                # 11:00, 11:15, 11:30 purchases (SYNTHETIC FIXTURE)
    assert gen.diners(intervals, 675) == 4               # 10:45 (not listed: no purchases) + 11:00
    assert gen.diners(intervals, 690) == 10              # 11:00 + 11:15
    assert gen.diners(intervals, 720) == 2               # 11:30 + 11:45
    assert gen.diners(intervals, 690, dwell=45) == 10    # 10:45 + 11:00 + 11:15
    assert gen.percentile([1, 2, 3, 4, 100], 0.95) == 100 and gen.percentile([5] * 20 + [9], 0.95) == 5


def test_lunch_window_comes_from_the_purchase_quantiles():
    assert gen.lunch_window({"sale_time_quantiles": {"p0.5": "11:13", "p99.5": "13:26"}}) == (660, 810)
    assert gen.lunch_window({"sale_time_quantiles": {"p0.5": "11:00", "p99.5": "13:30"}}) == (660, 810)


def test_dining_periods_are_explicit_and_each_slot_has_one_source():
    sim = SIMS["dining-lunch-from-novanimal"]
    periods = sim["periods"]
    assert [p["basis"] for p in periods] == ["modeled", "reference_dataset", "modeled"]
    assert all(a["end"] == b["start"] for a, b in zip(periods, periods[1:]))       # no gap, no overlap
    assert (periods[0]["start"], periods[-1]["end"]) == ("07:00", "23:00")
    lunch = periods[1]
    meta, days = gen.load_novanimal()
    lo, hi = gen.hhmm_to_min(lunch["start"]), gen.hhmm_to_min(lunch["end"])
    profile, reference, used = gen.dining_profile(days, (lo, hi))
    assert len(used) == sim["parameters"]["source_days"] and all(d.weekday() == 0 for _, d in used)
    assert reference == sim["parameters"]["diners_typical_high"]
    for t in sim["targets"]:
        suffix = next(k for k, v in gen.OTHER_SYNTHETIC.items() if v[0] == t["facility_id"])
        rows = {gen.hhmm_to_min(ts[11:16]): c for fid, ts, c in sim_rows() if fid == f"SYN_BU_{suffix}"}
        assert t["scale"] == round(0.75 * t["capacity"] / reference, 4)
        for m, c in rows.items():
            if lo <= m < hi:
                assert c == round(profile[m] * t["scale"])                       # lunch: dataset-derived
            else:
                knots = gen.BREAKFAST_KNOTS if m < lo else gen.EVENING_KNOTS     # modeled, never lunch evidence
                assert c == round(t["capacity"] * gen.interpolate(knots, m / 60))
        assert set(rows) == set(range(7 * 60, 23 * 60, 15))                      # one value per slot, no doubles
    assert sim["parameters"]["dwell_minutes"] == gen.DWELL_MIN


def test_no_negative_simulated_occupancy_and_complete_mappings():
    assert all(c >= 0 for _, _, c in sim_rows())
    used = {d["id"] for d in PROV["datasets"] if d["status"] == "used"}
    assert used == {"campus-gym", "robod", "novanimal"}
    for f in main.FACILITIES.values():
        if f.campus_eligible:
            assert f.simulation["id"] in SIMS and f.simulation["periods"] == [
                {k: p[k] for k in ("start", "end", "basis", "label")} for p in SIMS[f.simulation["id"]]["periods"]]


def test_static_histories_match_the_api():
    for fid in ("mugar-synthetic", "warren-dining-synthetic", "fenway-dining-synthetic"):
        static = json.loads((ROOT / "web" / "data" / "history" / f"{fid}.json").read_text(encoding="utf-8"))
        assert static == client.get(f"/api/facilities/{fid}/history").json(), fid


def test_reference_records_stay_separate_and_out_of_recommendations():
    ids = {f["facility_id"] for f in client.get("/api/facilities").json()}
    assert not ids & {"ROBOD_ROOM5_LIBRARY", "Grüental", "Vista"}                 # never app destinations
    places = {p["facility_id"] for p in client.get("/api/campus").json()["places"]}
    assert not places & {"COD_Bosch_Office_1_Clemente", "CAMPUS_GYM_HISTORICAL_REFERENCE", "ROBOD_ROOM5_LIBRARY"}
    with open(ROOT / "data" / "clean_novanimal_transactions.csv", encoding="utf-8") as f:
        assert next(csv.reader(f)) == ["source_location", "interval_start", "transaction_count"]   # not occupancy


def sim_rows():
    with open(gen.OUT_CSV, newline="", encoding="utf-8") as f:
        return [(r["facility_id"], r["timestamp"], int(r["occupancy_count"])) for r in csv.DictReader(f)]
