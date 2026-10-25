"""Campus gym historical reference: import, loader, playback rules and API.

Every fixture here is small and made up for the test (marked SYNTHETIC FIXTURE);
nothing depends on Kaggle or on the real file being present.
Run: python -m pytest
"""
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "data"))

from fastapi.testclient import TestClient  # noqa: E402

import campus  # noqa: E402
import import_campus_gym as gym_import  # noqa: E402
import main  # noqa: E402
import sources  # noqa: E402
from analytics import hourly_time_weighted, latest_at, time_weighted_percentile  # noqa: E402

client = TestClient(main.app)
GYM = sources.GYM_ID
HEADER = ",".join(gym_import.EXPECTED)


def row(count, when, hour=None, day_of_week=None):
    """One source row with consistent derived fields unless overridden. SYNTHETIC FIXTURE."""
    dt = datetime.fromisoformat(when)
    secs = dt.hour * 3600 + dt.minute * 60 + dt.second
    dow = dt.weekday() if day_of_week is None else day_of_week
    return (f"{count},{when},{secs},{dow},{int(dt.weekday() >= 5)},0,60.0,0,1,{dt.month},"
            f"{dt.hour if hour is None else hour}")


# ---------- import script ----------
FIXTURE = [
    row(10, "2016-02-01 09:00:00-08:00"),
    row(0, "2016-02-01 09:10:00-08:00"),             # zero is a real count
    row(12, "2016-02-01 09:30:00-08:00"),
    row(11, "2016-02-01 09:20:00-08:00"),             # out of order in the file
    row("", "2016-02-01 09:40:00-08:00"),             # missing, not zero
    row(-3, "2016-02-01 09:50:00-08:00"),             # negative
    row("4.5", "2016-02-01 10:00:00-08:00"),          # not a whole number
    "7,2016-02-01 10:10:00,36600,0,0,0,60.0,0,1,2,10",  # no UTC offset
    "7,yesterday,0,0,0,0,60.0,0,1,2,10",               # unparseable
    row(9, "2016-02-01 10:20:00-08:00"),
    row(9, "2016-02-01 10:20:00-08:00"),              # identical duplicate
    row(5, "2016-02-01 10:30:00-08:00"),
    row(6, "2016-02-01 10:30:00-08:00"),              # conflicting duplicate
    row(8, "2016-04-04 10:00:00-07:00", hour=11),     # supplied hour disagrees with date
]


def parsed():
    records, problems, mismatches, flags = gym_import.parse(io_lines(FIXTURE))
    return records, problems, mismatches, flags


def io_lines(rows):
    return [HEADER + "\n"] + [r + "\n" for r in rows]


def test_import_reports_bad_rows_and_keeps_zero_distinct_from_missing():
    records, problems, mismatches, _ = parsed()
    reasons = sorted(p[1] for p in problems)
    assert reasons == ["count is not a whole number", "date has no UTC offset", "missing count",
                       "negative count", "unparseable date"]
    assert any(c == 0 for _, c, _ in records)                        # zero kept
    assert all(t.tzinfo is not None for t, _, _ in records)
    assert mismatches == {"hour": 1}                                  # reported; `date` wins


def test_import_preserves_offsets_and_sorts_by_instant():
    records, *_ = parsed()
    kept, identical, conflicting = gym_import.dedupe(records)
    assert identical == 1
    assert conflicting == [("2016-02-01T10:30:00-08:00", [5, 6], [13, 14])]
    times = [t for t, _, _ in kept]
    assert times == sorted(times)
    assert [t.isoformat() for t in times][:4] == [
        "2016-02-01T09:00:00-08:00", "2016-02-01T09:10:00-08:00",
        "2016-02-01T09:20:00-08:00", "2016-02-01T09:30:00-08:00"]
    assert times[-1].isoformat() == "2016-04-04T10:00:00-07:00"      # not converted to another zone


def test_timestamp_column_is_seconds_since_local_midnight_not_epoch():
    records, _, mismatches, _ = gym_import.parse(io_lines([row(3, "2016-02-01 17:00:11-08:00")]))
    assert "timestamp" not in mismatches
    assert records[0][0] == datetime.fromisoformat("2016-02-01T17:00:11-08:00")


def test_import_rejects_an_unexpected_schema():
    with pytest.raises(ValueError, match="Unexpected columns"):
        gym_import.parse(["people,when\n", "1,2016-02-01 09:00:00-08:00\n"])


