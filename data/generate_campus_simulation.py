"""Generate BU-sy's simulated campus occupancy and its provenance.

The campus places (FitRec as one building, four dining halls, Mugar Library) are
BU-named *simulations*. Nothing here measures BU. Each simulation is one of:

  reference_dataset  driven by real observations from somewhere else, transformed
                     by the documented steps below (FitRec: a campus gym; Mugar: a
                     library room in ROBOD)
  mixed              a dataset drives one documented period and an explicit model the
                     rest (dining: lunch from NOVANIMAL canteen sales, breakfast and
                     dinner modeled)
  modeled            no suitable dataset; an explicit profile with no dataset citation

Every simulation lists its periods (start, end, basis). Each 15-minute slot belongs to
exactly one period, so curves are never blended or counted twice at a boundary. A period
marked "unavailable" has no values at all: the app shows "no data" there.

Inputs (all local; nothing is downloaded here):
    clean_campus_gym_occupancy.csv, campus_gym_import.json        from import_campus_gym.py
    clean_robod_library_occupancy.csv, robod_import.json          from import_robod.py
    clean_novanimal_transactions.csv, novanimal_import.json       from import_novanimal.py
    campus_sample.json                                            illustrative opening hours
    server/sources.py                                             illustrative capacities
Outputs:
    campus_simulation_occupancy.csv   facility_id,timestamp,occupancy_count on the demo clock
    simulation_provenance.json        every target, source, period, transformation, parameter, limit
                                      (served at /api/sources and web/data/sources.json)

Run:    python data/generate_campus_simulation.py
Deterministic: the same inputs always give byte-identical outputs.
"""
import csv
import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
from sources import FITREC_CAPACITY, FITREC_SERIES, OTHER_SYNTHETIC  # noqa: E402  (illustrative capacities live there)

GYM_CSV = HERE / "clean_campus_gym_occupancy.csv"
GYM_IMPORT = HERE / "campus_gym_import.json"
ROBOD_CSV = HERE / "clean_robod_library_occupancy.csv"
ROBOD_IMPORT = HERE / "robod_import.json"
NOVANIMAL_CSV = HERE / "clean_novanimal_transactions.csv"
NOVANIMAL_IMPORT = HERE / "novanimal_import.json"
CAMPUS_JSON = HERE / "campus_sample.json"
OUT_CSV = HERE / "campus_simulation_occupancy.csv"
OUT_JSON = HERE / "simulation_provenance.json"

DEMO_DAY = date(2026, 10, 19)          # the app's sample Monday on its America/New_York demo clock
GRID_MIN = 15                           # one simulated value per 15 minutes
FALLBACK_WINDOW = (7, 23)               # dining hall without sample hours (Fenway): same window as the others
BUSY_SHARE = 0.75                       # a source's typical high becomes this share of illustrative capacity
REFERENCE_PERCENTILE = 0.95             # "typical high" = this percentile of the source's own values

# FitRec from the campus gym (reference dataset)
GYM_SOURCE_DAY = "2016-12-05"           # the gym's default playback Monday, chosen by the import's fixed rule

# Mugar from ROBOD Room 5 (reference dataset)
SOURCE_WEEKDAY = DEMO_DAY.weekday()     # Monday: the demo day's weekday

# Dining lunch from NOVANIMAL (reference dataset for one period)
DWELL_MIN = 30                          # ILLUSTRATIVE: a purchase stands for one diner for 30 minutes
LUNCH_SHARE = 0.995                     # the lunch window holds this central share of all purchases

# Modeled dining periods: (hour, share of illustrative capacity) knots, linearly interpolated.
# They cover only the hours NOVANIMAL doesn't: nothing here is lunch evidence.
BREAKFAST_KNOTS = [(7, 0.05), (8, 0.35), (9, 0.25), (10.5, 0.05), (11, 0.02)]
EVENING_KNOTS = [(14, 0.05), (16.5, 0.10), (18, 0.85), (19.5, 0.55), (21, 0.15), (23, 0.05)]


# ---------- helpers ----------
def demo_time(minute: int) -> str:
    """A minute of the day on the demo clock. A label move, not a timezone conversion."""
    return (datetime.combine(DEMO_DAY, time()) + timedelta(minutes=minute)).isoformat()


def window_for(hours) -> tuple[int, int]:
    if not hours:
        return FALLBACK_WINDOW
    (start, end), = hours
    return int(start[:2]), int(end[:2])


def grid(window) -> list[int]:
    return list(range(window[0] * 60, window[1] * 60, GRID_MIN))


