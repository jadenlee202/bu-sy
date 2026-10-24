"""Data adapter: loads the two CSVs in data/ into facilities with day series.

Replace this module (keep the Facility shape) to plug in a real campus feed.

    bu_campus_synthetic_occupancy.csv   SYNTHETIC, one sample Monday, hourly,
                                        FitRec by area + dining + Mugar
    clean_cod_occupancy.csv             REAL office occupancy events (COD),
                                        made by data/clean_cod.py

Synthetic timestamps use an explicit America/New_York demo clock. COD
timestamps are source-local with an unverified timezone, so they stay naive and
are never converted.
"""
import csv
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Optional

from analytics import Series, classify, hourly_time_weighted, time_weighted_percentile

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SYNTHETIC_CSV = DATA_DIR / "bu_campus_synthetic_occupancy.csv"
COD_CSV = DATA_DIR / "clean_cod_occupancy.csv"

COD_ID = "COD_Bosch_Office_1_Clemente"
COD_PLAYBACK_DAY = date(2015, 11, 9)  # a Monday with a clear midday dip
COD_WINDOW = (7, 20)                  # every recorded day is anchored at 07:00 and 20:00
COD_REFERENCE_PERCENTILE = 0.95
SYNTHETIC_WINDOW = (8, 23)            # hourly rows 08:00-22:00, each holding one hour


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
    measurement_method: str     # synthetic | estimated
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

    def coverage_end(self, day: date) -> datetime:
        return datetime.combine(day, time()) + timedelta(hours=self.window[1])

    def ratio(self, count: Optional[float]) -> Optional[float]:
        base = self.capacity or self.reference
        return None if count is None or not base else count / base

    def level(self, count: Optional[float]) -> str:
        return classify(self.ratio(count))

    def hourly(self, day: date) -> list[Optional[float]]:
        return hourly_time_weighted(self.days[day], *self.window, self.coverage_end(day))


# ---------- synthetic campus data ----------
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
SYNTHETIC_SOURCE = "Synthetic demo data (data/bu_campus_synthetic_occupancy.csv); not a BU measurement"
SYNTHETIC_TIME_NOTE = "Sample Monday on an America/New_York demo clock"


def _synthetic_facility(facility_id, name, category, capacity=None, **extra) -> Facility:
    return Facility(
        facility_id=facility_id, facility_name=name, category=category,
        data_mode="synthetic", measurement_method="synthetic", source=SYNTHETIC_SOURCE,
        timezone="America/New_York", time_note=SYNTHETIC_TIME_NOTE, window=SYNTHETIC_WINDOW,
        capacity=capacity, **extra,
    )


def load_synthetic() -> list[Facility]:
    rows = defaultdict(list)
    with open(SYNTHETIC_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows[r["facility_id"]].append((datetime.fromisoformat(r["timestamp"]), int(r["occupancy_count"])))

    areas = []
    for suffix, (area_id, name, cat, cap, tol) in FITREC_AREAS.items():
        areas.append(Area(area_id, name, cat, cap, tol, sorted(rows[f"SYN_BU_FITREC_{suffix}"])))
    totals = defaultdict(int)
    for a in areas:
        for t, c in a.series:
            totals[t] += c
    fitrec = _synthetic_facility(
        "fitrec-synthetic", "FitRec", "fitness",
        capacity=sum(a.capacity for a in areas),
        reference_note="Sum of 21 areas vs. the sum of their illustrative capacities",
        amenities=FITREC_AMENITIES, areas=areas,
    )
    fitrec.days[min(totals).date()] = sorted(totals.items())

    facilities = [fitrec]
    for suffix, (fid, name, cat, cap) in OTHER_SYNTHETIC.items():
        f = _synthetic_facility(fid, name, cat, capacity=cap,
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


def load_all() -> dict[str, Facility]:
    facilities = load_synthetic()
    cod = load_cod()
    if cod:
        facilities.insert(1, cod)
    return {f.facility_id: f for f in facilities}