def test_import_is_reproducible(tmp_path, monkeypatch):
    raw = tmp_path / "data.csv"
    raw.write_text("\n".join([HEADER] + FIXTURE) + "\n", encoding="utf-8")
    for name in ("OUT_CSV", "OUT_JSON", "OUT_MD"):
        monkeypatch.setattr(gym_import, name, tmp_path / getattr(gym_import, name).name)
    monkeypatch.setattr(gym_import, "SOURCE_JSON", tmp_path / "SOURCE.json")
    monkeypatch.setattr(sys, "argv", ["import", "--csv", str(raw)])
    outputs = [gym_import.OUT_CSV, gym_import.OUT_JSON, gym_import.OUT_MD]
    gym_import.main()
    first = [p.read_bytes() for p in outputs]
    gym_import.main()
    assert [p.read_bytes() for p in outputs] == first
    summary = json.loads(gym_import.OUT_JSON.read_text(encoding="utf-8"))
    # 14 rows - 5 rejected - 1 identical duplicate - 2 conflicting duplicates
    assert summary["rows_kept"] == 6 and summary["count_min"] == 0 and summary["zero_rows"] == 1
    assert summary["rows_in_file"] == len(FIXTURE)
    assert summary["gap_policy"]["max_hold_minutes"] == 30
    assert gym_import.OUT_CSV.read_text(encoding="utf-8").splitlines()[1] == f"{GYM},2016-02-01T09:00:00-08:00,10"


def test_import_explains_a_missing_source(tmp_path, monkeypatch):
    monkeypatch.setattr(gym_import, "RAW_CSV", tmp_path / "absent.csv")
    monkeypatch.setattr(sys, "argv", ["import"])
    with pytest.raises(SystemExit, match="--download"):
        gym_import.main()


# ---------- gap rule (shared analytics) ----------
def tz(s):
    return datetime.fromisoformat(f"2016-02-01T{s}-08:00")


SAMPLED = [(tz("09:00:00"), 10), (tz("09:10:00"), 0), (tz("09:20:00"), 20), (tz("11:00:00"), 30)]  # SYNTHETIC
HOLD = timedelta(minutes=30)
END = tz("11:30:00")


def test_playback_boundaries_with_the_gap_rule():
    assert latest_at(SAMPLED, tz("08:59:59"), END, HOLD) is None             # before the first reading
    assert latest_at(SAMPLED, tz("09:15:00"), END, HOLD)[1] == 0             # zero is a value
    assert latest_at(SAMPLED, tz("09:50:00"), END, HOLD)[1] == 20            # within 30 min
    assert latest_at(SAMPLED, tz("09:50:01"), END, HOLD) is None             # gap: no data, not 20, not 0
    assert latest_at(SAMPLED, tz("11:00:00"), END, HOLD)[1] == 30
    assert latest_at(SAMPLED, tz("11:30:01"), END, HOLD) is None             # recording ended
    assert latest_at(SAMPLED, tz("09:50:01"), END)[1] == 20                  # without a rule (COD): held


def test_gaps_are_missing_time_not_zero_in_hourly_means():
    hours = hourly_time_weighted(SAMPLED, 8, 12, END, HOLD)
    assert hours[0] is None                                   # 8-9 AM: nothing recorded
    assert hours[1] == pytest.approx((10 * 10 + 0 * 10 + 20 * 30) / 50, abs=0.01)  # only 50 covered minutes
    assert hours[2] is None                                   # 10-11 AM: inside the gap
    assert hours[3] == 30


def test_reference_is_a_time_weighted_percentile_not_the_peak():
    spike = [(tz("09:00:00"), 5), (tz("09:10:00"), 5), (tz("09:20:00"), 5), (tz("09:30:00"), 140), (tz("09:31:00"), 5)]
    assert time_weighted_percentile([(spike, tz("09:41:00"))], 0.95, HOLD) == 5


# ---------- loader ----------
def write_fixture(tmp_path, rows, playback_days):
    """Clean-CSV + import-JSON pair in the importer's output format. SYNTHETIC FIXTURE."""
    csv_path, meta_path = tmp_path / "gym.csv", tmp_path / "gym.json"
    csv_path.write_text("facility_id,timestamp,occupancy_count\n"
                        + "".join(f"{GYM},{t},{c}\n" for t, c in rows), encoding="utf-8")
    meta_path.write_text(json.dumps({
        "gap_policy": {"max_hold_minutes": 30}, "playback_days": playback_days,
        "source": {"title": "Synthetic fixture", "creator": "tests", "license": "n/a"},
    }), encoding="utf-8")
    return csv_path, meta_path


def fixture_gym(tmp_path):
    rows = [(f"2016-02-0{d}T{h:02d}:00:00-08:00", c) for d in (1, 2) for h, c in ((8, 4), (9, 8), (10, 6))]
    rows += [("2016-03-13T01:30:00-08:00", 3), ("2016-03-13T03:30:00-07:00", 3)]   # offset change: excluded
    return sources.load_campus_gym(*write_fixture(tmp_path, rows, ["2016-02-01", "2016-02-02", "2016-01-01"]))


