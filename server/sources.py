"""Data adapter: loads the CSVs in data/ into facilities with day series.

Replace this module (keep the Facility shape) to plug in a real campus feed.

    campus_simulation_occupancy.csv     SIMULATED campus places on one demo Monday,
                                        every 15 min: FitRec by area (driven by a
                                        real non-BU campus gym), dining + Mugar
                                        (modeled), made by data/generate_campus_simulation.py;
                                        simulation_provenance.json says how
    clean_cod_occupancy.csv             REAL office occupancy events (COD),
                                        made by data/clean_cod.py
    clean_campus_gym_occupancy.csv      REAL counts from a non-BU campus gym
                                        (Kaggle, ODbL), made by
                                        data/import_campus_gym.py; optional

Simulated timestamps use an explicit America/New_York demo clock. COD
timestamps are source-local with an unverified timezone, so they stay naive and
are never converted. Campus-gym timestamps keep their supplied UTC offset (no
named timezone is assigned); weekday and hour come from that local clock.

Only synthetic facilities can become campus suggestions (`campus_eligible`).
Historical references are for playback and comparison only.
"""
import csv
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Optional

from analytics import Series, classify, hour_sums, hourly_time_weighted, time_weighted_percentile

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SIMULATION_CSV = DATA_DIR / "campus_simulation_occupancy.csv"
PROVENANCE_JSON = DATA_DIR / "simulation_provenance.json"
COD_CSV = DATA_DIR / "clean_cod_occupancy.csv"

COD_ID = "COD_Bosch_Office_1_Clemente"
COD_PLAYBACK_DAY = date(2015, 11, 9)  # a Monday with a clear midday dip
COD_WINDOW = (7, 20)                  # every recorded day is anchored at 07:00 and 20:00
COD_REFERENCE_PERCENTILE = 0.95

GYM_CSV = DATA_DIR / "clean_campus_gym_occupancy.csv"
GYM_IMPORT_JSON = DATA_DIR / "campus_gym_import.json"
GYM_ID = "CAMPUS_GYM_HISTORICAL_REFERENCE"
GYM_REFERENCE_PERCENTILE = 0.95
GYM_MIN_TYPICAL_HOURS = 5.0           # a weekday-hour needs this much recorded time to get a typical value
GYM_INSIGHT_HOURS = (6, 23)           # quieter-time insight: daytime only (opening hours are unknown)
GYM_NOTICE = "Historical gym data — not live and not BU FitRec."


@dataclass
class Area:
    area_id: str
    name: str
    category: str
    capacity: int               # illustrative
    crowd_tolerance: float = 1.0
    series: Series = field(default_factory=list)

    def level(self, count: int) -> str:
        return classify(count / self.capacity, self.crowd_tolerance)


@dataclass
class Facility:
    facility_id: str
    facility_name: str
    category: str
    data_mode: str              # synthetic | historical_playback
    measurement_method: str     # synthetic | estimated | unspecified
    source: str
    timezone: Optional[str]
    time_note: str
    window: tuple[int, int]     # coverage hours [start, end)
    capacity: Optional[int] = None
    reference: Optional[float] = None
    reference_note: str = ""
    amenities: list[str] = field(default_factory=list)
    areas: list[Area] = field(default_factory=list)
    days: dict[date, Series] = field(default_factory=dict)
    default_day: Optional[date] = None
    typical_by_weekday: dict[int, list[Optional[float]]] = field(default_factory=dict)
    typical_days: dict[int, int] = field(default_factory=dict)  # weekday -> days averaged
    # Historical references with sampled data (campus gym); unused elsewhere.
    max_hold: Optional[timedelta] = None                  # gap policy, see analytics.py
    day_bounds: dict[date, tuple[datetime, datetime]] = field(default_factory=dict)
    playback_days: list[date] = field(default_factory=list)
    typical_hours: dict[int, list[float]] = field(default_factory=dict)  # weekday -> recorded hours per hour
    typical_basis: str = ""
    insight_hours: Optional[tuple[int, int]] = None
    show_percent: bool = True        # % of the typical high in the busyness text (never % full)
    notice: Optional[str] = None
    measurement_note: str = ""
    busyness_label: Optional[str] = None   # short line shown under the busyness word
    simulation: Optional[dict] = None      # {id, basis, label} for simulated campus places

    @property
    def campus_eligible(self) -> bool:
        """Only synthetic campus facilities may be suggested by the planner."""
        return self.data_mode == "synthetic"

    def coverage_end(self, day: date) -> datetime:
        if day in self.day_bounds:
            return self.day_bounds[day][1]
        end = datetime.combine(day, time()) + timedelta(hours=self.window[1])
        # A window ending at midnight ends at 23:59:59, so it stays on the same day (and in a `time` field).
        return end - timedelta(seconds=1) if self.window[1] == 24 else end

    def coverage_start(self, day: date) -> time:
        return self.day_bounds[day][0].time() if day in self.day_bounds else time(self.window[0])

    def at(self, day: date, tod: time) -> datetime:
        """`tod` on `day`, on the same clock as that day's observations (keeps a supplied offset)."""
        series = self.days.get(day)
        return datetime.combine(day, tod, series[0][0].tzinfo if series else None)

    def ratio(self, count: Optional[float]) -> Optional[float]:
        base = self.capacity or self.reference
        return None if count is None or not base else count / base

    def level(self, count: Optional[float]) -> str:
        return classify(self.ratio(count))

    def hourly(self, day: date) -> list[Optional[float]]:
        return hourly_time_weighted(self.days[day], *self.window, self.coverage_end(day), self.max_hold)


