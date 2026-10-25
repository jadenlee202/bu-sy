"""Manually researched facility metadata, with its own provenance.

This module is DELIBERATELY SEPARATE from occupancy data (sources.py). It holds
hours / access / amenity / walking-time facts that were looked up by hand from
official BU pages. Each fact carries where it came from and when it was checked.

IMPORTANT boundaries (enforced by the shapes here):
  * Verified hours do NOT make synthetic occupancy real. This metadata is joined
    onto a facility by id; it never changes `data_mode`, `measurement_method`,
    `source`, or any occupancy value.
  * Provenance is kept separate per fact-group: hours, amenities, access, and
    walking time each have their own source + checked date.
  * Walking times are hand-estimated, never "verified routing" or "exact".
  * Unknown stays unknown: a facility with no verified entry gets `None`, which
    the API and UI render as "sample / not verified", not as fact.
  * A dining hall is not automatically a study destination. `study_friendly` is
    only true where access + suitability were actually confirmed.

To refresh: re-check the `source_url` for each facility, update the values and
the `checked` date, and note anything unresolved in `open_questions`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# Verification pass metadata (applies to the whole file unless a row overrides).
VERIFICATION_NOTE = (
    "Hours, access and amenities below were read by hand from official bu.edu "
    "pages on the dates noted. They describe published schedules, not live "
    "status, and do not change how occupancy is measured."
)


@dataclass(frozen=True)
class HoursEntry:
    """One schedule for a facility, scoped to a kind and a date range.

    `schedule_kind` distinguishes regular term hours from break / holiday /
    special-event schedules so they are never conflated.
    """
    schedule_kind: str          # "regular" | "holiday" | "semester_break" | "special_event"
    label: str                  # human label, e.g. "Fall 2026 term"
    applies_from: Optional[str] # ISO date the schedule applies from (None = unknown)
    applies_to: Optional[str]   # ISO date it applies to (None = unknown / open-ended)
    # weekly: 0=Mon..6=Sun -> "HH:MM-HH:MM" or "closed" or None (unknown that day)
    weekly: dict[int, Optional[str]] = field(default_factory=dict)
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "schedule_kind": self.schedule_kind,
            "label": self.label,
            "applies_from": self.applies_from,
            "applies_to": self.applies_to,
            "weekly": {str(k): v for k, v in self.weekly.items()},
            "note": self.note,
        }


@dataclass(frozen=True)
class WalkingTime:
    """A hand-estimated walking time. Never exact, never verified routing."""
    from_label: str             # reference point the estimate is anchored to
    minutes_approx: int         # rough minutes on foot
    basis: str                  # how it was estimated

    def as_dict(self) -> dict:
        return {
            "from_label": self.from_label,
            "minutes_approx": self.minutes_approx,
            "basis": self.basis,
            "is_exact": False,          # always false: this is a manual estimate
            "is_verified_routing": False,
        }


@dataclass(frozen=True)
class FacilityInfo:
    """Verified metadata for one facility, with per-group provenance."""
    facility_id: str

    # Hours (own provenance)
    hours: list[HoursEntry] = field(default_factory=list)
    hours_source_url: Optional[str] = None
    hours_checked: Optional[str] = None     # ISO date verification was done

    # Access / eligibility (own provenance)
    access_summary: Optional[str] = None    # who can enter and how
    access_source_url: Optional[str] = None
    access_checked: Optional[str] = None

    # Amenities / supported activities (own provenance)
    amenities_verified: list[str] = field(default_factory=list)
    amenities_source_url: Optional[str] = None
    amenities_checked: Optional[str] = None

    # Study suitability — only true when access + suitability were confirmed.
    study_friendly: Optional[bool] = None   # None = not assessed
    study_note: Optional[str] = None

    # Walking time (hand estimate, never routing)
    walking: Optional[WalkingTime] = None

    # Anything the researcher could not resolve.
    open_questions: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "facility_id": self.facility_id,
            "hours": [h.as_dict() for h in self.hours],
            "hours_source_url": self.hours_source_url,
            "hours_checked": self.hours_checked,
            "access_summary": self.access_summary,
            "access_source_url": self.access_source_url,
            "access_checked": self.access_checked,
            "amenities_verified": list(self.amenities_verified),
            "amenities_source_url": self.amenities_source_url,
            "amenities_checked": self.amenities_checked,
            "study_friendly": self.study_friendly,
            "study_note": self.study_note,
            "walking": self.walking.as_dict() if self.walking else None,
            "open_questions": list(self.open_questions),
            "verification_note": VERIFICATION_NOTE,
        }


# ---------------------------------------------------------------------------
# Verified entries. Checked 2026-10-24 against official bu.edu pages.
# Facility ids here are the SYNTHETIC occupancy ids; attaching verified hours to
# them does NOT make their occupancy real — see module docstring.
# ---------------------------------------------------------------------------

_FITREC = FacilityInfo(
    facility_id="fitrec-synthetic",
    hours=[
        HoursEntry(
            schedule_kind="regular",
            label="Fall 2026 term (Sep 2 - Dec 10, 2026)",
            applies_from="2026-09-02",
            applies_to="2026-12-10",
            weekly={
                0: "06:00-23:00",  # Mon
                1: "06:00-23:00",  # Tue
                2: "06:00-23:00",  # Wed
                3: "06:00-23:00",  # Thu
                4: "06:00-22:00",  # Fri
                5: "08:00-22:00",  # Sat
                6: "08:00-22:00",  # Sun
            },
            note="Building hours; individual areas (pool, courts) may differ.",
        ),
        HoursEntry(
            schedule_kind="holiday",
            label="Indigenous Peoples' Day (Oct 12, 2026)",
            applies_from="2026-10-12",
            applies_to="2026-10-12",
            weekly={0: "08:00-22:00"},
            note="Open with adjusted hours - all facilities.",
        ),
        HoursEntry(
            schedule_kind="holiday",
            label="Thanksgiving closure (Nov 26-28, 2026)",
            applies_from="2026-11-26",
            applies_to="2026-11-28",
            weekly={3: "closed", 4: "closed", 5: "closed"},
            note="Closed Thu-Sat for the Thanksgiving holiday.",
        ),
    ],
    hours_source_url="https://www.bu.edu/fitrec/visit-us/hours/",
    hours_checked="2026-10-24",
    access_summary=(
        "BU ID (Terrier Card) required. Access is included for full-time "
        "students; faculty/staff and others need an eligible membership. "
        "Guests need a day pass and photo ID. Not open to the general public."
    ),
    access_source_url="https://www.bu.edu/fitrec/membership-services/students/",
    access_checked="2026-10-24",
    amenities_verified=[
        "Competition pool (lap swim)",
        "Recreation pool and whirlpool",
        "Indoor track",
        "Cardio and fitness equipment (free and selectorized weights)",
        "Racquetball and squash courts",
        "Climbing wall",
        "Open recreation: pick-up basketball, volleyball, badminton, indoor soccer, pickleball",
        "Locker rooms and equipment checkout",
    ],
    amenities_source_url="https://www.bu.edu/fitrec/about-us/forms-policies/membership-policies",
    amenities_checked="2026-10-24",
    study_friendly=False,
    study_note="A recreation center, not a study space. Not marked study-friendly.",
    walking=WalkingTime(
        from_label="Central Charles River Campus (around the GSU / Marsh Plaza area)",
        minutes_approx=15,
        basis="Hand estimate from the campus map; West Campus sits at the far west end of Comm Ave.",
    ),
    open_questions=[
        "Per-area hours (pool, courts, climbing wall) were not individually verified.",
        "Hours page is labeled 'subject to change'; only the Fall 2026 term block was captured.",
    ],
)

_MUGAR = FacilityInfo(
    facility_id="mugar-synthetic",
    hours=[
        HoursEntry(
            schedule_kind="regular",
            label="Representative term day (as shown on the library page)",
            applies_from=None,
            applies_to=None,
            weekly={
                # Only a single day's posted hours ("Today's Hours 7:00am-11:00pm")
                # was observed. The full weekly table was not captured, so other
                # days are left unknown rather than guessed.
                0: None, 1: None, 2: None, 3: None, 4: None, 5: None, 6: None,
            },
            note=(
                "Observed 'Today's Hours 7:00 AM - 11:00 PM' on the Mugar page. "
                "The full weekly schedule was not captured; treat other days as unknown."
            ),
        ),
        HoursEntry(
            schedule_kind="special_event",
            label="Finals / study period (24-hour operation)",
            applies_from=None,
            applies_to=None,
            weekly={},
            note=(
                "During study days and finals Mugar historically runs a 24-hour "
                "schedule. Exact dates change each semester and were not pinned down."
            ),
        ),
    ],
    hours_source_url="https://www.bu.edu/library/mugar-memorial/about/hours/",
    hours_checked="2026-10-24",
    access_summary=(
        "Open to the BU community; study and collaboration spaces and reservable "
        "study rooms (up to 2 hours/day for BU students, staff, and faculty)."
    ),
    access_source_url="https://www.bu.edu/library/visit-study/",
    access_checked="2026-10-24",
    amenities_verified=[
        "Seven floors of study space (quieter on higher floors)",
        "Private and group study rooms (reservable)",
        "Large computer lounge",
        "Print and online collections; access to databases, journals, ebooks",
    ],
    amenities_source_url="https://www.bu.edu/library/mugar-memorial/research/",
    amenities_checked="2026-10-24",
    study_friendly=True,
    study_note="Primary campus study library with reservable study rooms; study suitability confirmed.",
    walking=WalkingTime(
        from_label="Central Charles River Campus (GSU / Marsh Plaza area)",
        minutes_approx=4,
        basis="Hand estimate; Mugar is at 771 Comm Ave, near the campus center.",
    ),
    open_questions=[
        "Full regular weekly hours table not captured (only a single day's posted hours).",
        "Exact 24-hour finals date ranges vary by semester and were not pinned down.",
    ],
)

# Dining halls: access requires a meal plan / meal swipe, and hours are
# meal-service windows that vary by semester and by location. We verified the
# access model and that these are dining venues, NOT study destinations.
_DINING_ACCESS = (
    "Requires a BU dining plan or a meal swipe/guest swipe. All-you-care-to-eat "
    "residential dining; not free to the general public."
)
_DINING_STUDY_NOTE = (
    "A dining hall, not a study space. Access is gated by a meal swipe and "
    "seating turns over at meal times, so it is not marked study-friendly."
)


def _dining(facility_id: str, source_url: str, walk_from: str, walk_min: int, walk_basis: str) -> FacilityInfo:
    return FacilityInfo(
        facility_id=facility_id,
        hours=[
            HoursEntry(
                schedule_kind="regular",
                label="Meal-service windows vary by semester (not captured here)",
                applies_from=None,
                applies_to=None,
                weekly={0: None, 1: None, 2: None, 3: None, 4: None, 5: None, 6: None},
                note=(
                    "BU dining publishes meal-service windows (breakfast/lunch/dinner) "
                    "that change by semester, break, and location. Specific daily hours "
                    "were not pinned to exact dates, so they are left unknown here."
                ),
            ),
        ],
        hours_source_url=source_url,
        hours_checked="2026-10-24",
        access_summary=_DINING_ACCESS,
        access_source_url="https://www.bu.edu/dining/plans-points/",
        access_checked="2026-10-24",
        amenities_verified=[],   # specific stations not individually verified
        amenities_source_url=source_url,
        amenities_checked="2026-10-24",
        study_friendly=False,
        study_note=_DINING_STUDY_NOTE,
        walking=WalkingTime(from_label=walk_from, minutes_approx=walk_min, basis=walk_basis),
        open_questions=[
            "Exact daily meal-service windows not pinned to dates (they rotate by semester).",
            "Break / holiday / finals dining schedules exist but were not individually captured.",
        ],
    )


_WARREN = _dining(
    "warren-dining-synthetic",
    "https://www.bu.edu/dining/where-to-eat/",
    "Central Charles River Campus (GSU / Marsh Plaza area)", 2,
    "Hand estimate; Warren Towers is central on Comm Ave.",
)
_MARCIANO = _dining(
    "marciano-dining-synthetic",
    "https://www.bu.edu/dining/location/marciano/",
    "Central Charles River Campus (GSU / Marsh Plaza area)", 6,
    "Hand estimate; Marciano Commons (The Towers) is east of the campus center.",
)
_WEST = _dining(
    "west-dining-synthetic",
    "https://www.bu.edu/dining/location/west/",
    "Central Charles River Campus (GSU / Marsh Plaza area)", 14,
    "Hand estimate; West Campus is at the far west end of Comm Ave.",
)
_FENWAY = _dining(
    "fenway-dining-synthetic",
    "https://www.bu.edu/dining/location/fenway/",
    "Central Charles River Campus (GSU / Marsh Plaza area)", 20,
    "Hand estimate; Fenway Campus is across the river, a longer walk or a shuttle ride.",
)


# facility_id -> FacilityInfo. Facilities absent from this map have NO verified
# metadata: callers must treat them as unknown, not as fact.
FACILITY_INFO: dict[str, FacilityInfo] = {
    info.facility_id: info
    for info in (_FITREC, _MUGAR, _WARREN, _MARCIANO, _WEST, _FENWAY)
}


def get_info(facility_id: str) -> Optional[FacilityInfo]:
    """Verified metadata for a facility, or None when nothing was verified."""
    return FACILITY_INFO.get(facility_id)
