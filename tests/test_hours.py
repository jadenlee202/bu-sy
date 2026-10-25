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
    expected = {facility["facility_id"] for facility in facilities}
    actual = set(hours["locations"])
    assert actual == expected
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


def test_meal_periods_are_never_used_as_unverified_building_hours():
    hours = read_json(HOURS_FILE)
    for facility_id, entry in hours["locations"].items():
        service = entry["serviceHours"]
        building = entry["buildingHours"]
        if service["status"] == "verified" and facility_id != "fitrec-synthetic":
            assert building["status"] == "unverified", facility_id
            assert building["weeklyHours"] is None, facility_id


@pytest.mark.parametrize("invalid", ["24:00", "12:60", "noon", "7:00"])
def test_time_format_rejects_invalid_values(invalid):
    assert TIME.fullmatch(invalid) is None