def hhmm(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def hhmm_to_min(text: str) -> int:
    return int(text[:2]) * 60 + int(text[3:5])


def interpolate(knots, hour: float) -> float:
    if hour <= knots[0][0]:
        return knots[0][1]
    for (h0, v0), (h1, v1) in zip(knots, knots[1:]):
        if h0 <= hour <= h1:
            return v0 + (v1 - v0) * (hour - h0) / (h1 - h0)
    return knots[-1][1]


def percentile(values, p: float):
    """Smallest value v with at least p of the values <= v (nearest rank)."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)] if ordered else None


def require(*paths):
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        sys.exit(f"Missing {', '.join(missing)}. Run the importers first: python data/import_campus_gym.py, "
                 "python data/import_robod.py, python data/import_novanimal.py (add --download if data/raw is empty).")


# ---------- reference: the campus gym (FitRec) ----------
def gym_day_profile(rows, hold_min: int, window) -> dict[int, int]:
    """Source count at each grid minute of the source day: the latest reading at or before it,
    if no older than the import's gap policy. Missing stays missing (never zero)."""
    readings = sorted((t.hour * 60 + t.minute + t.second / 60, c) for t, c in rows)
    out = {}
    for m in grid(window):
        before = [(t, c) for t, c in readings if t <= m]
        if before and m - before[-1][0] <= hold_min:
            out[m] = before[-1][1]
    return out


def load_gym():
    meta = json.loads(GYM_IMPORT.read_text(encoding="utf-8"))
    rows = []
    with open(GYM_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["timestamp"].startswith(GYM_SOURCE_DAY):
                rows.append((datetime.fromisoformat(r["timestamp"]), int(r["occupancy_count"])))
    offsets = sorted({t.isoformat()[-6:] for t, _ in rows})
    return meta, rows, offsets


def reference_from_import() -> int:
    """The gym's typical high, recomputed by the server's own rule (95th time-weighted percentile)."""
    from sources import load_campus_gym  # noqa: E402
    gym = load_campus_gym(GYM_CSV, GYM_IMPORT)
    if gym is None:
        sys.exit("Campus gym data not found. Run `python data/import_campus_gym.py` first.")
    return int(gym.reference)


# ---------- reference: ROBOD Room 5 (Mugar) ----------
def load_robod():
    meta = json.loads(ROBOD_IMPORT.read_text(encoding="utf-8"))
    days = defaultdict(list)
    with open(ROBOD_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t = datetime.fromisoformat(r["timestamp"])          # keeps +08:00
            days[t.date()].append((t, int(r["occupancy_count"])))
    return meta, {d: sorted(s) for d, s in sorted(days.items())}


def slot_means(series, hold: timedelta, start_min: int, end_min: int) -> dict[int, float]:
    """Time-weighted mean count in each 15-minute slot [m, m + 15) of one local day. A reading
    holds until the next one, for at most `hold`, never past local midnight. A slot with no
    covered time is left out (no data), never zero."""
    day0 = series[0][0].replace(hour=0, minute=0, second=0)
    ends = [t for t, _ in series[1:]] + [day0 + timedelta(days=1)]
    sums = defaultdict(lambda: [0.0, 0.0])
    for (t, c), nxt in zip(series, ends):
        a = (t - day0).total_seconds() / 60
        b = min((nxt - day0).total_seconds() / 60, a + hold.total_seconds() / 60, 24 * 60)
        m = int(a // GRID_MIN) * GRID_MIN
        while m < b:
            lo, hi = max(a, m), min(b, m + GRID_MIN)
            if hi > lo and start_min <= m < end_min:
                sums[m][0] += c * (hi - lo)
                sums[m][1] += hi - lo
            m += GRID_MIN
    return {m: w / s for m, (w, s) in sums.items() if s}


def supported_hours(days, weekday: int) -> tuple[int, int]:
    """Hours in which someone was present on at least one recorded source day with this weekday:
    from the first such hour to the end of the last one."""
    hours = {t.hour for d, s in days.items() if d.weekday() == weekday for t, c in s if c > 0}
    return min(hours), max(hours) + 1


def mugar_profile(days, hold: timedelta, window):
    """Representative weekday: the mean, over every recorded source day with the demo day's
    weekday, of each slot's time-weighted mean count."""
    per_slot = defaultdict(list)
    used = [d for d in days if d.weekday() == SOURCE_WEEKDAY]
    for d in used:
        for m, v in slot_means(days[d], hold, window[0] * 60, window[1] * 60).items():
            per_slot[m].append(v)
    return {m: statistics.fmean(v) for m, v in sorted(per_slot.items())}, used


def robod_reference(days, hold: timedelta, window) -> int:
    """Typical high: the time-weighted 95th percentile of Room 5 counts within the supported hours,
    over every recorded date."""
    from analytics import time_weighted_percentile  # noqa: E402
    clipped = []
    for d, s in days.items():
        tz = s[0][0].tzinfo
        start = datetime.combine(d, time(window[0]), tz)
        end = datetime.combine(d, time(), tz) + timedelta(hours=window[1])
        inside = [(t, c) for t, c in s if start <= t < end]
        if inside:
            clipped.append((inside, end))
    return time_weighted_percentile(clipped, REFERENCE_PERCENTILE, hold)


# ---------- reference: NOVANIMAL canteen sales (dining lunch) ----------
def load_novanimal():
    meta = json.loads(NOVANIMAL_IMPORT.read_text(encoding="utf-8"))
    days = defaultdict(dict)
    with open(NOVANIMAL_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t = datetime.fromisoformat(r["interval_start"])     # source wall clock
            days[(r["source_location"], t.date())][t.hour * 60 + t.minute] = int(r["transaction_count"])
    return meta, dict(sorted(days.items()))


def lunch_window(meta) -> tuple[int, int]:
    """The 15-minute-aligned window holding the central LUNCH_SHARE of all purchases
    (from the import's sale-time quantiles)."""
    q = meta["sale_time_quantiles"]
    lo, hi = (int(q[k][:2]) * 60 + int(q[k][3:]) for k in ("p0.5", "p99.5"))
    return lo // GRID_MIN * GRID_MIN, -(-hi // GRID_MIN) * GRID_MIN


def diners(intervals: dict[int, int], minute: int, dwell: int = DWELL_MIN) -> int:
    """Illustrative diners present at `minute`: purchases in the `dwell` minutes before it
    (a trailing sum of whole 15-minute intervals). Intervals the source doesn't list count as
    no purchases. A purchase is one checkout, not one person; this is a model, not a count."""
    return sum(intervals.get(minute - GRID_MIN * k, 0) for k in range(1, dwell // GRID_MIN + 1))


def dining_profile(days, period):
    """Representative weekday: mean illustrative diners per slot over every canteen-day with the
    demo day's weekday. Reference: the 95th percentile over every canteen-day and slot."""
    used = [k for k in days if k[1].weekday() == SOURCE_WEEKDAY]
    slots = range(period[0], period[1], GRID_MIN)
    profile = {m: statistics.fmean(diners(days[k], m) for k in used) for m in slots}
    reference = percentile([diners(days[k], m) for k in days for m in slots], REFERENCE_PERCENTILE)
    return profile, reference, used


# ---------- generation ----------
def generate():
    require(GYM_CSV, GYM_IMPORT, ROBOD_CSV, ROBOD_IMPORT, NOVANIMAL_CSV, NOVANIMAL_IMPORT)
    campus = json.loads(CAMPUS_JSON.read_text(encoding="utf-8"))
    hours = {fid: f["hours"] for fid, f in campus["facilities"].items()}
    out_rows = []

    # FitRec: one gym day, one scale factor from the gym's typical high to FitRec's busy threshold.
    gym_meta, gym_rows, offsets = load_gym()
    gym_reference = reference_from_import()
    fit = {"window": window_for(hours["fitrec-synthetic"]), "reference": gym_reference,
           "scale": round(BUSY_SHARE * FITREC_CAPACITY / gym_reference, 4), "offsets": offsets}
    fit["profile"] = gym_day_profile(gym_rows, gym_meta["gap_policy"]["max_hold_minutes"], fit["window"])
    for m, count in fit["profile"].items():
        out_rows.append((FITREC_SERIES, demo_time(m), round(count * fit["scale"])))

    # Mugar: ROBOD Room 5, only within the hours the source supports.
    suffix, (mugar_id, _, _, mugar_cap) = next((k, v) for k, v in OTHER_SYNTHETIC.items() if v[2] == "library")
    robod_meta, robod_days = load_robod()
    hold = timedelta(minutes=robod_meta["gap_policy"]["max_hold_minutes"])
    open_h = window_for(hours[mugar_id])
    src_h = supported_hours(robod_days, SOURCE_WEEKDAY)
    lib_window = (max(open_h[0], src_h[0]), min(open_h[1], src_h[1]))
    lib_profile, lib_days = mugar_profile(robod_days, hold, lib_window)
    lib_reference = robod_reference(robod_days, hold, lib_window)
    lib = {"open": open_h, "supported": src_h, "window": lib_window, "profile": lib_profile, "days": lib_days,
           "reference": lib_reference, "scale": round(BUSY_SHARE * mugar_cap / lib_reference, 4), "capacity": mugar_cap}
    for m, v in lib_profile.items():
        out_rows.append((f"SYN_BU_{suffix}", demo_time(m), round(v * lib["scale"])))

    # Dining: lunch from NOVANIMAL, breakfast and afternoon/dinner modeled; one period per slot.
    nova_meta, nova_days = load_novanimal()
    lw = lunch_window(nova_meta)
    lunch = (lw[0], lw[1] + DWELL_MIN)          # occupancy follows sales by up to one dwell time
    d_profile, d_reference, d_days = dining_profile(nova_days, lunch)
    dining = {"sales_window": lw, "period": lunch, "profile": d_profile, "reference": d_reference,
              "days": d_days, "halls": []}
    for suffix, (fid, name, cat, cap) in OTHER_SYNTHETIC.items():
        if cat != "dining":
            continue
        scale = round(BUSY_SHARE * cap / d_reference, 4)
        dining["halls"].append({"facility_id": fid, "name": name, "capacity": cap, "scale": scale,
                                "window": window_for(hours[fid])})
        for m in grid(window_for(hours[fid])):
            if lunch[0] <= m < lunch[1]:
                value = round(d_profile[m] * scale)
            else:
                value = round(cap * interpolate(BREAKFAST_KNOTS if m < lunch[0] else EVENING_KNOTS, m / 60))
            out_rows.append((f"SYN_BU_{suffix}", demo_time(m), value))

    out_rows.sort()
    if any(c < 0 for _, _, c in out_rows):
        sys.exit("Negative simulated occupancy; check the inputs.")
    provenance = build_provenance(campus, hours, gym_meta, fit, robod_meta, lib, nova_meta, dining)
    return out_rows, provenance


# ---------- provenance ----------
def build_provenance(campus, hours, gym_meta, fit, robod_meta, lib, nova_meta, dining):
    gym_src, rob_src, nov_src = gym_meta["source"], robod_meta["source"], nova_meta["source"]
    mugar = next((fid, name, cap) for fid, name, cat, cap in OTHER_SYNTHETIC.values() if cat == "library")
    hours_note = lambda fid: (f"{hours[fid][0][0]}-{hours[fid][0][1]} (illustrative sample hours)" if hours[fid]  # noqa: E731
                              else f"no sample hours; simulated {FALLBACK_WINDOW[0]:02d}:00-{FALLBACK_WINDOW[1]:02d}:00 like the other halls")
    span = lambda w: f"{w[0]:02d}:00-{w[1]:02d}:00"  # noqa: E731
    lunch, sales = dining["period"], dining["sales_window"]
    weekday = DEMO_DAY.strftime("%A")
    lib_dates = ", ".join(d.isoformat() for d in lib["days"])
    canteen_dates = sorted({d for _, d in dining["days"]})
    peak_m = max(dining["profile"], key=dining["profile"].get)
    return {
        "generated_by": "data/generate_campus_simulation.py",
        "demo_day": DEMO_DAY.isoformat(),
        "demo_clock": "Sample Monday on an America/New_York demo clock. Moving a source's time of day onto it is a "
                      "relabelling, not a timezone conversion.",
        "grid_minutes": GRID_MIN,
        "summary": "Busyness at BU-named places is simulated. FitRec follows one recorded day at a real campus gym "
                   "elsewhere; Mugar Library follows people counts from one small library room in Singapore; dining "
                   "halls follow canteen purchases in Switzerland at lunch, turned into diners by an assumed meal "
                   "length, with breakfast and dinner modeled. All of it is rescaled to illustrative sizes. None of it "
                   "measures BU.",
        "measures_note": "ROBOD counts people in a room. NOVANIMAL records purchases (checkouts), not people present: "
                         "turning them into diners needs an assumed meal length, so the dining values are a model "
                         "driven by real purchase times.",
        "datasets": [
            {
                "id": "campus-gym", "status": "used",
                "title": gym_src["title"], "creators": gym_src["creator"], "publisher": "Kaggle",
                "url": gym_src["page"], "version": f"version {gym_src['version']}, updated {gym_src['last_updated'][:10]}",
                "retrieved": gym_src["retrieved_at"], "license": "ODbL 1.0 (database), DbCL 1.0 (contents)",
                "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
                "obligations": "Attribute; share derived databases under ODbL; keep the notices.",
                "original_location": "An unnamed US university's campus gym (not BU)",
                "metric": "number_people: people in the gym, a count (0-145)",
                "measures": "people present",
                "sampling": f"about every 10 minutes, {gym_meta['first'][:10]} to {gym_meta['last'][:10]}",
                "timezone": f"local time with UTC offsets ({', '.join(gym_meta['offsets'])}); no named timezone",
                "measurement": gym_meta["measurement_method"],
                "modifications": "Resampled and rescaled for FitRec (see that simulation); the original is unchanged "
                                 "in data/raw/campus_gym/.",
                "notes": "Also shown unchanged as the 'Campus Gym — Historical Reference'. See data/campus_gym_quality.md.",
            },
            {
                "id": "robod", "status": "used",
                "title": rob_src["title"], "creators": rob_src["creators"], "publisher": "figshare",
                "url": rob_src["page"], "version": f"version {rob_src['version']}, modified {rob_src['modified'][:10]}",
                "retrieved": rob_src["retrieved_at"], "license": rob_src["license"], "license_url": rob_src["license_url"],
                "obligations": "Attribute the creators and the paper; indicate changes.",
                "citation": rob_src["citation"], "paper": rob_src["paper"],
                "original_location": "Room 5, a library space in the SDE4 building, National University of Singapore (not BU)",
                "metric": "occupant_count [number]: people in the room (ground truth), 0-"
                          f"{robod_meta['count_max']}",
                "measures": "people present",
                "sampling": f"every 5 minutes on {robod_meta['local_dates']} recorded weekdays, "
                            f"{robod_meta['first'][:10]} to {robod_meta['last'][:10]}, with gaps between periods",
                "timezone": "local time with a +08:00 UTC offset (Singapore), kept as written",
                "measurement": "Ground-truth occupant counts collected with the room's sensor data (publisher's "
                               "description). Wi-Fi device counts and the presence flag are not used.",
                "modifications": "Only combined_Room5.csv's timestamp and occupant_count are used; averaged and "
                                 "rescaled for Mugar (see that simulation). The original is unchanged in data/raw/robod/.",
                "notes": f"{robod_meta['rows_kept']:,} readings, none rejected. See data/robod_quality.md.",
            },
            {
                "id": "novanimal", "status": "used",
                "title": "NOVANIMAL aggregated menu sales (ZHAW canteens, autumn 2017)",
                "creators": nov_src["creators"], "publisher": "Zenodo", "url": nov_src["page"],
                "version": f"published {nov_src['published']}", "retrieved": nov_src["retrieved_at"],
                "license": nov_src["license"], "license_url": nov_src["license_url"],
                "obligations": "Attribute the creator and the working paper; indicate changes.",
                "citation": nov_src["title"], "paper": nov_src["working_paper"],
                "original_location": "Two ZHAW university canteens, Grüental and Vista (Wädenswil, Switzerland), not BU",
                "metric": "Point-of-sale transactions (purchases), grouped from article lines; not people",
                "measures": "purchases, not people present",
                "sampling": f"every sale, {nova_meta['first_date']} to {nova_meta['last_date']} "
                            f"({nova_meta['dates']} weekdays), almost all at lunch",
                "timezone": "trans_date ends in 'Z' but is read as local wall-clock time: the publisher's variable "
                            "list shows it without a zone and sale times don't move when Swiss summer time ends "
                            "(see data/novanimal_quality.md)",
                "measurement": "Canteen till records. A transaction can include several menus or a weighed buffet "
                               "plate; qty_weight (menus or kg) is never used as people.",
                "modifications": f"{nova_meta['rows_in_file']:,} article lines grouped into "
                                 f"{nova_meta['purchases_kept']:,} purchases (one refund left out), counted per 15 "
                                 "minutes, turned into illustrative diners and rescaled (see the dining simulation). "
                                 "The original is unchanged in data/raw/novanimal/.",
                "notes": "The individual data set (doi:10.5281/zenodo.3890949) is more personally detailed and isn't used.",
            },
            {
                "id": "chapel-hill-library", "status": "evaluated_not_used",
                "title": "Chapel Hill Public Library Foot Traffic", "creators": "Town of Chapel Hill",
                "publisher": "Town of Chapel Hill open data (ArcGIS)",
                "url": "https://opendata-townofchapelhill.hub.arcgis.com/datasets/townofchapelhill::chapel-hill-public-library-foot-traffic-june-30-2020",
                "version": "feature service last edited 2020-06-30", "retrieved": "2026-10-25 (inspection only)",
                "license": "ODbL (link in the publisher's metadata)", "license_url": "https://opendatacommons.org/licenses/odbl/",
                "obligations": "Would require attribution and ODbL share-alike if used.",
                "original_location": "Chapel Hill Public Library, North Carolina (public library, not BU)",
                "metric": "Total_Occupancy, Children_s_Room_Occupancy, Lobby_Occupancy (hourly occupancy from people counters)",
                "measures": "people present (as published)",
                "sampling": "documented as hourly",
                "timezone": "service reports UTC",
                "measurement": "People-counter sensors at four entrances; occupancy calculated hourly.",
                "notes": "Not used: all 5,365 rows (REST service and Hub CSV, checked 2026-10-25) are dated 1899-12-30 to "
                         "1901-02-19 at 00:00 UTC, so the time of day is lost and rows aren't in time order; "
                         "Children's Room occupancy also exceeds Total Building occupancy. Recovering hours would mean "
                         "inventing timestamps. Re-check with `python data/inspect_chapel_hill_library.py`.",
            },
            {
                "id": "uci-room-occupancy", "status": "evaluated_not_used",
                "title": "Room Occupancy Estimation", "creators": "Adarsh Pal Singh, Sachin Chaudhari",
                "publisher": "UCI Machine Learning Repository", "url": "https://doi.org/10.24432/C5P605",
                "version": "donated 2023-08-15", "retrieved": "2026-10-25 (inspection only)",
                "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
                "obligations": "Would require attribution if used.",
                "original_location": "One 6 m x 4.6 m test room (controlled experiment)",
                "metric": "Room_Occupancy_Count: 0-3 people, noted manually as ground truth",
                "measures": "people present",
                "sampling": "every ~30 s; 2017-12-22 to 2018-01-11 with a 15-day gap",
                "timezone": "not stated",
                "measurement": "Manual ground truth alongside environmental sensors.",
                "notes": "Not used for dining: people were present on only three days, on an experimenter-chosen "
                         "schedule of 0-3 people. Shaping that into meal times would make the model, not the data, "
                         "decide the curve, so citing it would mislead.",
            },
            {
                "id": "cod", "status": "reference_only",
                "title": "COD: A Dataset of Commercial Building Occupancy Traces",
                "creators": "Kin Sum Liu, Elvin Vindel Pinto, Sirajum Munir, Jonathan Francis, Charles Shelton, Mario Bergés, Shan Lin",
                "publisher": "Zenodo", "url": "https://doi.org/10.5281/zenodo.996587", "version": "2017",
                "retrieved": "see data/README.md", "license": "CC BY-SA 4.0",
                "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
                "obligations": "Attribute; share adaptations under CC BY-SA 4.0.",
                "original_location": "Clemente conference room, Bosch office (not BU)",
                "metric": "occupancy count per entry/exit event", "measures": "people present", "sampling": "event-based",
                "timezone": "unverified; kept as written",
                "measurement": "Doorway depth sensors (estimated counts).",
                "notes": "Shown only as a historical reference; drives no simulation.",
            },
        ],
        "simulations": [
            {
                "id": "fitrec-from-campus-gym", "basis": "reference_dataset", "dataset_id": "campus-gym",
                "label": "Simulated from a real campus gym (not BU)",
                "targets": [{"facility_id": "fitrec-synthetic", "name": "FitRec (whole building)",
                             "capacity": FITREC_CAPACITY, "hours": hours_note("fitrec-synthetic")}],
                "window": list(fit["window"]),
                "periods": [{"start": hhmm(fit["window"][0] * 60), "end": hhmm(fit["window"][1] * 60),
                             "basis": "reference_dataset", "dataset_id": "campus-gym",
                             "label": "From a campus gym's counts"}],
                "source_fields": ["number_people", "date"],
                "source_period": f"{GYM_SOURCE_DAY}, a Monday ({', '.join(fit['offsets'])}), the gym's default playback day",
                "metric": "people present (source) → people present (simulated)",
                "gap_handling": f"Latest reading at or before each slot if at most "
                                f"{gym_meta['gap_policy']['max_hold_minutes']} minutes old; otherwise the slot stays empty.",
                "parameters": {"scale": fit["scale"], "gym_typical_high": fit["reference"],
                               "fitrec_illustrative_capacity": FITREC_CAPACITY, "busy_share": BUSY_SHARE,
                               "grid_minutes": GRID_MIN, "max_hold_minutes": gym_meta["gap_policy"]["max_hold_minutes"],
                               "values": len(fit["profile"])},
                "transformations": [
                    f"Take the gym's readings for {GYM_SOURCE_DAY} (source local time, offset kept in the source file).",
                    f"Every {GRID_MIN} minutes from {fit['window'][0]}:00 to {fit['window'][1]}:00 (FitRec's sample hours), take the latest "
                    f"reading at or before that time if it is at most {gym_meta['gap_policy']['max_hold_minutes']} minutes old; otherwise "
                    "leave the slot empty (never zero).",
                    "Place each slot at the same clock time on the demo Monday (a relabelling, not a timezone conversion).",
                    f"Multiply by {fit['scale']}: the gym's typical high ({fit['reference']} people, its "
                    f"{REFERENCE_PERCENTILE:.0%} time-weighted percentile) becomes {BUSY_SHARE:.0%} of FitRec's "
                    f"illustrative capacity ({FITREC_CAPACITY:,}). Round to whole people.",
                ],
                "assumptions": [
                    "FitRec's time-of-day pattern resembles this gym's on one in-semester Monday.",
                    "The scale is a design choice for the demo, not FitRec's real size or capacity.",
                ],
                "units": "people (simulated)",
                "limits": [
                    "One count for the whole building, not a measurement of FitRec: it can't say which court, pool or "
                    "room is in use, and no queue, equipment or court availability can be read from it.",
                    "One source day: it shows a plausible pattern, not BU's typical traffic or a forecast.",
                    "The source gym's counting method isn't documented.",
                ],
            },
            {
                "id": "mugar-from-robod-library", "basis": "reference_dataset", "dataset_id": "robod",
                "label": "Simulated from a library room's counts (not BU)",
                "targets": [{"facility_id": mugar[0], "name": mugar[1], "capacity": mugar[2],
                             "hours": hours_note(mugar[0])}],
                "window": list(lib["window"]),
                "periods": [
                    {"start": hhmm(lib["window"][0] * 60), "end": hhmm(lib["window"][1] * 60),
                     "basis": "reference_dataset", "dataset_id": "robod", "label": "From a library room's counts"},
                    *([{"start": hhmm(lib["window"][1] * 60), "end": hhmm(lib["open"][1] * 60), "basis": "unavailable",
                        "dataset_id": None, "label": "Not simulated: the source library room is empty by this hour"}]
                      if lib["open"][1] > lib["window"][1] else []),
                ],
                "source_fields": ["timestamp", "occupant_count [number]"],
                "source_period": f"all {len(lib['days'])} recorded {weekday}s: {lib_dates} (+08:00)",
                "metric": "people present in one room (source) → people present in the building (simulated)",
                "gap_handling": f"Each reading stands for {robod_meta['gap_policy']['max_hold_minutes']} minutes (the "
                                "cadence) and never past local midnight; gaps between recorded periods are no data.",
                "parameters": {"scale": lib["scale"], "room_typical_high": lib["reference"],
                               "mugar_illustrative_capacity": lib["capacity"], "busy_share": BUSY_SHARE,
                               "grid_minutes": GRID_MIN, "source_days": len(lib["days"]),
                               "source_supported_hours": span(lib["supported"]), "sample_hours": span(lib["open"]),
                               "values": len(lib["profile"])},
                "transformations": [
                    f"Take Room 5's occupant_count on every recorded {weekday} ({len(lib['days'])} days), in source local "
                    "time with its +08:00 offset.",
                    f"For each {GRID_MIN}-minute slot, take the time-weighted mean count (each reading stands for 5 minutes), "
                    f"then average that slot over the {len(lib['days'])} days.",
                    f"Keep only {span(lib['window'])}: within Mugar's sample hours and the hours when someone was in the "
                    f"room on at least one recorded {weekday} ({span(lib['supported'])}).",
                    "Place each slot at the same clock time on the demo Monday (a relabelling, not a timezone conversion).",
                    f"Multiply by {lib['scale']}: the room's typical high ({lib['reference']} people, its "
                    f"{REFERENCE_PERCENTILE:.0%} time-weighted percentile over {span(lib['window'])} on all "
                    f"{robod_meta['local_dates']} recorded dates) becomes {BUSY_SHARE:.0%} of Mugar's illustrative "
                    f"capacity ({lib['capacity']:,}). Round to whole people.",
                ],
                "assumptions": [
                    "Mugar's time-of-day pattern resembles this one library room's average weekday pattern.",
                    "The scale is a design choice for the demo: ROBOD measures a small room (at most "
                    f"{robod_meta['count_max']} people), and neither its maximum nor the scale says anything about "
                    "Mugar's real size or capacity.",
                ],
                "units": "people (simulated)",
                "limits": [
                    "One small room in Singapore stands in for a large building in Boston: a pattern, not a measurement.",
                    "Averaging several days smooths the curve; the dates include later-semester weeks with lower use.",
                    f"No values {span((lib['window'][1], lib['open'][1]))}, though Mugar's sample hours run later: the "
                    f"room is empty by then on every recorded {weekday}, which says nothing about a library open late. "
                    "Shown as no data, not as zero or closed.",
                    "No seat or quiet-space availability can be read from it.",
                ],
            },
            {
                "id": "dining-lunch-from-novanimal", "basis": "mixed", "dataset_id": "novanimal",
                "label": "Lunch simulated from canteen sales (not BU); other hours modeled",
                "targets": [{"facility_id": h["facility_id"], "name": h["name"], "capacity": h["capacity"],
                             "hours": hours_note(h["facility_id"]), "scale": h["scale"]} for h in dining["halls"]],
                "window": list(FALLBACK_WINDOW),
                "periods": [
                    {"start": hhmm(FALLBACK_WINDOW[0] * 60), "end": hhmm(lunch[0]), "basis": "modeled", "dataset_id": None,
                     "label": "Breakfast and morning: modeled"},
                    {"start": hhmm(lunch[0]), "end": hhmm(lunch[1]), "basis": "reference_dataset", "dataset_id": "novanimal",
                     "label": "Lunch: from canteen purchase times"},
                    {"start": hhmm(lunch[1]), "end": hhmm(FALLBACK_WINDOW[1] * 60), "basis": "modeled", "dataset_id": None,
                     "label": "Afternoon and dinner: modeled"},
                ],
                "source_fields": ["transaction_id", "trans_date", "date", "shop_description"],
                "source_period": f"all {len(dining['days'])} canteen-{weekday}s (2 canteens x "
                                 f"{len(canteen_dates)} {weekday}s, {canteen_dates[0].isoformat()} to "
                                 f"{canteen_dates[-1].isoformat()}), source wall clock",
                "metric": "purchases per 15 minutes (source) → illustrative diners present (simulated)",
                "gap_handling": "A 15-minute interval the source doesn't list counts as no purchases (the canteen "
                                "recorded none); lunch is the only period the source supports.",
                "parameters": {"dwell_minutes": DWELL_MIN, "purchase_window": f"{hhmm(sales[0])}-{hhmm(sales[1])}",
                               "purchase_window_share": LUNCH_SHARE, "diners_typical_high": dining["reference"],
                               "busy_share": BUSY_SHARE, "grid_minutes": GRID_MIN, "source_days": len(dining["days"]),
                               "breakfast_knots": BREAKFAST_KNOTS, "evening_knots": EVENING_KNOTS,
                               "representative_peak": {"time": hhmm(peak_m),
                                                       "diners": round(dining["profile"][peak_m], 1)}},
                "transformations": [
                    "Group article lines into purchases by (canteen, date, transaction_id); a purchase counts once "
                    "whatever it contains (import step).",
                    f"Count purchases per {GRID_MIN} minutes on the source wall clock.",
                    f"Lunch window {hhmm(sales[0])}-{hhmm(sales[1])}: the {GRID_MIN}-minute-aligned span holding the "
                    f"central {LUNCH_SHARE:.1%} of all purchases.",
                    f"Illustrative diners at a time = purchases in the {DWELL_MIN} minutes before it (each purchase "
                    f"stands for one diner for {DWELL_MIN} minutes), so lunch values run "
                    f"{hhmm(lunch[0])}-{hhmm(lunch[1])}.",
                    f"Average each slot over all {len(dining['days'])} canteen-{weekday}s (both canteens pooled).",
                    f"Per hall, multiply by 0.75 x illustrative capacity / {dining['reference']} (the "
                    f"{REFERENCE_PERCENTILE:.0%} percentile of diners over every canteen-day and lunch slot), so a "
                    "typical high becomes the busy threshold. Round to whole people.",
                    f"Outside {hhmm(lunch[0])}-{hhmm(lunch[1])}, use the modeled breakfast and evening knots x "
                    "illustrative capacity. Each slot comes from exactly one period: no blending, nothing counted twice.",
                ],
                "assumptions": [
                    f"Meal length: each purchase is one diner present for {DWELL_MIN} minutes. Illustrative, not measured.",
                    "One purchase is one diner. A purchase can be for several people, and people who don't buy "
                    "(or bring food) aren't counted.",
                    "BU halls share one lunch shape; their differences come only from illustrative capacities.",
                    "Breakfast and dinner levels are a modeling choice, not evidence: NOVANIMAL covers lunch only.",
                ],
                "units": "people (simulated)",
                "limits": [
                    "Purchases are not occupancy: the source records checkouts, not arrivals, departures or seats.",
                    "No wait times, queues, table or seat availability can be read from it.",
                    "Two Swiss canteens in 2017 stand in for four BU dining halls: a pattern, not a measurement.",
                ],
            },
        ],
        "illustrative": [
            "Capacities (FitRec, dining halls, Mugar) and the busyness thresholds (quiet under 40%, busy from 75%).",
            f"The scale factors and the {DWELL_MIN}-minute meal length.",
            "Opening hours, the FitRec amenity list and study amenities.",
            "Walking times between demo locations (not routed).",
            "The demo Monday and its clock.",
        ],
        "historical_references": [
            {"facility_id": "COD_Bosch_Office_1_Clemente", "dataset_id": "cod",
             "note": "Shown as recorded; never a campus suggestion."},
            {"facility_id": "CAMPUS_GYM_HISTORICAL_REFERENCE", "dataset_id": "campus-gym",
             "note": "Shown as recorded; never a campus suggestion. Its observations stay separate from the FitRec simulation."},
        ],
        "reproduce": [
            "python data/import_campus_gym.py            # re-import the stored gym original (add --download to fetch it)",
            "python data/import_robod.py                 # ROBOD Room 5 (add --download to fetch it from figshare)",
            "python data/import_novanimal.py             # NOVANIMAL canteen sales (add --download to fetch it from Zenodo)",
            "python data/generate_campus_simulation.py   # simulated campus occupancy + this provenance",
            "python server/export_static.py              # web/data/ for static mode",
            "python data/inspect_chapel_hill_library.py  # optional: re-check the library source's timestamps",
        ],
    }


def main():
    rows, provenance = generate()
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["facility_id", "timestamp", "occupancy_count"])
        w.writerows(rows)
    OUT_JSON.write_text(json.dumps(provenance, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sims = {s["id"]: s for s in provenance["simulations"]}
    print(f"Rows:    {len(rows):,} ({len({r[0] for r in rows})} series, every {GRID_MIN} min)")
    print(f"FitRec:  x{sims['fitrec-from-campus-gym']['parameters']['scale']} from {GYM_SOURCE_DAY}")
    p = sims["mugar-from-robod-library"]["parameters"]
    print(f"Mugar:   x{p['scale']} from {p['source_days']} ROBOD days, {p['source_supported_hours']} supported")
    p = sims["dining-lunch-from-novanimal"]["parameters"]
    print(f"Dining:  lunch {sims['dining-lunch-from-novanimal']['periods'][1]['start']}-"
          f"{sims['dining-lunch-from-novanimal']['periods'][1]['end']} from {p['source_days']} canteen-days, "
          f"dwell {p['dwell_minutes']} min, typical high {p['diners_typical_high']} diners")
    print(f"Wrote {OUT_CSV.name} and {OUT_JSON.name}")


if __name__ == "__main__":
    main()
