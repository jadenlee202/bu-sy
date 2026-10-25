"""BU-sy API: campus busyness (synthetic) + historical references (COD office room, a non-BU campus gym).

Endpoint shapes follow the shared brief:
    GET  /api/facilities
    GET  /api/facilities/{id}
    GET  /api/facilities/{id}/history
    GET  /api/campus                                   (planner data: places, sample hours + walking times)
    GET  /api/schedule, /api/programs                  (sample official schedule)
    GET  /api/community-events                         (unofficial, student-run)
    POST /api/community-events, /{id}/join, /{id}/leave, /{id}/cancel

How it works
    1. sources.py loads data/bu_campus_synthetic_occupancy.csv (SYNTHETIC: one
       sample Monday, hourly, FitRec by area + dining + Mugar) and
       data/clean_cod_occupancy.csv (REAL office events from COD) and, when
       imported, data/clean_campus_gym_occupancy.csv (REAL counts from a non-BU
       campus gym, about every 10 minutes). Historical references are never
       campus suggestions (`campus_eligible: false`).
    2. Playback: `at` is a time of day replayed on each facility's recorded day.
       The latest observation at or before it is shown; before the first one,
       or after the recorded window, occupancy is unavailable (None), never zero.
    3. Busyness = count / illustrative capacity (synthetic) or count / the
       place's typical high (COD, gym: 95th time-weighted percentile). FitRec weight
       rooms and basketball courts divide by a crowd tolerance of 1.25.
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

import community_events as ce
from campus import Campus, load_campus
from analytics import THRESHOLD_NOTE, latest_at
from schedule_data import CLUB_SPORTS, INTRAMURALS, SCHEDULE
from sources import Facility, load_all
from google_calendar import router as calendar_router


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


class EventType(str, Enum):
    club_sport = "club_sport"
    intramural = "intramural"
    class_ = "class"


class Event(BaseModel):
    id: str
    title: str
    type: EventType
    area_ids: list[str]
    day_of_week: int  # 0 = Monday
    start: time
    end: time
    source: str = "sample"


class AreaEstimate(BaseModel):
    area_id: str
    name: str
    category: str
    estimate_basis: Literal["synthetic_csv"]
    crowd_tolerance: float     # > 1: people accept a bigger crowd here
    estimated_occupancy: Optional[int]
    capacity: int              # illustrative
    busyness: Busyness
    busyness_basis: str
    status: Literal["open", "reserved"]
    current_event: Optional[Event]


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
    source: str
    observed_at: Optional[datetime]   # source local time; keeps a supplied UTC offset, else naive
    timezone: Optional[str]
    time_note: str
    playback_at: Optional[datetime]
    opening_hours: Optional[dict]
    amenities: list[str]


class FacilityDetail(FacilitySummary):
    areas: list[AreaEstimate]  # FitRec only; empty when occupancy is unavailable


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


class AreaHistory(BaseModel):
    area_id: str
    name: str
    category: str
    capacity: int
    crowd_tolerance: float
    observations: list[Observation]


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
    areas: list[AreaHistory]
    # Historical references (empty/None for synthetic places)
    notice: Optional[str] = None
    busyness_label: Optional[str] = None
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


def basis_text(f: Facility, count: Optional[int]) -> str:
    if count is None:
        if f.max_hold:
            return (f"No data for this time: no recording in the previous "
                    f"{f.max_hold.total_seconds() / 60:.0f} minutes on this day")
        start, end = f.window
        return f"No data for this time (recorded {start}:00-{end}:00 only)"
    pct = f.ratio(count)
    if not f.show_percent:
        return f"{count:,} people; {f.reference_note}; {THRESHOLD_NOTE}"
    if f.capacity:
        return (f"{count:,} of illustrative capacity {f.capacity:,} ({pct:.0%}); "
                f"{f.reference_note}; {THRESHOLD_NOTE}")
    return f"{count:,} people ({pct:.0%} of typical high); {f.reference_note}; {THRESHOLD_NOTE}"


def active_event(area_id: str, when: datetime) -> Optional[Event]:
    for e in SCHEDULE:
        if (
            area_id in e["area_ids"]
            and e["day_of_week"] == when.weekday()
            and e["start"] <= when.time() < e["end"]
        ):
            return Event(**e)
    return None


def facility_fields(f: Facility, tod: time) -> dict:
    day = f.default_day
    playback_at = f.at(day, tod)
    obs = latest_at(f.days[day], playback_at, f.coverage_end(day), f.max_hold)
    count = obs[1] if obs else None
    return dict(
        facility_id=f.facility_id,
        facility_name=f.facility_name,
        category=f.category,
        occupancy_count=count,
        capacity=f.capacity,
        capacity_is_illustrative=f.capacity is not None,
        busyness=f.level(count),
        busyness_basis=basis_text(f, count),
        measurement_method=f.measurement_method,
        data_mode=f.data_mode,
        campus_eligible=f.campus_eligible,
        source=f.source,
        observed_at=obs[0] if obs else None,
        timezone=f.timezone,
        time_note=f.time_note,
        playback_at=playback_at,
        opening_hours=None,
        amenities=f.amenities,
    )


def build_areas(f: Facility, playback_at: datetime) -> list[AreaEstimate]:
    end = f.coverage_end(playback_at.date())
    areas = []
    for a in f.areas:
        obs = latest_at(a.series, playback_at, end)
        occ = obs[1] if obs else None
        event = active_event(a.area_id, playback_at)
        ratio = occ / a.capacity if occ is not None else None
        areas.append(AreaEstimate(
            area_id=a.area_id,
            name=a.name,
            category=a.category,
            estimate_basis="synthetic_csv",
            crowd_tolerance=a.crowd_tolerance,
            estimated_occupancy=occ,
            capacity=a.capacity,
            busyness=a.level(occ) if occ is not None else Busyness.unknown,
            busyness_basis=(
                "No data for this time" if occ is None else
                f"Synthetic: {occ:,} of illustrative capacity {a.capacity:,} ({ratio:.0%})"
                + (f", crowd tolerance x{a.crowd_tolerance}" if a.crowd_tolerance != 1.0 else "")
                + f"; {THRESHOLD_NOTE}"
            ),
            status="reserved" if event else "open",
            current_event=event,
        ))
    return areas


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


@app.get("/api/facilities/{facility_id}", response_model=FacilityDetail)
def get_facility(facility_id: str, at: Optional[str] = Query(None, description="HH:MM or ISO datetime")):
    f = get_facility_or_404(facility_id)
    fields = facility_fields(f, resolve_time_of_day(at))
    areas = build_areas(f, fields["playback_at"]) if fields["occupancy_count"] is not None else []
    return FacilityDetail(**fields, areas=areas)


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
        areas=[
            AreaHistory(
                area_id=a.area_id, name=a.name, category=a.category,
                capacity=a.capacity, crowd_tolerance=a.crowd_tolerance,
                observations=[
                    Observation(observed_at=t, occupancy_count=c, busyness=a.level(c))
                    for t, c in a.series
                ],
            )
            for a in f.areas
        ],
        notice=f.notice,
        busyness_label=f.busyness_label,
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


@app.get("/api/schedule", response_model=list[Event])
def get_schedule(
    area_id: Optional[str] = None,
    event_type: Optional[EventType] = Query(None, alias="type"),
    day: Optional[int] = Query(None, ge=0, le=6, description="0 = Monday"),
):
    events = SCHEDULE
    if area_id:
        events = [e for e in events if area_id in e["area_ids"]]
    if event_type:
        events = [e for e in events if e["type"] == event_type.value]
    if day is not None:
        events = [e for e in events if e["day_of_week"] == day]
    return [Event(**e) for e in events]


@app.get("/api/programs")
def get_programs():
    return {"club_sports": CLUB_SPORTS, "intramurals": INTRAMURALS}


# ---------- community events (unofficial) ----------
@app.get("/api/community-events")
def list_community_events(device: Optional[str] = Header(None, alias="X-BUsy-Device")):
    """The device token comes in a header, not the URL, so it stays out of access logs."""
    return ce.list_events(device)


@app.post("/api/community-events", status_code=201)
def create_community_event(body: ce.NewEvent):
    return ce.create_event(body)


@app.post("/api/community-events/{event_id}/join")
def join_community_event(event_id: str, body: ce.JoinRequest):
    return ce.join_event(event_id, body)


@app.post("/api/community-events/{event_id}/leave")
def leave_community_event(event_id: str, body: ce.TokenRequest):
    return ce.leave_event(event_id, body)


@app.post("/api/community-events/{event_id}/cancel", status_code=204)
def cancel_community_event(event_id: str, body: ce.TokenRequest):
    ce.cancel_event(event_id, body)


# The web app, served from the same origin so it finds /api automatically.
app.include_router(calendar_router)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
