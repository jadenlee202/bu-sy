# BU-sy

**Make the most of your time between classes.** Tell BU-sy what you want to do (study, eat or work out),
how long you're free, where you are and where you're heading next. It suggests campus places that actually
fit, and shows the arithmetic: *"Fits your 70-minute window: 10 min there + 36-minute workout + 14 min
onward + 10-minute buffer."*

Occupancy supports the decision; it isn't the product. Browsing places, the replayable traffic charts and
unofficial student meetups are still there as secondary screens.

Independent student project, **not affiliated with Boston University**.

> **Data honesty:** every campus place, count, capacity, opening hour, amenity and walking time is
> **demo data** (labelled *Demo · Synthetic campus data*). The one real dataset is the *Clemente Room*,
> an office conference room from the public COD dataset. It shows the pipeline on real sensor data, and it
> is **never** suggested as a place to go.

## Run it

**Demo day?** Follow [`DEMO.md`](DEMO.md): exact startup, the demo sequence, checks and recovery steps.

Requires **Python 3.12+**. Node 20+ is only needed for the engine tests. There are no accounts, keys or secrets.

**Just the site (no install):**
```bash
python -m http.server 8000 -d web       # macOS/Linux: python3
# open http://localhost:8000
```
It reads the pre-built JSON in `web/data/`; meetups are saved in your browser.

**With the API** (meetups shared between everyone using the server):
```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt          # macOS/Linux: .venv/bin/python
.venv\Scripts\python -m uvicorn main:app --app-dir server --reload
# open http://127.0.0.1:8000   (API docs at /docs)
```
This runs from the repo root and doesn't need `activate`, which PowerShell often blocks.
The site detects the API automatically. To use an API on another host, add `?api=https://host` to the URL.
The API allows cross-origin requests (`BUSY_CORS_ORIGINS` restricts them).

The footer always names the data source (*built-in demo files* or *BU-sy API*). If a requested API can't be
reached, a notice says so and the built-in demo files are used. Both modes give the same suggestions
(see *Static and API modes* below).

**Try it:** press **Try a sample scenario** (70 free minutes at 3 PM, work out, from Mugar to a class at
Warren Towers). The other samples show a best match chosen on evidence (*study, outlets needed*) and a
window where nothing fits, with a one-tap fix the engine has checked.

## Checks

```bash
python -m pytest                        # API, data loaders, analytics, events, CORS, static export == API
node --test tests/recommend.test.mjs    # planner engine (Node 20+, no packages; or: npm test)
```
CI runs both (`.github/workflows/tests.yml`).

## How "What fits now?" works

The rules live in one file, [`web/js/recommend.js`](web/js/recommend.js). They are deterministic, with no ML,
no randomness and no clock reads, and the same code runs in the browser and in the Node tests.

**The window.** It starts at the selected time (the demo clock by default) and ends at your next commitment,
`start + free minutes`. The buffer is kept free just before that boundary.

**Fit rule.** A place fits only if
`free minutes ≥ walk there + activity time + walk onward + buffer` and `activity time ≥ your minimum`.
Each part is counted once, and the parts shown always add up to the window. With no next stop, onward travel
isn't counted, and the app says so.