# ---------- simulated campus places ----------
# Illustrative capacities only (not official figures). Weight rooms and
# basketball courts get a crowd tolerance: people accept a bigger crowd there.
TOLERANT = 1.25
FITREC_AREAS = {
    "WEIGHT_ROOM_FLOOR_1": ("weight-room-floor-1", "Weight Room · Floor 1", "weights", 160, TOLERANT),
    "WEIGHT_ROOM_FLOOR_2": ("weight-room-floor-2", "Weight Room · Floor 2", "weights", 140, TOLERANT),
    "BASKETBALL_4_COURT_FLOOR_2": ("basketball-court-floor-2", "Basketball · Floor 2 (4 courts)", "basketball", 60, TOLERANT),
    "BASKETBALL_3_COURT_BASEMENT": ("basketball-court-basement", "Basketball · Basement (3 courts)", "basketball", 45, TOLERANT),
    "COMPETITION_POOL": ("competition-pool", "Competition Pool", "aquatics", 50, 1.0),
    "RECREATION_POOL_HOT_TUB": ("recreation-pool-hot-tub", "Rec Pool & Hot Tub", "aquatics", 45, 1.0),
    "BIKING_AREA": ("biking-area", "Biking Area", "cardio", 35, 1.0),
    "SQUASH_COURT_1": ("squash-court-1", "Squash Court 1", "racquet", 4, 1.0),
    "SQUASH_COURT_2": ("squash-court-2", "Squash Court 2", "racquet", 4, 1.0),
    "RACQUETBALL_ROOM_1": ("racquetball-room-1", "Racquetball 1", "racquet", 4, 1.0),
    "RACQUETBALL_ROOM_2": ("racquetball-room-2", "Racquetball 2", "racquet", 4, 1.0),
    "RACQUETBALL_ROOM_3": ("racquetball-room-3", "Racquetball 3", "racquet", 4, 1.0),
    "CLIMBING_WALL": ("climbing-wall", "Climbing Wall", "climbing", 30, 1.0),
    **{
        f"MULTIPURPOSE_ROOM_{n}": (f"multipurpose-room-{n}", f"Multipurpose Room {n}", "multipurpose", 35, 1.0)
        for n in range(1, 8)
    },
    "DANCE_THEATRE": ("dance-theatre", "Dance Theatre", "dance", 40, 1.0),
}
FITREC_AMENITIES = [
    "Weight rooms (2 floors)", "Basketball courts (7)", "Competition pool",
    "Rec pool and hot tub", "Biking area", "Squash (2)", "Racquetball (3)",
    "Climbing wall", "Multipurpose rooms (7)", "Dance theatre",
]
# csv suffix -> (facility_id, name, category, illustrative capacity)
OTHER_SYNTHETIC = {
    "DINING_WARREN_TOWERS": ("warren-dining-synthetic", "Warren Towers Dining", "dining", 400),
    "DINING_MARCIANO_COMMONS": ("marciano-dining-synthetic", "Marciano Commons", "dining", 400),
    "DINING_WEST_CAMPUS": ("west-dining-synthetic", "West Campus Dining", "dining", 400),
    "DINING_FENWAY": ("fenway-dining-synthetic", "Fenway Dining", "dining", 200),
    "MUGAR_LIBRARY": ("mugar-synthetic", "Mugar Library", "library", 600),
}
SIMULATED_TIME_NOTE = "Simulated Monday on an America/New_York demo clock"


