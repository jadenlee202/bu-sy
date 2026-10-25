"""Planner data: which campus places support which activity, plus ILLUSTRATIVE
hours, amenities, sample walking times and demo scenarios.

    data/campus_sample.json        places, locations, hours, amenities, scenarios
    data/sample_travel_times.csv   sample walking minutes between locations

This module only loads, validates and normalizes. The recommendation rules
live in one place, web/js/recommend.js, and run on this payload in both API
mode (/api/campus) and static mode (web/data/campus.json). Swap either file
for a verified source (published hours, a routing service) and keep the shape.

Guards: a place must point at a campus-eligible (synthetic) facility that exists. COD
and the campus gym (historical references) can never become campus suggestions.
"""
import csv
import json
import re
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel

from sources import DATA_DIR, Facility

PLACES_JSON = DATA_DIR / "campus_sample.json"
TRAVEL_CSV = DATA_DIR / "sample_travel_times.csv"
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$|^24:00$")

Activity = Literal["study", "eat", "workout"]


class ActivityInfo(BaseModel):
    id: Activity
    label: str
    verb: str
    noun: str
    default_min: int


class Location(BaseModel):
    id: str
    name: str


class Place(BaseModel):
    place_id: str
    name: str
    facility_id: str
    facility_name: str
    location_id: str
    activities: list[Activity]
    data_mode: Literal["synthetic", "live"]   # never historical_playback
    hours: Optional[list[tuple[str, str]]]    # None = unknown
    hours_basis: Literal["illustrative", "verified", "unknown"]
    amenities: dict[str, bool]                # missing key = not listed (unknown)
    amenities_basis: Literal["illustrative", "verified"]
    metadata: dict = {}


class TravelTime(BaseModel):
    from_id: str
    to_id: str
    minutes: int


class Scenario(BaseModel):
    id: str
    label: str
    activity: Activity
    start: str
    minutes: int
    source: Literal["manual", "calendar"] = "manual"
    start_location: str
    next_location: Optional[str]
    min_activity: int
    buffer: int
    prefer_quiet: bool
    prefer_short_travel: bool
    needs: list[str]
    access: dict[str, str] = {}


class Campus(BaseModel):
    label: str
    demo_day: str
    timezone: str
    default_buffer: int
    activities: list[ActivityInfo]
    amenity_labels: dict[str, str]
    locations: list[Location]
    places: list[Place]
    travel_basis: str
    travel_note: str
    travel: list[TravelTime]
    scenarios: list[Scenario]
    notes: list[str]


def _minutes(hhmm: str, where: str) -> int:
    if not HHMM.match(hhmm):
        raise ValueError(f"{where}: {hhmm!r} is not HH:MM (00:00-24:00)")
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _check_intervals(intervals, where: str) -> None:
    last_end = -1
    for start, end in intervals:
        a, b = _minutes(start, where), _minutes(end, where)
        if b <= a or a < last_end:
            raise ValueError(f"{where}: intervals must be increasing and non-overlapping")
        last_end = b


def load_travel(path: Path, location_ids: set[str]) -> list[TravelTime]:
    """Undirected sample walking minutes. A missing pair stays unknown, never 0."""
    seen, rows = set(), []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            a, b, m = r["from_location"].strip(), r["to_location"].strip(), int(r["walk_minutes"])
            if a not in location_ids or b not in location_ids:
                raise ValueError(f"travel: unknown location in {a}->{b}")
            if a == b or m < 0:
                raise ValueError(f"travel: {a}->{b} must join two places with minutes >= 0")
            key = frozenset((a, b))
            if key in seen:
                raise ValueError(f"travel: {a}<->{b} is listed twice")
            seen.add(key)
            rows.append(TravelTime(from_id=a, to_id=b, minutes=m))
    return rows


def load_campus(facilities: dict[str, Facility], places_path: Path = PLACES_JSON,
                travel_path: Path = TRAVEL_CSV) -> Campus:
    raw = json.loads(places_path.read_text(encoding="utf-8"))
    if raw["demo_day"] not in WEEKDAYS:
        raise ValueError(f"demo_day: {raw['demo_day']!r} is not a weekday name")
    locations = [Location(**loc) for loc in raw["locations"]]
    location_ids = {loc.id for loc in locations}
    activities = [ActivityInfo(**a) for a in raw["activities"]]

    places, seen = [], set()
    for p in raw["places"]:
        fid = p["facility_id"]
        f = facilities.get(fid)
        if f is None:
            raise ValueError(f"place: unknown facility {fid}")
        if not f.campus_eligible:
            raise ValueError(f"place: {fid} is {f.data_mode} data, not a campus destination")
        meta = raw["facilities"][fid]
        if meta["location"] not in location_ids:
            raise ValueError(f"place: {fid} has unknown location {meta['location']}")
        if fid in seen:
            raise ValueError(f"place: {fid} is listed twice")
        seen.add(fid)
        hours = meta["hours"]
        if hours is not None:
            _check_intervals(hours, f"hours for {fid}")
        unknown_amenity = set(p.get("amenities", {})) - set(raw["amenity_labels"])
        if unknown_amenity:
            raise ValueError(f"place: {fid} lists unknown amenities {sorted(unknown_amenity)}")
        places.append(Place(
            place_id=fid, name=f.facility_name, facility_id=fid, facility_name=f.facility_name,
            location_id=meta["location"], activities=p["activities"], data_mode=f.data_mode,
            hours=hours, hours_basis="illustrative" if hours is not None else "unknown",
            amenities=p.get("amenities", {}), amenities_basis="illustrative",
            metadata=meta.get("metadata", {}),
        ))

    scenarios = []
    for s in raw["scenarios"]:
        if s["from"] not in location_ids or (s["to"] and s["to"] not in location_ids):
            raise ValueError(f"scenario {s['id']}: unknown location")
        _minutes(s["start"], f"scenario {s['id']}")
        scenarios.append(Scenario(
            start_location=s["from"], next_location=s["to"],
            **{k: v for k, v in s.items() if k not in ("from", "to")},
        ))

    return Campus(
        label=raw["label"], demo_day=raw["demo_day"], timezone="America/New_York",
        default_buffer=raw["default_buffer"], activities=activities,
        amenity_labels=raw["amenity_labels"], locations=locations, places=places,
        travel_basis="Sample walking time",
        travel_note="Illustrative minutes between demo locations, not routed. "
                    "A pair that isn't listed is unknown, not zero.",
        travel=load_travel(travel_path, location_ids),
        scenarios=scenarios,
        notes=[
            "Counts are simulated (FitRec from a non-BU campus gym, Mugar from a library room's counts, dining "
            "lunch from canteen purchases, other dining hours modeled); "
            "capacities, hours and amenities are illustrative. None of it measures BU.",
            "Busyness is read at the selected demo time. It is not a forecast for when you arrive.",
            "Historical references (the COD Clemente Room, the campus gym) are never suggested as campus places.",
        ],
    )
