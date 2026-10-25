# Data

Occupancy inputs and the simulation built from them. Nothing here is live, and nothing here measures BU.

| File | What it is | Real? |
|---|---|---|
| `campus_simulation_occupancy.csv` | Simulated campus places on one demo Monday (2026-10-19), every 15 min: FitRec as one building (from the campus gym), 4 dining halls and Mugar (modeled). Made by `generate_campus_simulation.py`. | **No, simulated** |
| `simulation_provenance.json` | Which data drives each simulated place, every step and parameter, limits, citations. | — |
| `clean_cod_occupancy.csv` | Every valid event from the Clemente conference room in COD, cleaned by `clean_cod.py`. | **Yes**, but an office room, not BU |
| `sample_10_records.csv` | The first 10 rows of the cleaned COD file (chronological, not random). | Yes |
| `clean_campus_gym_occupancy.csv` | Every valid reading from *Crowdedness at the Campus Gym* (a non-BU university gym, 2015–2017), made by `import_campus_gym.py`. Optional: the app runs without it. | **Yes**, but not BU |
| `campus_gym_import.json`, `campus_gym_quality.md` | The import's statistics, gap policy and playback days (the server reads the JSON). | — |
| `raw/campus_gym/` | The publisher's `data.csv`, unchanged, with `SOURCE.json` (URL, version, retrieval time, checksums). | Yes |

Columns everywhere: `facility_id,timestamp,occupancy_count`.

## COD (real historical data)