def test_loader_keeps_offsets_and_no_campus_attributes(tmp_path):
    g = fixture_gym(tmp_path)
    assert g.facility_id == GYM and g.facility_name == "Campus Gym — Historical Reference"
    assert (g.category, g.data_mode, g.capacity, g.timezone) == ("fitness", "historical_playback", None, None)
    assert not g.campus_eligible and g.amenities == []
    assert g.measurement_method == "unspecified"
    assert g.days[date(2016, 2, 1)][0][0].utcoffset() == timedelta(hours=-8)
    assert date(2016, 3, 13) not in g.days                       # offset change day left out
    assert g.playback_days == [date(2016, 2, 1), date(2016, 2, 2)]  # unknown days dropped
    assert g.coverage_end(date(2016, 2, 1)) == tz("10:30:00")    # last reading + 30 min
    assert g.at(date(2016, 2, 1), datetime.min.time().replace(hour=9)).utcoffset() == timedelta(hours=-8)


def test_loader_typical_and_reference(tmp_path):
    g = fixture_gym(tmp_path)
    assert g.reference is not None and g.reference <= 8
    monday = g.typical_by_weekday[0]
    assert monday[7] is None                                       # never recorded: blank, not zero
    assert g.typical_hours[0][8] == 0.5                            # 30 min recorded per reading


def test_app_works_without_the_dataset(tmp_path, monkeypatch):
    assert sources.load_campus_gym(tmp_path / "absent.csv", tmp_path / "absent.json") is None
    monkeypatch.setattr(sources, "GYM_CSV", tmp_path / "absent.csv")
    monkeypatch.setattr(sources.load_campus_gym, "__defaults__", (tmp_path / "absent.csv", tmp_path / "absent.json"))
    facilities = sources.load_all()
    assert GYM not in facilities and "COD_Bosch_Office_1_Clemente" in facilities
    campus.load_campus(facilities)                                  # planner data still loads


# ---------- API (uses the committed derived file; skipped if it was removed) ----------
needs_gym = pytest.mark.skipif(GYM not in main.FACILITIES, reason="campus gym not imported")


@needs_gym
def test_api_lists_the_gym_as_a_historical_reference():
    rows = {f["facility_id"]: f for f in client.get("/api/facilities?at=17:30").json()}
    g = rows[GYM]
    assert g["campus_eligible"] is False and g["data_mode"] == "historical_playback"
    assert g["capacity"] is None and not g["capacity_is_illustrative"]
    assert g["measurement_method"] == "unspecified"
    assert g["observed_at"].endswith(("-08:00", "-07:00"))       # supplied offset kept
    assert "% of" not in g["busyness_basis"] and "historical traffic" in g["busyness_basis"]
    assert all(f["campus_eligible"] for i, f in rows.items() if i not in (GYM, "COD_Bosch_Office_1_Clemente"))


@needs_gym
def test_api_history_offers_playback_days_and_labels():
    h = client.get(f"/api/facilities/{GYM}/history").json()
    assert h["notice"] == "Historical gym data — not live and not BU FitRec."
    assert h["busyness_label"] == "Relative to this gym's historical traffic"
    assert h["capacity"] is None and h["max_hold_minutes"] == 30
    assert h["day"] == h["playback_days"][0] and len(h["playback_days"]) == 7
    assert h["typical"] and len(h["typical_week"]) == 7 and h["insight_hours"] == [6, 23]
    other = client.get(f"/api/facilities/{GYM}/history?date={h['playback_days'][3]}").json()
    assert other["day"] == h["playback_days"][3]
    assert client.get(f"/api/facilities/{GYM}/history?date=2016-03-13").status_code == 404  # offset change


@needs_gym
def test_gym_is_never_a_campus_suggestion(tmp_path):
    assert GYM not in {p["facility_id"] for p in client.get("/api/campus").json()["places"]}
    raw = json.loads(campus.PLACES_JSON.read_text(encoding="utf-8"))
    raw["facilities"][GYM] = {"location": "fitrec", "hours": [["06:00", "24:00"]]}
    raw["places"].append({"facility_id": GYM, "activities": ["workout"]})
    path = tmp_path / "campus.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="not a campus destination"):
        campus.load_campus(main.FACILITIES, path)


@needs_gym
def test_static_export_has_exactly_the_playback_days():
    folder = main.WEB_DIR / "data" / "history" / GYM
    days = client.get(f"/api/facilities/{GYM}/history").json()["playback_days"]
    assert sorted(p.stem for p in folder.glob("*.json")) == sorted(days)
    for d in days:
        assert json.loads((folder / f"{d}.json").read_text(encoding="utf-8")) == \
            client.get(f"/api/facilities/{GYM}/history?date={d}").json()