def load_provenance(path: Path = PROVENANCE_JSON) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _simulation_for(provenance: dict, facility_id: str) -> dict:
    sim = next(s for s in provenance["simulations"] if any(t["facility_id"] == facility_id for t in s["targets"]))
    dataset = next((d for d in provenance["datasets"] if d["id"] == sim["dataset_id"]), None)
    return {"sim": sim, "dataset": dataset}


def _simulated_facility(facility_id, name, category, provenance, capacity=None, **extra) -> Facility:
    found = _simulation_for(provenance, facility_id)
    sim, dataset = found["sim"], found["dataset"]
    source = (f"Simulated from {dataset['title']} ({dataset['creators']}, {dataset['license']}): "
              f"{dataset['original_location']}. Not a BU measurement" if dataset
              else "Modeled profile (no dataset). Not a BU measurement")
    return Facility(
        facility_id=facility_id, facility_name=name, category=category,
        data_mode="synthetic", measurement_method="synthetic", source=source,
        timezone="America/New_York", time_note=SIMULATED_TIME_NOTE, window=tuple(sim["window"]),
        capacity=capacity, max_hold=timedelta(minutes=provenance["grid_minutes"]),
        simulation={"id": sim["id"], "basis": sim["basis"], "label": sim["label"]}, **extra,
    )