**Before ranking, a place is excluded when:**
- it doesn't support the activity;
- it lacks a study need you required (an amenity that isn't listed is treated as unknown, not as present);
- the sample walking time is missing (unknown, never zero; the same location is zero);
- there isn't enough time;
- it is closed or reserved during any part of the visit. Illustrative hours, minus sample-schedule
  reservations such as intramural basketball 7–9 PM. If a place opens a little later, the visit waits for
  opening; if it closes early, the unused minutes are shown.

**Unknown hours.** A place that fits on time but has no hours is never shown as confirmed. It appears under
**Check hours before going**.

**Ranking.** Comparisons are lexicographic and documented in the code:
1. Your preference: busyness level if you chose *quieter*; total sample walking if you chose *shorter walks*;
   if neither, more activity time.
2. Then, in order: busyness level, walking, activity time, and study amenities listed.
3. Then name and id, so results are reproducible.

Busyness is compared by **level** (quiet < moderate < *unavailable* < busy), not by exact percentage,
because capacities are illustrative. A place with no count is never treated as quiet.

**Best match.** This label appears only when something other than the alphabetical tie-break separates
#1 from #2, and never when #1's busyness is unavailable. Otherwise the app says the options are equal.

**Busyness wording.** Labels are tied to the count's time: *"Quiet at the selected demo time"* or
*"Busyness unavailable"*. There's no forecasting for your arrival time, and campus places have no
multi-day history that could support "historically quieter".

**Nothing fits.** The app says why (grouped reasons, plus a per-place list) and offers changes such as a
longer window, a shorter minimum, another activity or dropping a requirement. It suggests a change only
after re-running the engine to confirm it would really fit. The form keeps your inputs.

### Inputs designed for later
A request is `{activity, start, minutes, source, from, to, minActivity, buffer, preferQuiet,
preferShortTravel, needs}`.
- **`source`** is `"manual"` today. A future calendar integration would set `source: "calendar"` and fill
  `start`/`minutes` from the gap before the next event, and `to` from that event's location.
- **`from`** is always chosen by the student. A calendar event is never taken as proof of where someone is,
  and there is no location tracking.

## Data

| File | What | Real? |
|---|---|---|
| `data/bu_campus_synthetic_occupancy.csv` | one sample Monday, hourly, FitRec areas, 4 dining halls, Mugar | **synthetic** |
| `data/campus_sample.json` | which place supports which activity, its location, illustrative hours and amenities, demo scenarios | **illustrative** |
| `data/sample_travel_times.csv` | sample walking minutes between 6 demo locations (West↔Fenway intentionally missing) | **illustrative** |
| `data/clean_cod_occupancy.csv` | COD Clemente Room, cleaned by `data/clean_cod.py` | real office data, not BU |

`server/campus.py` validates the planner data at startup:
- every place must point to an existing **synthetic** facility or area, so COD can't be added;
- times must be valid `HH:MM`, from 00:00 up to 24:00;
- walking times can't be listed twice and must name known locations;
- amenities must be known.

The engine reads only this normalized shape. Verified hours, a routing service or an authorized live feed
can each replace one file without touching the rules.

**What COD demonstrates.** Event-based sensor data handled honestly:
- time-weighted averages rather than plain row averages;
- *no data* rather than zero outside the recorded hours;
- its original facility id and source attribution are kept;
- timestamps stay in their unverified source timezone (never forced to New York);
- busyness is relative to the room's own 95th-percentile time-weighted count, because capacity is unknown.

It lives in **Places** as a data demo and is excluded from campus suggestions.

## Static and API modes

The engine sees identical input in both modes:

| | Planner data | Facility histories |
|---|---|---|
| API mode | `GET /api/campus` | `GET /api/facilities/{id}/history` |
| Static mode (GitHub Pages) | `web/data/campus.json` | `web/data/history/{id}.json` |

A pytest asserts the exported files equal the API responses.

**After changing anything in `data/` or `server/`, regenerate and commit the static copy:**
```bash
python server/export_static.py
```
If the data can't load, the planner shows an error with a retry. It never falls back to unlabelled or
"live" data.

## Publish on GitHub Pages

1. Push to `main`.
2. **Settings → Pages → Source: GitHub Actions.** Free accounts need a public repo for Pages.
3. Every push to `main` deploys `web/` (`.github/workflows/pages.yml`).

## What's inside

```
data/      raw + cleaned data, planner samples, sources and cleaning notes (data/README.md)
server/    FastAPI app (main.py), data adapter (sources.py), planner data loader (campus.py),
           analytics.py (busyness, time-weighted averages, playback), meetups, static export
web/       the site: index.html, styles.css, js/
             recommend.js  planner engine (single source of truth)
             plan.js       "What fits now?" screen
             app.js        router, Places, playback, meetups, About
             source.js     data adapter (API or static)   clock.js / ui.js / icons.js  helpers
           data/ (generated)
tests/     test_api.py (pytest), recommend.test.mjs (node --test)
DEMO.md    demo runbook: startup, demo sequence, checks, recovery
```

### API
| | |
|---|---|
| `GET /api/campus` | planner data: places, activities, illustrative hours/amenities, sample walking times, scenarios |
| `GET /api/facilities?at=17:30` | all places at a playback time |
| `GET /api/facilities/{id}?at=18:00` | one place (+ FitRec areas and sample class reservations) |
| `GET /api/facilities/{id}/history` | the recorded day: observations, hourly averages, typical profile |
| `GET /api/schedule`, `GET /api/programs` | **sample** official schedule (placeholders) |
| `GET/POST /api/community-events`, `POST …/{id}/join`, `…/leave`, `…/cancel` | unofficial student meetups |

## What a real BU pilot would need

1. **Authorized, aggregate occupancy feeds** (e.g. FitRec's existing counts), replacing `server/sources.py`
   while keeping the `Facility` shape. The wording would switch from "demo time" to "last count, N min ago".
2. **Verified hours and closures**, from published schedules, with `hours_basis: "verified"`.
3. **Real walking estimates**, from campus routing data or a maps service, replacing `sample_travel_times.csv`.
4. **Verified amenities** (outlets, quiet floors) from the facilities themselves.
5. **Calendar-derived free windows** (opt-in, read-only, processed on device where possible), feeding the
   same request shape.
6. Accessibility review, privacy review and student testing before any claim of accuracy.

## Data sources
- Liu et al., *COD: A Dataset of Commercial Building Occupancy Traces*, Zenodo 2017,
  [doi:10.5281/zenodo.996587](https://doi.org/10.5281/zenodo.996587), CC BY-SA 4.0.
- Synthetic campus data and planner samples made by the team. Details: [`data/README.md`](data/README.md).

BU's own [Peak & Quiet Hours](https://www.bu.edu/fitrec/peak-quiet-hours/) page already reports FitRec
traffic. BU-sy explores planning around free time, not a replacement for it.