**Source:** Kin Sum Liu, Elvin Vindel Pinto, Sirajum Munir, Jonathan Francis, Charles Shelton, Mario Bergés, Shan Lin.
*COD: A Dataset of Commercial Building Occupancy Traces.* Zenodo, 2017.
[doi:10.5281/zenodo.996587](https://doi.org/10.5281/zenodo.996587). License: **CC BY-SA 4.0**, so the cleaned
files in this folder are shared under the same license with this attribution.

**Regenerate:** `python data/clean_cod.py` (downloads the archive; standard library only).

**Cleaning results** (run on 2026-10-24):

| | |
|---|---|
| Source file | `COD/Bosch_Office_1/processed_occupancy_FORK_Clemente.csv` |
| Valid records | 8,340 |
| Skipped | 1 (the header row); 0 malformed; 0 negative counts |
| Range | 2015-08-26 07:00:00 → 2016-06-06 20:00:00 |
| Days | 165, weekdays only (Mon 34, Tue 34, Wed 35, Thu 30, Fri 32) |
| Counts | 0–22 people |

**Things to know before analysing it**

- **Event-based, not hourly.** A row is written when someone enters or leaves, so busy periods have many
  rows and quiet ones have few. Averaging rows would overweight busy periods; we use time-weighted
  averages instead (each count holds until the next row).
- **Each recorded day runs 07:00–20:00.** Every day starts with a `0` row at 07:00 and ends with a `0` row
  at 20:00, so counts are never carried overnight. Outside that window we show *no data*, not zero.
- **Timezone unverified.** Timestamps are kept exactly as written (no offset added, never converted to
  New York time). The app labels them "source local time; timezone unverified".
- **Estimated counts.** Depth sensors at the doorways estimated these, so they are not perfect ground truth.
- **Capacity unknown.** We show no "% full". Busyness is relative to the room's own history: its
  95th-percentile time-weighted count (4 people).

## Campus gym (real historical reference, not BU)

**Source:** Nick Rose, *Crowdedness at the Campus Gym*, Kaggle,
[nsrose7224/crowdedness-at-the-campus-gym](https://www.kaggle.com/datasets/nsrose7224/crowdedness-at-the-campus-gym),
version 2 (updated 2017-03-19). **License:** [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) for the
database, [DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) for its contents. Keep the attribution;
the derived files (`clean_campus_gym_occupancy.csv`, `campus_gym_import.json`,
`web/data/history/CAMPUS_GYM_HISTORICAL_REFERENCE*`) are shared under ODbL 1.0 too. See `raw/campus_gym/README.md`.

**Get and import it** (standard library only; no network unless you ask for it):
```bash
python data/import_campus_gym.py --download   # fetch the original from Kaggle's public endpoint, then import
python data/import_campus_gym.py              # re-import the stored original (offline, same output every time)
python server/export_static.py                # refresh web/data/ for static mode
```
If Kaggle asks you to sign in, download `data.csv` from the dataset page yourself, put it in
`data/raw/campus_gym/`, and run the second command. Without the file the gym is simply not shown.

**Results** (retrieved 2026-10-25 UTC; full table in [`campus_gym_quality.md`](campus_gym_quality.md)):

| | |
|---|---|
| Rows | 62,184 in the file, all kept (0 malformed, missing, negative or duplicate). Kaggle's description says "26,000"; the file has more. |
| Range | 2015-08-14 17:00 −07:00 → 2017-03-18 19:22 −07:00; 538 local days (535 used, see below) |
| Counts | 0–145 people; 8,775 readings are 0 (mostly overnight) |
| Cadence | median 10 min; 4,862 gaps of 15–25 min (one missed reading); 495 gaps over 30 min, 39 over 6 h, the longest 25 days (Jan–Feb 2017) |
| Nights | on most nights nothing is recorded from about 1:00 to 5:20 AM |
| Field checks | `timestamp`, `day_of_week`, `hour`, `month`, `is_weekend` all agree with `date` |
| Order | 1 row out of order (2016-11-06, the repeated 1 AM hour labelled −08:00 twice) |

**Things to know before analysing it**

- **Timestamps.** `date` is the full local datetime with a UTC offset (−07:00 or −08:00, switching on US
  daylight-saving dates). BU-sy keeps that offset, assigns no named timezone, never converts to Boston time,
  and reads weekday and hour from the source's own clock. `timestamp` is *seconds since local midnight*
  (documented), not a Unix epoch.
- **Gap policy.** A reading stands for at most 30 minutes (three times the 10-minute cadence) and never past
  local midnight; anything longer is *no data*, never zero and never the last count stretched out. Days whose
  offset changes (2015-11-01, 2016-03-13, 2016-11-06) are left out of playback and typical traffic, because a
  wall-clock hour repeats or is skipped.
- **Method unknown.** The author says counts were "measured" about every 10 minutes, with the university's and
  the gym's consent. How (sensor, card swipes, staff tally) isn't stated, so the app says "not documented".
- **Capacity unknown.** Busyness is relative to this gym's own history: its 95th-percentile time-weighted count
  (72 people) over 535 days. It is never a "% full" and says nothing about safe capacity.
- **Typical traffic** per weekday and hour is a time-weighted average over every recorded day (semesters and
  breaks together); a weekday-hour with under 5 hours of recordings is left blank.
- **Playback days.** The app offers one week, chosen by a fixed rule: the most recent full Monday–Sunday
  in a semester with no holiday, no offset change and at least 18 hours covered each day (5–11 Dec 2016). Only
  those 7 days are exported for static mode; the API also accepts other recorded dates via `?date=`.
  The replay slider covers the whole day (12 AM–11:59 PM). Its opening hours aren't documented, so
  outside its recordings the gym shows *no data*, never *closed*.
- **Not a destination.** It has no BU location, walking times, hours, amenities or equipment list, and is never a
  campus suggestion (`campus_eligible: false`).

## Planner samples (illustrative)

Used by "What fits now?". Loaded and validated by `server/campus.py`, then exported to `web/data/campus.json`.

| File | What |
|---|---|
| `campus_sample.json` | 6 demo locations; which place supports study / eat / work out (6 places, one per facility; FitRec is one building); illustrative opening hours (Fenway Dining deliberately has none, so it shows "check hours"); illustrative study amenities; 3 demo scenarios. |
| `sample_travel_times.csv` | Undirected sample walking minutes between those locations. Not routed. West Campus ↔ Fenway is deliberately missing, so it is treated as unknown, never zero. |

There is no class, intramural or reservation schedule: FitRec is tracked as one building, because no data
could say which court, pool or room is in use. None of this is verified BU information; replace each file
with a verified source before a pilot.

## Simulated campus places

`generate_campus_simulation.py` writes `campus_simulation_occupancy.csv` (one demo Monday, every 15 minutes,
392 rows; FitRec is the single series `SYN_BU_FITREC`) and `simulation_provenance.json` (every target, source, transformation,
parameter and limit; served at `/api/sources`, exported to `web/data/sources.json`, shown on the app's
**Sources & Simulation** page). It reads only local files and never downloads. The hand-authored
`bu_campus_synthetic_occupancy.csv` it replaces is retired (still in git history).

| Place | Basis | Source |
|---|---|---|
| FitRec (whole building) | **Reference dataset** | Campus gym, 2016-12-05 (a Monday), rescaled |
| Warren, Marciano, West Campus, Fenway dining | **Modeled, no dataset** | Meal-window profile |
| Mugar Library | **Modeled, no dataset** | Study-day profile |

**FitRec, step by step.** Take the gym's readings for 2016-12-05 (source local time, −08:00, kept in the
source file). Every 15 minutes from 6 AM to midnight (FitRec's sample hours) take the latest reading at or
before that time if it is at most 30 minutes old, else leave the slot empty (never zero). Put each slot at
the same clock time on the demo Monday: a relabelling, not a timezone conversion. Multiply by 9.0625, which
maps the gym's typical high (72 people) to 75% of FitRec's illustrative capacity (870), the busy threshold.
FitRec is one building-level count: there are no per-area series (courts, pools, rooms), because nothing
in the data could say where in the building people are.

**Dining and Mugar** use documented (hour, share of illustrative capacity) knots, linearly interpolated,
times each place's illustrative capacity. They carry no dataset citation because none was used.

**Datasets considered and not used** (checked 2026-10-25):

- *Chapel Hill Public Library Foot Traffic* (Town of Chapel Hill, ODbL). Reachable and openly licensed, but all
  5,365 rows (REST service and Hub CSV) are dated 1899-12-30 to 1901-02-19 at 00:00 UTC: the time of day is gone
  and rows aren't in time order, and Children's Room occupancy exceeds the building total in 3,567 rows.
  Recovering hours would mean inventing timestamps. `python data/inspect_chapel_hill_library.py` re-checks it.
- *Room Occupancy Estimation* (Singh & Chaudhari, UCI, CC BY 4.0,
  [doi:10.24432/C5P605](https://doi.org/10.24432/C5P605)). Manually recorded 0–3 people in one test room; people
  were present on only three days, on an experimenter-chosen schedule. As a dining proxy, the meal shaping would
  decide the curve, so citing it would mislead.
- No openly licensed dining-hall occupancy dataset was found in a time-boxed search.

Capacities (in `server/sources.py`), hours, amenities and walking times remain illustrative.
