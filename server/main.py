"""BU-sy API: campus busyness (synthetic) + historical references (COD office room, a non-BU campus gym).

Endpoint shapes follow the shared brief:
    GET  /api/facilities
    GET  /api/facilities/{id}
    GET  /api/facilities/{id}/history
    GET  /api/campus                                   (planner data: places, sample hours + walking times)
    GET  /api/sources                                  (how each campus place is simulated, with citations)
    GET  /api/clubs, /api/clubs/{id}                   (club directory; sample clubs + student-created)
    POST /api/clubs, /{id}/edit, /{id}/apply, /{id}/withdraw
    GET  /api/clubs/{id}/applications                  (organizer token only)
    POST /api/clubs/{id}/applications/{app_id}/decide  (organizer token only)

How it works
    1. sources.py loads data/campus_simulation_occupancy.csv (SIMULATED: one demo
       Monday every 15 min; FitRec as one building driven by a real non-BU campus gym,
       Mugar by a library room in ROBOD, dining by NOVANIMAL canteen sales at lunch with
       other hours modeled; provenance in data/simulation_provenance.json) and
       data/clean_cod_occupancy.csv (REAL office events from COD) and, when
       imported, data/clean_campus_gym_occupancy.csv (REAL counts from a non-BU
       campus gym, about every 10 minutes). Historical references are never
       campus suggestions (`campus_eligible: false`).
    2. Playback: `at` is a time of day replayed on each facility's recorded day.
       The latest observation at or before it is shown; before the first one,
       or after the recorded window, occupancy is unavailable (None), never zero.
    3. Busyness = count / illustrative capacity (synthetic) or count / the
       place's typical high (COD, gym: 95th time-weighted percentile). FitRec is one
       building-level count: no court, pool, room or reservation is tracked.
       Demo thresholds: quiet < 40%, moderate < 75%, busy >= 75%.
    4. Planner ("What fits now?"): /api/campus returns normalized, validated
       planner data (campus.py). The rules that turn a free window into
       suggestions run in web/js/recommend.js, the same code in API and static
       mode, so there is no second copy here to drift.

Setup:  pip install -r requirements.txt
Run:    cd server && uvicorn main:app --reload      then open http://127.0.0.1:8000
Try:    /api/facilities?at=17:30
        /api/facilities/fitrec-synthetic?at=18:00
        /api/facilities/COD_Bosch_Office_1_Clemente/history
        /docs
"""
import logging
import os
from datetime import date, datetime, time
from enum import Enum
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import clubs
from campus import Campus, load_campus
from analytics import THRESHOLD_NOTE, latest_at
from sources import Facility, load_all, load_provenance
from google_calendar import router as calendar_router
from facility_info import get_info


class CalendarCallbackLogFilter(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple):
            record.args = tuple(
                "/api/calendar/callback" if isinstance(value, str) and "/api/calendar/callback" in value else value
                for value in record.args
            )
        return True


logging.getLogger("uvicorn.access").addFilter(CalendarCallbackLogFilter())

app = FastAPI(title="BU-sy API (synthetic campus demo + COD historical playback)")
LOCAL_TZ = ZoneInfo("America/New_York")  # demo clock for "now" when no `at` is given
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
FACILITIES = load_all()
PROVENANCE = load_provenance()
CAMPUS = load_campus(FACILITIES)

def cors_options(origins_env):
    """Lets a site on another origin use this API (`?api=https://host`).

    With the default "*", any origin may read it but no cookies are sent. Credentials
    (the Google Calendar session cookie) are only allowed for the exact origins listed in
    BUSY_CORS_ORIGINS="https://a,https://b"; with "*" Starlette would echo every origin back.
    """
    origins = [origin.strip() for origin in (origins_env or "*").split(",") if origin.strip()] or ["*"]
    return {
        "allow_origins": origins,
        "allow_methods": ["GET", "POST", "DELETE"],
        "allow_headers": ["Content-Type", "X-BUsy-Device"],
        "allow_credentials": "*" not in origins,
    }


app.add_middleware(CORSMiddleware, **cors_options(os.environ.get("BUSY_CORS_ORIGINS")))


