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
        assert entry["verificationStatus"] in {"verified", "unverified"}, facility_id
        assert entry["sourceUrl"].startswith("https://"), facility_id
        date.fromisoformat(entry["lastVerified"])
        if entry["verificationStatus"] == "unverified":
            assert entry.get("unverifiedReason"), facility_id
            assert entry["weeklyHours"] is None
        else:
            start = date.fromisoformat(entry["effectiveFrom"])
            end = date.fromisoformat(entry["effectiveThrough"])
            assert start <= end, facility_id
            assert set(entry["weeklyHours"]) == DAYS, facility_id


def test_verified_periods_and_special_hours_are_unambiguous():
    hours = read_json(HOURS_FILE)
    for facility_id, entry in hours["locations"].items():
        if entry["verificationStatus"] != "verified":
            continue
        for weekday, periods in entry["weeklyHours"].items():
            previous_end = -1
            for period in periods:
                assert period["label"].strip(), (facility_id, weekday)
                assert TIME.fullmatch(period["start"]), (facility_id, weekday, period)
                assert TIME.fullmatch(period["end"]), (facility_id, weekday, period)
                start_hour, start_minute = map(int, period["start"].split(":"))
                end_hour, end_minute = map(int, period["end"].split(":"))
                start = start_hour * 60 + start_minute
                end = end_hour * 60 + end_minute
                assert start != end, (facility_id, weekday, period)
                assert start >= previous_end, (facility_id, weekday, period)
                previous_end = end

        special_dates = set()
        for special in entry["specialHours"]:
            special_date = date.fromisoformat(special["date"])
            assert special_date.isoformat() not in special_dates, facility_id
            special_dates.add(special_date.isoformat())
            assert special["status"] in {"open", "closed"}, facility_id
            if special["status"] == "closed":
                assert special["periods"] == [], facility_id
            else:
                assert special["periods"], facility_id


@pytest.mark.parametrize("invalid", ["24:00", "12:60", "noon", "7:00"])
def test_time_format_rejects_invalid_values(invalid):
    assert TIME.fullmatch(invalid) is None
