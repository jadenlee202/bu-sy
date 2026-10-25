"""Generate BU-sy's simulated campus occupancy and its provenance.

The campus places (FitRec and its areas, four dining halls, Mugar Library) are
BU-named *simulations*. Nothing here measures BU. Each simulation is either:

  reference_dataset  driven by real observations from somewhere else (the campus
                     gym dataset), transformed by the documented steps below
  modeled            no suitable dataset could be used; an explicit, parameterised
                     profile, labelled as modeled and given no dataset citation

Inputs (all local; nothing is downloaded here):
    clean_campus_gym_occupancy.csv, campus_gym_import.json   from import_campus_gym.py
    campus_sample.json                                       illustrative opening hours
    server/sources.py                                        illustrative capacities and area list
Outputs:
    campus_simulation_occupancy.csv   facility_id,timestamp,occupancy_count on the demo clock
    simulation_provenance.json        every target, source, transformation, parameter, limit
                                      (served at /api/sources and web/data/sources.json)

Run:    python data/generate_campus_simulation.py
Deterministic: the same inputs always give byte-identical outputs.
"""
import csv
import json
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
from sources import FITREC_AREAS, OTHER_SYNTHETIC  # noqa: E402  (illustrative capacities live there)

GYM_CSV = HERE / "clean_campus_gym_occupancy.csv"
GYM_IMPORT = HERE / "campus_gym_import.json"
CAMPUS_JSON = HERE / "campus_sample.json"
OUT_CSV = HERE / "campus_simulation_occupancy.csv"
OUT_JSON = HERE / "simulation_provenance.json"

DEMO_DAY = date(2026, 10, 19)          # the app's sample Monday on its America/New_York demo clock
GRID_MIN = 15                           # one simulated value per 15 minutes
FALLBACK_WINDOW = (7, 23)               # dining hall without sample hours (Fenway): same window as the others

# FitRec from the campus gym (reference dataset)
GYM_SOURCE_DAY = "2016-12-05"           # the gym's default playback Monday, chosen by the import's fixed rule
BUSY_SHARE = 0.75                        # the busyness threshold, as a share of illustrative capacity

# Modeled fallbacks: (hour, share of illustrative capacity) knots, linearly interpolated
DINING_KNOTS = [(7, 0.05), (8, 0.35), (9, 0.25), (10.5, 0.10), (12, 0.75), (13, 0.65), (14.5, 0.15),
                (16.5, 0.10), (18, 0.85), (19.5, 0.55), (21, 0.15), (23, 0.05)]
LIBRARY_KNOTS = [(8, 0.10), (10, 0.30), (13, 0.60), (16, 0.70), (19, 0.85), (21, 0.80), (23, 0.45), (24, 0.25)]


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


def interpolate(knots, hour: float) -> float:
    if hour <= knots[0][0]:
        return knots[0][1]
    for (h0, v0), (h1, v1) in zip(knots, knots[1:]):
        if h0 <= hour <= h1:
            return v0 + (v1 - v0) * (hour - h0) / (h1 - h0)
    return knots[-1][1]


def allocate(total: int, weights: dict[str, int]) -> dict[str, int]:
    """Split a whole number by weight (largest remainder): parts are >= 0 and add up to `total`."""
    whole = sum(weights.values())
    raw = {k: total * w / whole for k, w in weights.items()}
    parts = {k: int(v) for k, v in raw.items()}
    for k in sorted(raw, key=lambda k: (-(raw[k] - parts[k]), k))[: total - sum(parts.values())]:
        parts[k] += 1
    return parts


# ---------- reference: the campus gym ----------
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


def generate():
    campus = json.loads(CAMPUS_JSON.read_text(encoding="utf-8"))
    hours = {fid: f["hours"] for fid, f in campus["facilities"].items()}
    meta, gym_rows, offsets = load_gym()
    hold = meta["gap_policy"]["max_hold_minutes"]
    out_rows = []

    # FitRec: one scale factor from the gym's typical high to FitRec's busy threshold.
    capacity = sum(a[3] for a in FITREC_AREAS.values())
    from sources import GYM_REFERENCE_PERCENTILE  # noqa: E402
    gym_reference = reference_from_import(meta)
    scale = round(BUSY_SHARE * capacity / gym_reference, 4)
    fit_window = window_for(hours["fitrec-synthetic"])
    profile = gym_day_profile(gym_rows, hold, fit_window)
    weights = {suffix: a[3] for suffix, a in FITREC_AREAS.items()}
    for m, count in profile.items():
        for suffix, n in allocate(round(count * scale), weights).items():
            out_rows.append((f"SYN_BU_FITREC_{suffix}", demo_time(m), n))

    # Dining halls and Mugar: modeled, no dataset.
    for suffix, (fid, _name, category, cap) in OTHER_SYNTHETIC.items():
        knots = LIBRARY_KNOTS if category == "library" else DINING_KNOTS
        for m in grid(window_for(hours[fid])):
            out_rows.append((f"SYN_BU_{suffix}", demo_time(m), round(cap * interpolate(knots, m / 60))))

    out_rows.sort()
    provenance = build_provenance(meta, campus, hours, scale, capacity, gym_reference, profile, offsets, fit_window,
                                  GYM_REFERENCE_PERCENTILE)
    return out_rows, provenance


