import json
import re
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
HOURS_FILE = ROOT / "web" / "data" / "hours.json"
FACILITIES_FILE = ROOT / "web" / "data" / "facilities.json"
DAYS = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source, object_pairs_hook=unique_object)


def test_hours_cover_every_existing_place_exactly_once():
    facilities = read_json(FACILITIES_FILE)
    hours = read_json(HOURS_FILE)
    expected = {
        facility["facility_id"] for facility in facilities
        if facility["data_mode"] != "historical_playback"
    }
    actual = set(hours["locations"])
    assert expected <= actual
    assert len(actual) == len(hours["locations"])
    assert len({facility["facility_name"] for facility in facilities}) == len(facilities)


def test_hours_entries_have_valid_status_source_and_verification_date():
    hours = read_json(HOURS_FILE)
    assert hours["timezone"] == "America/New_York"
    for facility_id, entry in hours["locations"].items():
        assert entry["sourceUrl"].startswith("https://"), facility_id
        date.fromisoformat(entry["lastVerified"])
        for kind in ("buildingHours", "serviceHours"):
            schedule = entry[kind]
            assert schedule["status"] in {"verified", "unverified", "not_applicable"}, (facility_id, kind)
            if schedule["status"] == "unverified":
                assert schedule.get("unverifiedReason"), (facility_id, kind)
                assert schedule["weeklyHours"] is None, (facility_id, kind)
            elif schedule["status"] == "verified":
                start = date.fromisoformat(schedule["effectiveFrom"])
                end = date.fromisoformat(schedule["effectiveThrough"])
                assert start <= end, (facility_id, kind)
                assert set(schedule["weeklyHours"]) == DAYS, (facility_id, kind)
            else:
                assert schedule["weeklyHours"] is None, (facility_id, kind)


def test_verified_periods_and_special_hours_are_unambiguous():
    hours = read_json(HOURS_FILE)
    for facility_id, entry in hours["locations"].items():
        for kind in ("buildingHours", "serviceHours"):
            schedule = entry[kind]
            if schedule["status"] != "verified":
                continue
            for weekday, periods in schedule["weeklyHours"].items():
                previous_end = -1
                for period in periods:
                    assert period["label"].strip(), (facility_id, kind, weekday)
                    assert TIME.fullmatch(period["start"]), (facility_id, weekday, period)
                    assert TIME.fullmatch(period["end"]), (facility_id, weekday, period)
                    start_hour, start_minute = map(int, period["start"].split(":"))
                    end_hour, end_minute = map(int, period["end"].split(":"))
                    start = start_hour * 60 + start_minute
                    end = end_hour * 60 + end_minute
                    assert start != end, (facility_id, weekday, period)
                    if kind == "buildingHours":
                        assert start >= previous_end, (facility_id, weekday, period)
                        previous_end = end

            special_dates = set()
            for special in schedule["specialHours"]:
                special_date = date.fromisoformat(special["date"])
                assert special_date.isoformat() not in special_dates, (facility_id, kind)
                special_dates.add(special_date.isoformat())
                assert special["status"] in {"open", "closed"}, (facility_id, kind)
                if special["status"] == "closed":
                    assert special["periods"] == [], (facility_id, kind)
                else:
                    assert special["periods"], (facility_id, kind)


def test_dining_building_windows_match_first_and_last_service_periods():
    hours = read_json(HOURS_FILE)
    for facility_id, entry in hours["locations"].items():
        service = entry["serviceHours"]
        building = entry["buildingHours"]
        if service["status"] != "verified" or facility_id == "fitrec-synthetic":
            continue
        assert building["status"] == "verified", facility_id
        assert building["effectiveFrom"] == service["effectiveFrom"], facility_id
        assert building["effectiveThrough"] == service["effectiveThrough"], facility_id
        for weekday, meals in service["weeklyHours"].items():
            building_periods = building["weeklyHours"][weekday]
            if not meals:
                assert building_periods == [], (facility_id, weekday)
                continue
            assert len(building_periods) == 1, (facility_id, weekday)
            assert building_periods[0]["start"] == min(meal["start"] for meal in meals), (facility_id, weekday)
            assert building_periods[0]["end"] == max(meal["end"] for meal in meals), (facility_id, weekday)


@pytest.mark.parametrize("invalid", ["24:00", "12:60", "noon", "7:00"])
def test_time_format_rejects_invalid_values(invalid):
    assert TIME.fullmatch(invalid) is None


def test_mugar_hours_match_facility_details_and_planner_metadata():
    """All exported Mugar hours refer to the same published building schedule."""
    mugar = read_json(HOURS_FILE)["locations"]["mugar-synthetic"]
    facility = next(f for f in read_json(FACILITIES_FILE) if f["facility_id"] == "mugar-synthetic")
    campus = read_json(ROOT / "web" / "data" / "campus.json")
    place = next(p for p in campus["places"] if p["facility_id"] == "mugar-synthetic")
    schedule = mugar["buildingHours"]
    details = facility["verified_info"]
    regular = next(h for h in details["hours"] if h["schedule_kind"] == "regular")
    assert regular["applies_from"] == schedule["effectiveFrom"] == "2026-10-25"
    assert regular["applies_to"] == schedule["effectiveThrough"] == "2026-10-31"
    assert schedule["repeatsWeekly"] is False
    for index, day in enumerate(("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")):
        period, = schedule["weeklyHours"][day]
        expected = f'{period["start"]}-{period["end"]}'
        assert regular["weekly"][str(index)] == expected
        assert facility["opening_hours"]["weekly"][str(index)] == expected
    assert details["hours_source_url"] == place["metadata"]["currentHours"]["url"] == mugar["sourceUrl"]
    assert details["hours_checked"] == mugar["lastVerified"] == "2026-10-25"
    assert place["metadata"]["currentHours"]["effectiveThrough"] == "2026-10-31"