@app.middleware("http")
async def prevent_calendar_caching(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/calendar/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


# ---------- models ----------
class Busyness(str, Enum):
    quiet = "quiet"
    moderate = "moderate"
    busy = "busy"
    unknown = "unknown"


class SimulationPeriod(BaseModel):
    start: str                               # HH:MM on the demo clock, [start, end)
    end: str
    basis: Literal["reference_dataset", "modeled", "unavailable"]
    label: str


class SimulationRef(BaseModel):
    id: str                                  # entry in /api/sources
    basis: Literal["reference_dataset", "mixed", "modeled"]   # mixed: a dataset drives some periods, a model the rest
    label: str
    periods: list[SimulationPeriod]          # every slot of the day belongs to exactly one


class FacilitySummary(BaseModel):
    facility_id: str
    facility_name: str
    category: str
    occupancy_count: Optional[int]
    capacity: Optional[int]
    capacity_is_illustrative: bool
    busyness: Busyness
    busyness_basis: str
    measurement_method: Literal["estimated", "measured", "synthetic", "unspecified"]
    data_mode: Literal["historical_playback", "synthetic", "live"]
    campus_eligible: bool             # false: never a planner suggestion
    simulation: Optional[SimulationRef]  # how a campus place's values were simulated; None = recorded data
    source: str
    observed_at: Optional[datetime]   # source local time; keeps a supplied UTC offset, else naive
    timezone: Optional[str]
    time_note: str
    playback_at: Optional[datetime]
    opening_hours: Optional[dict]
    amenities: list[str]
    # Manually researched hours/access/amenities/walking time with their OWN
    # provenance (see facility_info.py). None when nothing was verified. This is
    # kept separate from occupancy: verified hours never make occupancy real.
    verified_info: Optional[dict] = None


class Observation(BaseModel):
    observed_at: datetime
    occupancy_count: int
    busyness: Busyness


class HourBucket(BaseModel):
    hour: int                    # clock hour, 13 = 1-2 PM
    occupancy: Optional[float]   # time-weighted mean; None = no coverage
    busyness: Busyness


class TypicalHour(BaseModel):
    hour: int
    occupancy: Optional[float]   # None = too little recorded time for this weekday-hour
    recorded_hours: float        # how much recorded time the value is based on
    busyness: Busyness


class WeekdayProfile(BaseModel):
    weekday: int                 # 0 = Monday, source local clock
    label: str
    days: int
    hours: list[TypicalHour]


class DayHistory(BaseModel):
    facility_id: str
    day: date
    day_label: str
    timezone: Optional[str]
    time_note: str
    coverage_start: time
    coverage_end: time
    capacity: Optional[int]
    busyness_reference: Optional[float]
    busyness_basis: str
    observations: list[Observation]
    hourly: list[HourBucket]
    typical: Optional[list[HourBucket]]   # same-weekday historical average (COD, gym)
    typical_label: Optional[str]
    # Historical references (empty/None for synthetic places)
    notice: Optional[str] = None
    busyness_label: Optional[str] = None
    simulation: Optional[SimulationRef] = None
    source: str = ""
    measurement_note: str = ""
    max_hold_minutes: Optional[int] = None     # a count stands for at most this long (gap policy)
    playback_days: list[date] = []             # recorded days offered for playback (same in static mode)
    typical_week: Optional[list[WeekdayProfile]] = None
    insight_hours: Optional[list[int]] = None  # [start, end) hours the quieter-time insight may use


# ---------- helpers ----------
def get_facility_or_404(facility_id: str) -> Facility:
    if facility_id not in FACILITIES:
        raise HTTPException(status_code=404, detail="Facility not found")
    return FACILITIES[facility_id]


def resolve_time_of_day(at: Optional[str]) -> time:
    """`at` as HH:MM or an ISO datetime (naive = New York). Default: now in New York."""
    if at is None:
        return datetime.now(LOCAL_TZ).time()
    try:
        return time.fromisoformat(at)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(at)
    except ValueError:
        raise HTTPException(status_code=422, detail="`at` must be HH:MM or an ISO datetime")
    return (dt.astimezone(LOCAL_TZ) if dt.tzinfo else dt).time()


def day_label(f: Facility, day: date) -> str:
    if f.data_mode == "synthetic":
        return f"Sample {day:%A}"
    return f"{day:%a, %b} {day.day}, {day.year}"


def basis_text(f: Facility, count: Optional[int], tod: time) -> str:
    if count is None:
        if f.simulation:
            hhmm = f"{tod:%H:%M}"
            gap = next((p for p in f.simulation["periods"]
                        if p["basis"] == "unavailable" and p["start"] <= hhmm < p["end"]), None)
            if gap:
                return f"No simulated value for this time. {gap['label']}"
            start, end = f.window
            return f"No simulated value for this time (simulated {start}:00-{end}:00 only)"
        if f.max_hold:
            return (f"No data for this time: no recording in the previous "
                    f"{f.max_hold.total_seconds() / 60:.0f} minutes on this day")
        start, end = f.window
        return f"No data for this time (recorded {start}:00-{end}:00 only)"
    pct = f.ratio(count)
    if f.simulation:   # which part of the simulation this value comes from (dataset-derived or modeled)
        hhmm = f"{tod:%H:%M}"
        period = next((p for p in f.simulation["periods"] if p["start"] <= hhmm < p["end"]), None)
        if period:
            return (f"{period['label']}: {count:,} of illustrative capacity {f.capacity:,} ({pct:.0%}); "
                    f"{f.reference_note}; {THRESHOLD_NOTE}")
    if not f.show_percent:
        return f"{count:,} people; {f.reference_note}; {THRESHOLD_NOTE}"
    if f.capacity:
        return (f"{count:,} of illustrative capacity {f.capacity:,} ({pct:.0%}); "
                f"{f.reference_note}; {THRESHOLD_NOTE}")
    return f"{count:,} people ({pct:.0%} of typical high); {f.reference_note}; {THRESHOLD_NOTE}"


def opening_hours_summary(info) -> Optional[dict]:
    """A compact regular-hours view derived from verified metadata.

    Returns None when no regular schedule was verified, so unknown stays unknown.
    """
    if info is None:
        return None
    regular = next((h for h in info.hours if h.schedule_kind == "regular"), None)
    if regular is None or not any(regular.weekly.values()):
        return None
    return {
        "label": regular.label,
        "weekly": {str(k): v for k, v in regular.weekly.items()},
        "source_url": info.hours_source_url,
        "checked": info.hours_checked,
        "note": "Published regular hours; verified by hand, subject to change.",
    }


def facility_fields(f: Facility, tod: time) -> dict:
    day = f.default_day
    playback_at = f.at(day, tod)
    obs = latest_at(f.days[day], playback_at, f.coverage_end(day), f.max_hold)
    count = obs[1] if obs else None
    info = get_info(f.facility_id)
    return dict(
        facility_id=f.facility_id,
        facility_name=f.facility_name,
        category=f.category,
        occupancy_count=count,
        capacity=f.capacity,
        capacity_is_illustrative=f.capacity is not None,
        busyness=f.level(count),
        busyness_basis=basis_text(f, count, tod),
        measurement_method=f.measurement_method,
        data_mode=f.data_mode,
        campus_eligible=f.campus_eligible,
        simulation=f.simulation,
        source=f.source,
        observed_at=obs[0] if obs else None,
        timezone=f.timezone,
        time_note=f.time_note,
        playback_at=playback_at,
        opening_hours=opening_hours_summary(info),
        amenities=f.amenities,
        verified_info=info.as_dict() if info else None,
    )


def buckets(f: Facility, values: list[Optional[float]]) -> list[HourBucket]:
    return [
        HourBucket(hour=f.window[0] + i, occupancy=v, busyness=f.level(v))
        for i, v in enumerate(values)
    ]


WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def typical_label(f: Facility, weekday: int) -> str:
    name = WEEKDAYS[weekday]
    label = f"Typical {name}: mean of {f.typical_days[weekday]} recorded {name}s"
    return f"{label} ({f.typical_basis})" if f.typical_basis else label


def typical_week(f: Facility) -> Optional[list[WeekdayProfile]]:
    if not f.typical_hours:
        return None
    return [
        WeekdayProfile(
            weekday=wd, label=WEEKDAYS[wd], days=f.typical_days[wd],
            hours=[
                TypicalHour(hour=f.window[0] + i, occupancy=v, recorded_hours=f.typical_hours[wd][i], busyness=f.level(v))
                for i, v in enumerate(f.typical_by_weekday[wd])
            ],
        )
        for wd in sorted(f.typical_by_weekday)
    ]


# ---------- endpoints ----------
@app.get("/api/facilities", response_model=list[FacilitySummary])
def list_facilities(at: Optional[str] = Query(None, description="HH:MM or ISO datetime")):
    tod = resolve_time_of_day(at)
    return [FacilitySummary(**facility_fields(f, tod)) for f in FACILITIES.values()]


@app.get("/api/facilities/{facility_id}", response_model=FacilitySummary)
def get_facility(facility_id: str, at: Optional[str] = Query(None, description="HH:MM or ISO datetime")):
    f = get_facility_or_404(facility_id)
    return FacilitySummary(**facility_fields(f, resolve_time_of_day(at)))


@app.get("/api/facilities/{facility_id}/history", response_model=DayHistory)
def get_history(facility_id: str, on: Optional[date] = Query(None, alias="date")):
    """One recorded day: every observation, plus time-weighted hourly means.

    Defaults to the facility's playback day. COD and the campus gym accept any
    recorded day here; the app offers `playback_days`, which static mode exports too.
    """
    f = get_facility_or_404(facility_id)
    day = on or f.default_day
    if day not in f.days:
        raise HTTPException(status_code=404, detail="No recorded data for that date")
    typical = f.typical_by_weekday.get(day.weekday())
    return DayHistory(
        facility_id=f.facility_id,
        day=day,
        day_label=day_label(f, day),
        timezone=f.timezone,
        time_note=f.time_note,
        coverage_start=f.coverage_start(day),
        coverage_end=f.coverage_end(day).time(),
        capacity=f.capacity,
        busyness_reference=f.reference,
        busyness_basis=f"{f.reference_note}; {THRESHOLD_NOTE}",
        observations=[
            Observation(observed_at=t, occupancy_count=c, busyness=f.level(c))
            for t, c in f.days[day]
        ],
        hourly=buckets(f, f.hourly(day)),
        typical=buckets(f, typical) if typical else None,
        typical_label=typical_label(f, day.weekday()) if typical else None,
        notice=f.notice,
        busyness_label=f.busyness_label,
        simulation=f.simulation,
        source=f.source,
        measurement_note=f.measurement_note,
        max_hold_minutes=int(f.max_hold.total_seconds() // 60) if f.max_hold else None,
        playback_days=f.playback_days,
        typical_week=typical_week(f),
        insight_hours=list(f.insight_hours) if f.insight_hours else None,
    )


@app.get("/api/campus", response_model=Campus)
def get_campus():
    """Planner data for web/js/recommend.js. Everything here is illustrative demo data."""
    return CAMPUS


@app.get("/api/sources")
def get_sources():
    """Datasets, dataset-to-place mappings, transformations and limits behind the simulated campus places."""
    return PROVENANCE


# ---------- club directory (sample clubs + student-created; demo-grade organizer gating) ----------
@app.get("/api/clubs")
def list_clubs(device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    return clubs.list_clubs(device, FACILITIES)


@app.get("/api/clubs/{club_id}")
def get_club(club_id: str, device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    return clubs.get_club(club_id, device, FACILITIES)


@app.post("/api/clubs", status_code=201)
def create_club(body: clubs.ClubFields):
    return clubs.create_club(body, FACILITIES)


@app.post("/api/clubs/{club_id}/edit")
def edit_club(club_id: str, body: clubs.ClubFields):
    return clubs.edit_club(club_id, body, FACILITIES)


@app.post("/api/clubs/{club_id}/apply")
def apply_to_club(club_id: str, body: clubs.Application):
    return clubs.apply(club_id, body, FACILITIES)


@app.post("/api/clubs/{club_id}/withdraw")
def withdraw_from_club(club_id: str, body: clubs.TokenRequest):
    return clubs.withdraw(club_id, body, FACILITIES)


@app.get("/api/clubs/{club_id}/applications")
def club_applications(club_id: str, device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    """Organizer only. The token comes in a header, never the URL."""
    return clubs.applications(club_id, device)


@app.post("/api/clubs/{club_id}/applications/{app_id}/decide")
def decide_application(club_id: str, app_id: str, body: clubs.Decision):
    return clubs.decide(club_id, app_id, body, FACILITIES)


# ---------- club directory (sample clubs + student-created; demo-grade organizer gating) ----------
@app.get("/api/clubs")
def list_clubs(device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    return clubs.list_clubs(device, FACILITIES)


@app.get("/api/clubs/{club_id}")
def get_club(club_id: str, device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    return clubs.get_club(club_id, device, FACILITIES)


@app.post("/api/clubs", status_code=201)
def create_club(body: clubs.ClubFields):
    return clubs.create_club(body, FACILITIES)


@app.post("/api/clubs/{club_id}/edit")
def edit_club(club_id: str, body: clubs.ClubFields):
    return clubs.edit_club(club_id, body, FACILITIES)


@app.post("/api/clubs/{club_id}/apply")
def apply_to_club(club_id: str, body: clubs.Application):
    return clubs.apply(club_id, body, FACILITIES)


@app.post("/api/clubs/{club_id}/withdraw")
def withdraw_from_club(club_id: str, body: clubs.TokenRequest):
    return clubs.withdraw(club_id, body, FACILITIES)


@app.get("/api/clubs/{club_id}/applications")
def club_applications(club_id: str, device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    """Organizer only. The token comes in a header, never the URL."""
    return clubs.applications(club_id, device)


@app.post("/api/clubs/{club_id}/applications/{app_id}/decide")
def decide_application(club_id: str, app_id: str, body: clubs.Decision):
    return clubs.decide(club_id, app_id, body, FACILITIES)


# The web app, served from the same origin so it finds /api automatically.
app.include_router(calendar_router)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