def load_synthetic() -> list[Facility]:
    """The simulated campus places. Each value stands for one 15-minute slot (max_hold), so a
    slot the simulation left empty (a gap in its source) shows as no data, never as the last value."""
    provenance = load_provenance()
    rows = defaultdict(list)
    with open(SIMULATION_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows[r["facility_id"]].append((datetime.fromisoformat(r["timestamp"]), int(r["occupancy_count"])))

    areas = []
    for suffix, (area_id, name, cat, cap, tol) in FITREC_AREAS.items():
        areas.append(Area(area_id, name, cat, cap, tol, sorted(rows[f"SYN_BU_FITREC_{suffix}"])))
    totals = defaultdict(int)
    for a in areas:
        for t, c in a.series:
            totals[t] += c
    fitrec = _simulated_facility(
        "fitrec-synthetic", "FitRec", "fitness", provenance,
        capacity=sum(a.capacity for a in areas),
        reference_note="Sum of 21 areas vs. the sum of their illustrative capacities",
        amenities=FITREC_AMENITIES, areas=areas,
    )
    fitrec.days[min(totals).date()] = sorted(totals.items())

    facilities = [fitrec]
    for suffix, (fid, name, cat, cap) in OTHER_SYNTHETIC.items():
        f = _simulated_facility(fid, name, cat, provenance, capacity=cap,
                                reference_note=f"Count vs. an illustrative capacity of {cap:,}")
        series = sorted(rows[f"SYN_BU_{suffix}"])
        f.days[series[0][0].date()] = series
        facilities.append(f)

    for f in facilities:
        f.default_day = min(f.days)
    return facilities


# ---------- real historical data (COD) ----------
def load_cod() -> Optional[Facility]:
    """None when data/clean_cod_occupancy.csv has not been generated yet."""
    if not COD_CSV.exists():
        return None
    days = defaultdict(list)
    with open(COD_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t = datetime.fromisoformat(r["timestamp"])
            days[t.date()].append((t, int(r["occupancy_count"])))  # file is already sorted

    cod = Facility(
        facility_id=COD_ID, facility_name="Clemente Room — COD demo", category="office",
        data_mode="historical_playback", measurement_method="estimated",
        source="COD: Liu et al., Commercial Building Occupancy Traces, Zenodo 2017, "
               "doi:10.5281/zenodo.996587 (office conference room, not BU)",
        timezone=None, time_note="Source local time; timezone unverified",
        window=COD_WINDOW, days=dict(days),
        default_day=COD_PLAYBACK_DAY if COD_PLAYBACK_DAY in days else min(days),
        busyness_label="Relative to this room's historical traffic",
    )
    cod.reference = time_weighted_percentile(
        [(s, cod.coverage_end(d)) for d, s in days.items()], COD_REFERENCE_PERCENTILE)
    cod.reference_note = (
        f"Relative to this room's typical high of {cod.reference} people: the "
        f"{COD_REFERENCE_PERCENTILE:.0%} time-weighted percentile of {len(days)} recorded "
        "weekdays, 7 AM-8 PM. Not capacity."
    )

    # Typical profile per weekday: every recorded day covers the full window,
    # so a plain mean of each day's time-weighted hourly values is fair.
    by_weekday = defaultdict(list)
    for d in days:
        by_weekday[d.weekday()].append(cod.hourly(d))
    for wd, profiles in by_weekday.items():
        cod.typical_by_weekday[wd] = [
            round(sum(p[i] for p in profiles) / len(profiles), 2) for i in range(len(profiles[0]))
        ]
        cod.typical_days[wd] = len(profiles)
    return cod


# ---------- real historical data (campus gym, not BU) ----------
def load_campus_gym(csv_path: Path = GYM_CSV, import_json: Path = GYM_IMPORT_JSON) -> Optional[Facility]:
    """None when data/import_campus_gym.py hasn't been run (the app works without it)."""
    if not csv_path.exists() or not import_json.exists():
        return None
    meta = json.loads(import_json.read_text(encoding="utf-8"))
    hold = timedelta(minutes=meta["gap_policy"]["max_hold_minutes"])
    by_day = defaultdict(list)
    with open(csv_path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t = datetime.fromisoformat(r["timestamp"])          # keeps the supplied offset
            by_day[t.date()].append((t, int(r["occupancy_count"])))
    # On a day whose offset changes, a wall-clock hour repeats or is skipped, so
    # weekday/hour can't be read reliably: those days are left out (documented).
    days = {d: sorted(s) for d, s in by_day.items() if len({t.utcoffset() for t, _ in s}) == 1}
    if not days:
        return None
    src = meta["source"]
    gym = Facility(
        facility_id=GYM_ID, facility_name="Campus Gym — Historical Reference", category="fitness",
        data_mode="historical_playback", measurement_method="unspecified",
        source=f"{src['title']} by {src['creator']}, Kaggle; ODbL 1.0 (database), DbCL 1.0 (contents). "
               "A non-BU university gym, 2015-2017; not BU FitRec",
        timezone=None,
        time_note="Source local time with its supplied UTC offset; named timezone not verified",
        window=(0, 24), days=days, max_hold=hold, notice=GYM_NOTICE, show_percent=False,
        insight_hours=GYM_INSIGHT_HOURS, busyness_label="Relative to this gym's historical traffic",
        measurement_note="Counts recorded by the dataset author about every 10 minutes; collection method not documented.",
    )
    for d, s in days.items():
        midnight = datetime.combine(d + timedelta(days=1), time(), s[0][0].tzinfo)
        gym.day_bounds[d] = (s[0][0], min(s[-1][0] + hold, midnight - timedelta(seconds=1)))
    gym.playback_days = [d for d in map(date.fromisoformat, meta["playback_days"]) if d in days]
    gym.default_day = gym.playback_days[0] if gym.playback_days else max(days)

    gym.reference = time_weighted_percentile(
        [(s, gym.coverage_end(d)) for d, s in days.items()], GYM_REFERENCE_PERCENTILE, hold)
    gym.reference_note = (
        f"Relative to this gym's historical traffic: its typical high is {gym.reference} people, the "
        f"{GYM_REFERENCE_PERCENTILE:.0%} time-weighted percentile of {len(days)} recorded days. "
        "Capacity unknown, so this is not how full it is"
    )

    # Typical weekday x hour: total count-seconds / total covered seconds across all
    # recorded days, so partial days and gaps count only for the time they cover.
    sums = defaultdict(lambda: [[0.0, 0.0] for _ in range(24)])
    for d, s in days.items():
        for h, (w, c) in enumerate(hour_sums(s, 0, 24, gym.coverage_end(d), hold)):
            sums[d.weekday()][h][0] += w
            sums[d.weekday()][h][1] += c
        gym.typical_days[d.weekday()] = gym.typical_days.get(d.weekday(), 0) + 1
    for wd, hours in sums.items():
        gym.typical_by_weekday[wd] = [
            round(w / c, 2) if c / 3600 >= GYM_MIN_TYPICAL_HOURS else None for w, c in hours]
        gym.typical_hours[wd] = [round(c / 3600, 1) for _, c in hours]
    first, last = min(days), max(days)
    gym.typical_basis = (
        f"time-weighted over {first:%b %Y}-{last:%b %Y}, semesters and breaks together; "
        f"hours with under {GYM_MIN_TYPICAL_HOURS:g} h of recordings are left blank"
    )
    return gym


def load_all() -> dict[str, Facility]:
    facilities = load_synthetic()
    for loader in (load_cod, load_campus_gym):
        f = loader()
        if f:
            facilities.append(f)
    # Campus places first, then historical references.
    return {f.facility_id: f for f in facilities}