def reference_from_import(meta) -> int:
    """The gym's typical high, recomputed by the server's own rule (95th time-weighted percentile)."""
    from sources import load_campus_gym  # noqa: E402
    gym = load_campus_gym(GYM_CSV, GYM_IMPORT)
    if gym is None:
        sys.exit("Campus gym data not found. Run `python data/import_campus_gym.py` first.")
    return int(gym.reference)


# ---------- provenance ----------
def build_provenance(meta, campus, hours, scale, capacity, gym_reference, profile, offsets, fit_window, pct):
    src = meta["source"]
    areas = [{"facility_id": "fitrec-synthetic", "area_id": a[0], "name": a[1], "capacity": a[3]}
             for a in FITREC_AREAS.values()]
    dining = [(fid, name, cap) for fid, name, cat, cap in OTHER_SYNTHETIC.values() if cat == "dining"]
    mugar = next((fid, name, cap) for fid, name, cat, cap in OTHER_SYNTHETIC.values() if cat == "library")
    hours_note = lambda fid: (f"{hours[fid][0][0]}-{hours[fid][0][1]} (illustrative sample hours)" if hours[fid]  # noqa: E731
                              else f"no sample hours; simulated {FALLBACK_WINDOW[0]:02d}:00-{FALLBACK_WINDOW[1]:02d}:00 like the other halls")
    return {
        "generated_by": "data/generate_campus_simulation.py",
        "demo_day": DEMO_DAY.isoformat(),
        "demo_clock": "Sample Monday on an America/New_York demo clock. Moving a source's time of day onto it is a "
                      "relabelling, not a timezone conversion.",
        "grid_minutes": GRID_MIN,
        "summary": "Busyness at BU-named places is simulated. FitRec follows one recorded day at a real campus gym "
                   "elsewhere, rescaled; dining halls and Mugar Library follow documented model profiles because no "
                   "usable dataset was found. None of it measures BU.",
        "datasets": [
            {
                "id": "campus-gym", "status": "used",
                "title": src["title"], "creators": src["creator"], "publisher": "Kaggle",
                "url": src["page"], "version": f"version {src['version']}, updated {src['last_updated'][:10]}",
                "retrieved": src["retrieved_at"], "license": "ODbL 1.0 (database), DbCL 1.0 (contents)",
                "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
                "obligations": "Attribute; share derived databases under ODbL; keep the notices.",
                "original_location": "An unnamed US university's campus gym (not BU)",
                "metric": "number_people: people in the gym, a count (0-145)",
                "sampling": f"about every 10 minutes, {meta['first'][:10]} to {meta['last'][:10]}",
                "timezone": f"local time with UTC offsets ({', '.join(meta['offsets'])}); no named timezone",
                "measurement": meta["measurement_method"],
                "notes": "Also shown unchanged as the 'Campus Gym — Historical Reference'. See data/campus_gym_quality.md.",
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
                "metric": "occupancy count per entry/exit event", "sampling": "event-based",
                "timezone": "unverified; kept as written",
                "measurement": "Doorway depth sensors (estimated counts).",
                "notes": "Shown only as a historical reference; drives no simulation.",
            },
        ],
        "simulations": [
            {
                "id": "fitrec-from-campus-gym", "basis": "reference_dataset", "dataset_id": "campus-gym",
                "label": "Simulated from a real campus gym (not BU)",
                "targets": [{"facility_id": "fitrec-synthetic", "area_id": None, "name": "FitRec (building total)",
                             "capacity": capacity}] + areas,
                "window": list(fit_window),
                "source_fields": ["number_people", "date"],
                "source_period": f"{GYM_SOURCE_DAY}, a Monday ({', '.join(offsets)}), the gym's default playback day",
                "parameters": {"scale": scale, "gym_typical_high": gym_reference, "fitrec_illustrative_capacity": capacity,
                               "busy_share": BUSY_SHARE, "grid_minutes": GRID_MIN,
                               "max_hold_minutes": meta["gap_policy"]["max_hold_minutes"], "values": len(profile)},
                "transformations": [
                    f"Take the gym's readings for {GYM_SOURCE_DAY} (source local time, offset kept in the source file).",
                    f"Every {GRID_MIN} minutes from {fit_window[0]}:00 to {fit_window[1]}:00 (FitRec's sample hours), take the latest "
                    f"reading at or before that time if it is at most {meta['gap_policy']['max_hold_minutes']} minutes old; otherwise "
                    "leave the slot empty (never zero).",
                    "Place each slot at the same clock time on the demo Monday (a relabelling, not a timezone conversion).",
                    f"Multiply by {scale}: the gym's typical high ({gym_reference} people, its {pct:.0%} time-weighted "
                    f"percentile) becomes {BUSY_SHARE:.0%} of FitRec's illustrative capacity ({capacity:,}). Round to whole people.",
                    "Split each FitRec total across the 21 areas in proportion to their illustrative capacities "
                    "(largest-remainder rounding), so the areas always add up to the building total.",
                ],
                "assumptions": [
                    "FitRec's time-of-day pattern resembles this gym's on one in-semester Monday.",
                    "Area differences are modeled: every area gets the same share of the total all day, so areas don't "
                    "have independent patterns and never differ in relative busyness except through crowd tolerance.",
                    "The scale is a design choice for the demo, not FitRec's real size or capacity.",
                ],
                "units": "people (simulated)",
                "limits": [
                    "Not a measurement of FitRec or any area; no queue, equipment or court availability can be read from it.",
                    "One source day: it shows a plausible pattern, not BU's typical traffic or a forecast.",
                    "The source gym's counting method isn't documented.",
                ],
            },
            {
                "id": "dining-meal-model", "basis": "modeled", "dataset_id": None,
                "label": "Modeled (no dataset)",
                "targets": [{"facility_id": fid, "area_id": None, "name": name, "capacity": cap, "hours": hours_note(fid)}
                            for fid, name, cap in dining],
                "window": list(FALLBACK_WINDOW),
                "source_fields": [], "source_period": None,
                "parameters": {"knots": DINING_KNOTS, "grid_minutes": GRID_MIN},
                "transformations": [
                    "Interpolate linearly between the (hour, share of illustrative capacity) knots: breakfast around 8 AM, "
                    "lunch around noon, dinner around 6 PM.",
                    f"Every {GRID_MIN} minutes within each hall's sample hours, multiply by that hall's illustrative "
                    "capacity and round to whole people.",
                ],
                "assumptions": [
                    "Meal peaks at 8 AM, noon and 6 PM, with dinner the busiest: a modeling choice, not observed behaviour.",
                    "All halls share one shape; only their illustrative sizes differ.",
                ],
                "units": "people (modeled)",
                "limits": [
                    "No dining dataset was found that could be used; this is a model, not data, and it does not "
                    "validate real dining patterns.",
                    "No seat availability or queue times can be read from it.",
                ],
            },
            {
                "id": "mugar-library-model", "basis": "modeled", "dataset_id": None,
                "label": "Modeled (no dataset)",
                "targets": [{"facility_id": mugar[0], "area_id": None, "name": mugar[1], "capacity": mugar[2],
                             "hours": hours_note(mugar[0])}],
                "window": list(window_for(hours[mugar[0]])),
                "source_fields": [], "source_period": None,
                "parameters": {"knots": LIBRARY_KNOTS, "grid_minutes": GRID_MIN},
                "transformations": [
                    "Interpolate linearly between the (hour, share of illustrative capacity) knots: a slow morning, "
                    "a busy afternoon and an evening peak around 7 PM.",
                    f"Every {GRID_MIN} minutes within the sample hours, multiply by the illustrative capacity and round.",
                ],
                "assumptions": ["A study-day shape typical of a university library: a modeling choice, not observed behaviour."],
                "units": "people (modeled)",
                "limits": [
                    "The library dataset considered (Chapel Hill Public Library) couldn't be used; see its entry.",
                    "No seat or quiet-space availability can be read from it.",
                ],
            },
        ],
        "illustrative": [
            "Capacities (FitRec areas, dining halls, Mugar) and the busyness thresholds (quiet under 40%, busy from 75%).",
            "Opening hours, closures and reservations (sample schedule), and study amenities.",
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
    print(f"Rows:   {len(rows):,} ({len({r[0] for r in rows})} series, every {GRID_MIN} min)")
    print(f"FitRec: scale x{sims['fitrec-from-campus-gym']['parameters']['scale']} from {GYM_SOURCE_DAY}")
    print(f"Wrote {OUT_CSV.name} and {OUT_JSON.name}")


if __name__ == "__main__":
    main()
