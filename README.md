# BU-sy

**Plan the gap between classes in one sentence.** Tell BU-sy *"I have **1 hr** to **study**"* and it finds a campus
spot that fits: the walk there from where you are, then the activity, until your time is up. It shows one clear
answer (*Marciano Commons · 12 min walk · 48 min to study · quiet*), every other option a tap away, and hands the
route to Google Maps.

**Live demo:** https://jadenlee202.github.io/bu-sy/ · People counter: https://jadenlee202.github.io/bu-sy/counter/

Independent student project, **not affiliated with Boston University**.

> **Data honesty:** busyness at BU-named places is **simulated** and labeled that way: FitRec follows one recorded
> day at a real campus gym elsewhere; Mugar follows people counts in one small library room in Singapore (ROBOD);
> dining halls follow canteen purchases in Switzerland at lunch (NOVANIMAL), turned into diners with an assumed
> 30-minute meal, while breakfast and dinner stay modeled. All of it is rescaled to illustrative sizes. Building
> and meal-service hours come from official BU pages where available (`web/data/hours.json`); unpublished or
> unverified hours are said so, never guessed. *About the data* (`#/about`) lists every dataset, its licence and
> what is still illustrative. Two real datasets (the COD Clemente Room, a non-BU campus gym) are kept as
> historical references in the data and the API, and are **never** suggested as places to go.

## Run it

**Demo day?** Follow [`DEMO.md`](DEMO.md): exact startup, the demo sequence, checks and recovery steps.

Requires **Python 3.12+**. Node 22+ is needed only for the JS/CSS and browser tests (`npm ci` first).
There are no accounts, keys or secrets.

**Just the site (no install):**
```bash
python -m http.server 8000 -d web       # macOS/Linux: python3
# open http://localhost:8000
```
It reads the pre-built JSON in `web/data/`; club sign-ups are saved in your browser. Location (for the walking
estimate) only works on `https://` or `localhost`.

**With the API** (club sign-ups shared between everyone using the server):
```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt          # macOS/Linux: .venv/bin/python
.venv\Scripts\python -m uvicorn main:app --app-dir server --reload
# open http://127.0.0.1:8000   (API docs at /docs)
```
This runs from the repo root and doesn't need `activate`, which PowerShell often blocks.
The site detects the API automatically. To use an API on another host, add `?api=https://host` to the URL.
The API allows cross-origin requests (`BUSY_CORS_ORIGINS` restricts them).

**Try it:** tap *Get started*, say which places you can use, then tap a red word to change the time or the
activity and tap *Find a spot*. The first time, BU-sy asks for your location to time the walk.

## The app

One page (`web/index.html`, code in `web/app/`), Brownstone palette, three tabs. Every decision comes from the
shared modules in `web/js/`: the engine (`recommend.js`), verified hours (`hours.js`), the `.ics` import and free
time (`schedule.js`, `availability.js`), saved club meetings (`clubevents.js`) and the data adapter (`source.js`).

| Screen | What it does |
|---|---|
| **Plan** | One sentence, *"I have [1 hr] to [study]."* Each red word opens a sheet. If your schedule shows you're free now, the time is filled in from it. |
| **Answer** | One place, a time bar (walk, activity), two timed steps, *Open directions*, *See all options*. Nothing fits → the reasons and the engine's checked fixes (*Extend to 55 minutes*). |
| **Schedule** | A week strip (free hours per day) and a day map from your `.ics` file and saved club meetings: every event is a busy block (even ones marked free; all-day events are listed above the day), a now line, and in each gap the club meetings that fit, a meal at breakfast, lunch or dinner, and a study block, none overlapping an event or each other (walk + one session, the same engine as Plan). **Plan this** plans one; **Add to calendar** keeps it as an event. **+ Add event** adds your own (title and times, kept in this browser, `myevents.js`); a kept or added event is busy, the gaps re-fill around it, a meal already on the day isn't suggested again, and anything added here can be removed. Import, replace, clear. |
| **Explore** | Places with live open status and a busyness meter; clubs; one search box. |
| **Place** | Live status and meal, busyness now, the sample day hour by hour, this week's building hours, today's meals, facility details with official sources, directions. |
| **Club** | Details, the next four meetings (*Add to calendar*: they count as busy), join with name, school email (`@bu.edu`) and year, withdraw. |
| **About the data** | Datasets, licences, what's still illustrative, how location and personal data are handled. |
| **First run** | Welcome, *Which can you use?* (Mugar, FitRec, dining), a one-time tip. |

**Planning.** Free time is the walk there plus the activity, nothing else: no next stop, buffer, setup or pack-up.
The window starts now (rounded up to 5 minutes) or at a free window picked in *Schedule*. Places are ruled out when
they don't support the activity, are closed for any part of the visit, need access you haven't confirmed, have no
walking estimate, or leave less than the activity's minimum (study 30, eat 20, work out 35 minutes). The rest rank
quieter first, then shorter walk, then more time. Hours are looked up for the simulated demo day, the same day the
busyness replays.

**Walking time** is estimated **on the device**: the straight-line distance from your location to the building
× 1.2 at 84 m/min (about 5 km/h, the pace Google Maps assumes), never zero, labeled as an estimate. Your location is
asked for on the first *Find a spot*, kept in memory for the visit, never stored or sent. Building points were
geocoded once from the verified addresses (`web/app/places-geo.json`, © OpenStreetMap contributors, ODbL); Fenway
has no verified address, so its walk stays unknown. With location off you can say which building you're near.
*Open directions* opens Google Maps' walking route (its own start is your current location).

**Busyness meter.** Three bars beside a word: one green bar quiet, two amber moderate, three brick busy, empty for
closed or no data. Explore and place pages show it now; the answer shows the busiest part of the planned visit.
Thresholds as everywhere else: under 40 % quiet, under 75 % moderate, otherwise busy (demo thresholds).

**Your schedule (`.ics`).** Upload a calendar file exported from Google Calendar, Apple Calendar, Outlook or any
iCalendar app. There is no sign-in; the file is parsed **in the browser** with
[ical.js](https://github.com/kewisch/ical.js) 2.2.1 (MPL-2.0, vendored unmodified in `web/vendor/`), and never sent
to a server or AI service.

- **What's kept:** merged busy intervals, each occurrence's title, start, end and all-day/free flags, the file
  name and the covered range — never the file, descriptions, locations or attendees — in `sessionStorage`
  (cleared when the tab closes). *Clear* deletes it.
- **Validation:** `.ics` name (or `text/calendar` type), at most 2 MB, contents must start with `BEGIN:VCALENDAR`
  and parse. A failed upload never replaces the previous schedule.
- **Times:** a `TZID` is used as written, UTC stays UTC, floating times and all-day dates use America/New_York;
  recurrence rules, `EXDATE`, moved occurrences and cancellations are honored; free and cancelled events aren't
  busy. Occurrences are expanded from 31 days before the import to 366 days after it.
- **Club meetings** added from a club page are stored apart from the file (`busy.clubEvents.v1`), count as busy,
  and survive replacing or clearing it.

**Motion and access.** Press feedback on every control, page transitions (View Transitions), sliding sheets and a
pin-clock loader; all of it is off under `prefers-reduced-motion`. Every control is a real button or link, sheets
trap focus and close on Escape, and no level is shown by colour alone.

**People counter** (camera, on-device): `/counter/` counts people crossing a line and never uploads video. It's a
prototype for producing real counts; nothing in the planner uses it yet. Setup, model and how it works:
[`web/counter/README.md`](web/counter/README.md).

## Checks

```bash
python -m pytest                        # API, clubs, hours, calendar OAuth/freebusy, data loaders + gym import, analytics
npm ci                                  # dev tools only (PostCSS, Playwright); Node 22+
npm run check:css                       # strict CSS parse + merge-conflict markers
npm test                                # engine, hours, .ics, free time, clubs, app logic, releases, people counter
npx playwright install chromium
npm run test:browser                    # the app's flows, version history, layout at 320–1280 px, the service worker
```
CI runs all of them (`.github/workflows/tests.yml`), and the Pages deploy waits for them.

## The engine

`web/js/recommend.js` is deterministic: no ML, no randomness, no clock reads; the same code runs in the browser and
in the Node tests. It supports more than the app uses — preparation and cleanup allowances, a buffer, a next stop
with an onward walk — and the app sets those to zero (`web/app/logic.js` → `buildRequest`). The engine treats
anything it can't check as unknown, never as zero or open: a missing walk excludes a place, unknown hours put it under
*hours unknown*, unknown access under *check access*. A suggestion (*Extend to 55 minutes*, *Eat instead*) is only
offered after re-running the engine to confirm it would really fit. Ranking and its reasons are documented at the top
of the file.

## Data

| File | What | Real? |
|---|---|---|
| `data/campus_simulation_occupancy.csv` | one demo Monday every 15 min: FitRec as one building (campus gym), Mugar (ROBOD library room), 4 dining halls (NOVANIMAL at lunch, modeled otherwise); made by `data/generate_campus_simulation.py` | **simulated** |
| `data/simulation_provenance.json` | dataset-to-place mapping, steps, parameters, limits (also `/api/sources`) | — |
| `data/campus_sample.json` | which place supports which activity, its location, illustrative hours and amenities, demo scenarios | **illustrative** |
| `data/sample_travel_times.csv` | sample walking minutes between 6 demo locations (West↔Fenway intentionally missing) | **illustrative** |
| `data/clean_cod_occupancy.csv` | COD Clemente Room, cleaned by `data/clean_cod.py` | real office data, not BU |
| `data/clean_campus_gym_occupancy.csv` | a non-BU campus gym, imported by `data/import_campus_gym.py` (optional) | real gym data, not BU |
| `data/clean_robod_library_occupancy.csv` | ROBOD Room 5 people counts (NUS library space), imported by `data/import_robod.py` | real room data, not BU |
| `data/clean_novanimal_transactions.csv` | NOVANIMAL purchases per canteen per 15 min (ZHAW), imported by `data/import_novanimal.py` | real sales data (purchases, not people), not BU |

`server/campus.py` validates the planner data at startup:
- every place must point to an existing campus-eligible (**synthetic**) facility, once, so COD and the
  campus gym can't be added (`campus_eligible: false` in the API);
- times must be valid `HH:MM`, from 00:00 up to 24:00;
- walking times can't be listed twice and must name known locations;
- amenities must be known.

The engine reads only this normalized shape. Verified hours, a routing service or an authorized live feed
can each replace one file without touching the rules.

### Facility checks for actionable plans (October 25, 2026)

Each place now carries field-level `metadata` in the existing campus payload/export: name, address,
access, payment, study amenities and current schedule each have their own status, checked date and
official URL. Verifying an address never marks occupancy, amenities or the whole facility verified.

- **FitRec:** [fall building hours](https://www.bu.edu/fitrec/visit-us/hours/),
  [student access, waiver and card](https://www.bu.edu/fitrec/about-us/fitrec-welcomes-new-terriers/frequently-asked-questions-and-things-you-need-to-know/),
  [address](https://www.bu.edu/fitrec/visit-us/directions-parking/). One building, no areas or queues.
- **Mugar:** [name, address and exhibition visitor restrictions](https://www.bu.edu/library/news-events/news-updates/),
  [documented computing lab](https://www.bu.edu/summer/summer-sessions/campus-resources/computing-resources/).
  General entry eligibility and current building hours remain checks, not inferred dining privileges.
- **Warren** and **Marciano:** current names, published meal periods and payment methods from the
  [Warren](https://www.bu.edu/dining/location/warren/) and
  [Marciano](https://www.bu.edu/dining/location/marciano/) pages. Warren's retrieved date range is
  October 23–29; Marciano's is October 24–30. Addresses are supported by
  [BU Housing](https://www.bu.edu/housing/living/moving/check-in-locations/) and
  [BU's dining guide](https://www.bu.edu/articles/2026/where-to-eat-when-youre-hungry-at-bu/).
- **West:** [name, address and Claflin entrance](https://www.bu.edu/cpo/project/west-campus-dining-expansion/).
  The large dining page could not be retrieved again; its prior October 24 schedule remains dated as
  before. Current payment and entry details need checking.
- **Fenway:** [BU's directory](https://www.bu.edu/dining/where-to-eat/) still lists Fenway Campus Center
  Dining Room; [BU's location link](https://www.bu.edu/dining/location/fenway/) leads to the operator.
  Current entrance and hours could not be independently confirmed. No directions button is offered.
  The stable `fenway-dining-synthetic` identifier is retained. No closure or relocation is inferred.

Current schedules in `hours.json` remain date-scoped and separate from the October 19 simulation. Amenity flags
stay illustrative, walks are on-device estimates, and the answer says to check hours before a real visit. No
occupancy-to-queue inference or forecast has been added. See [DEMO.md](DEMO.md) for the walkthrough and checks, and
[the five-task usability protocol](team/usability/test_script.md) for the pending student study.

**What COD demonstrates.** Event-based sensor data handled honestly:
- time-weighted averages rather than plain row averages;
- *no data* rather than zero outside the recorded hours;
- its original facility id and source attribution are kept;
- timestamps stay in their unverified source timezone (never forced to New York);
- busyness is relative to the room's own 95th-percentile time-weighted count, because capacity is unknown.

It stays in the data and the API (`/api/facilities/COD_Bosch_Office_1_Clemente/history`) as a data demo; the app never lists or suggests it.

**What the campus gym demonstrates.** Sampled counts (about every 10 minutes) over 535 days, handled honestly:
- timestamps keep the source's UTC offset; weekday and hour are read on that clock, never converted to Boston;
- an explicit gap rule: a reading stands for at most 30 minutes, so overnight pauses and multi-day outages show
  as *no data*, not zero;
- a typical-traffic grid by weekday and hour, time-weighted across all days, with thin hours left blank;
- busyness *relative to this gym's historical traffic* (95th-percentile time-weighted count, 72 people), since
  capacity is unknown; no "% full";
- a week of selectable days (also in static mode) with replay time and observation time shown separately.

In the API it is labeled "Historical gym data — not live and not BU FitRec"; the app never lists or suggests it. To set it up or refresh it:
`python data/import_campus_gym.py --download`, then `python server/export_static.py`
(details, statistics and license in [`data/README.md`](data/README.md#campus-gym-real-historical-reference-not-bu)).
The app runs normally without it.

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

1. **Settings → Pages → Source: GitHub Actions.** Free accounts need a public repo for Pages.
2. Push to `main`.
3. Every push to `main` deploys `web/` (`.github/workflows/pages.yml`) once the checks in `tests.yml` pass.
4. Each deploy also writes `web/version.json` from `main`'s history (`server/write_version.py`): which commit is
   live, shown as "Deployed build" in Version history. The file is generated, not committed; run
   `python server/write_version.py` to preview it locally. It does not set the app's version (see below).
5. Each deploy versions `app/app.css`, `app/app.js` and every local module import (`./` and `../js/`) with the same
   commit key, so a fresh page never mixes old cached scripts with new ones; the service worker (`web/sw.js`) loads
   the page network-first and keeps a copy for offline use.

### Releasing a version

The app's version and release notes live in one file, `web/app/releases.js`, newest first. The first entry is
the current version: it appears as **BU-sy · vX.Y.Z · Version history** at the bottom of every screen, and the
label opens the full history. Nothing else states the version (a test checks this).

1. Pick the number (semantic versioning): **major** for a change that breaks how people used the app (a new
   interface, removed pages), **minor** for new features or substantial improvements, **patch** for fixes and
   small refinements. Not every merge needs a release.
2. Add an entry at the top of `RELEASES`, dated the day it reaches `main`:
   ```js
   { version: "1.2.0", date: "2026-11-02", title: "Short name", summary: "One sentence for students.",
     changes: { Features: ["…"], Improvements: ["…"], Fixes: ["…"], "UI Updates": ["…"] } },   // any of the four
   ```
3. `npm test` checks the entry (semver, newest first, real dates, known categories), then merge to `main`.

Releases 0.1.0–1.0.0 were reconstructed from `main`'s history; each names the commit range it covers.

## What's inside

```
data/      raw + cleaned data, planner samples, sources and cleaning notes (data/README.md)
server/    FastAPI app (main.py), data adapter (sources.py), planner data loader (campus.py),
           analytics.py (busyness, time-weighted averages, playback), clubs.py, static export
web/       the site
           index.html    the app's page            sw.js, manifest.webmanifest  offline support, install
           app/          app.js (screens, routing, motion) · logic.js (pure helpers, tested in Node) ·
                         app.css (Brownstone) · places-geo.json (building points, OSM) · pin-clock.svg
           js/           shared modules: recommend.js (engine) · hours.js · availability.js · schedule.js +
                         ics.js (.ics import) · clubevents.js · source.js (API or static) · prefs.js · clock.js ·
                         ui.js · icons.js · monthview.js
           data/         generated JSON        counter/  on-device people counter    vendor/  ical.js (unmodified)
tests/     test_*.py (pytest), *.test.mjs (node --test), browser/*.spec.js (Playwright)
tools/     check-css.mjs, serve-web.mjs (test server), manual-counting/ pilot tool
DEMO.md    demo runbook: startup, demo sequence, checks, recovery
```

### API
| | |
|---|---|
| `GET /api/campus` | planner data: places, activities, illustrative hours/amenities, sample walking times, scenarios |
| `GET /api/facilities?at=17:30` | all places at a playback time |
| `GET /api/facilities/{id}?at=18:00` | one place |
| `GET /api/facilities/{id}/history?date=YYYY-MM-DD` | one recorded day: observations, hourly averages, typical profile; historical references add playback days, the gap rule and a weekday × hour grid |
| `GET/POST /api/clubs`, `GET /api/clubs/{id}`, `POST …/{id}/edit`, `…/apply`, `…/withdraw` | club directory: sample clubs + student-created (device ID in the `X-BUsy-Device` header or POST body) |
| `GET /api/clubs/{id}/applications`, `POST …/applications/{app_id}/decide` | organizer review (organizer's device token only) |

## Clubs

In the app: browse clubs in *Explore*, open a club, add its next meetings to your calendar, join with your name,
school email (`@bu.edu`) and year, and withdraw. Creating a club and reviewing applications are in the API
(`POST /api/clubs`, `…/applications`) and `web/js/source.js`, not in the app's screens yet. Sample clubs are labeled
and aren't real BU organizations. What it does **not** protect:

- **No accounts.** A device is a random ID kept in the browser: *identification, not authentication*.
  Whoever creates a club is its organizer, and only that device's ID can edit it or review its
  applications. It is sent in POST bodies or the `X-BUsy-Device` header, never in a URL.
- **Applications** (name, school email, year, optional notes) are returned only to the club's organizer,
  and each student only gets their own application back. Tokens are never returned.
- **Static mode (GitHub Pages)** keeps clubs and sign-ups in that one browser, with the same rules
  (`tests/clubs_static.test.mjs`); the server's rules are tested in `tests/test_clubs.py`.
- **Busyness hints** for a meeting time are estimates from the demo campus data, and say so.
- **Run one server process.** Storage is a JSON file (`server/clubs.json`, git-ignored) guarded by an
  in-process lock, so it isn't safe with several uvicorn workers.

## What a real BU pilot would need

1. **Authorized, aggregate occupancy feeds** (e.g. FitRec's existing counts), replacing `server/sources.py`
   while keeping the `Facility` shape. The wording would switch from "demo time" to "last count, N min ago".
   The campus-gym and COD references show the handling such a feed needs (offsets, gaps, unknown capacity),
   but neither says anything about BU: a pilot needs BU's own data, a documented counting method and an
   agreed capacity or reference.
2. **Verified hours**, from published schedules, with `hours_basis: "verified"`. FitRec is tracked as one
   building: per-court, pool or room occupancy, classes and reservations aren't modeled, because no data
   could support them.
3. **Real walking estimates**, from campus routing data or a maps service, replacing `sample_travel_times.csv`.
4. **Verified amenities** (outlets, quiet floors) from the facilities themselves.
5. **Calendar-derived free windows** (opt-in, read-only, processed on device where possible), feeding the
   same request shape.
6. Accessibility review, privacy review and student testing before any claim of accuracy.

## Data sources
- Liu et al., *COD: A Dataset of Commercial Building Occupancy Traces*, Zenodo 2017,
  [doi:10.5281/zenodo.996587](https://doi.org/10.5281/zenodo.996587), CC BY-SA 4.0.
- Nick Rose, *Crowdedness at the Campus Gym*, Kaggle,
  [nsrose7224/crowdedness-at-the-campus-gym](https://www.kaggle.com/datasets/nsrose7224/crowdedness-at-the-campus-gym).
  Contains information from that database, available under the
  [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) (contents: DbCL 1.0). The files
  BU-sy derives from it are shared under the same license.
- Tekler, Ono, Peng, Zhang, Lasternas & Chong, *ROBOD, Room-level Occupancy and Building Operation Dataset*,
  figshare 2022, [doi:10.6084/m9.figshare.19234530](https://doi.org/10.6084/m9.figshare.19234530),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Room 5 counts drive the simulated Mugar values
  (averaged and rescaled: see the Sources page).
- Egeler, *NOVANIMAL aggregated menu sales* (supplementary material to Egeler & Baur 2020, NOVANIMAL Working
  Paper No. 5, ZHAW), Zenodo, [doi:10.5281/zenodo.3890931](https://doi.org/10.5281/zenodo.3890931),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Purchase times drive the simulated dining-hall lunch
  values (grouped into purchases, turned into diners with an assumed meal length and rescaled).
- Simulation models, illustrative capacities and planner samples made by the team.
  Details: [`data/README.md`](data/README.md#simulated-campus-places) and the app's Sources & Simulation page.
- Fonts: IBM Plex Sans (IBM) for the interface and Source Serif 4 (Adobe) for headings and large numbers,
  bundled in `web/assets/fonts/` under the SIL Open Font License 1.1
  ([`OFL-IBMPlexSans.txt`](web/assets/fonts/OFL-IBMPlexSans.txt),
  [`OFL-SourceSerif4.txt`](web/assets/fonts/OFL-SourceSerif4.txt)). They are served with the site, so nothing
  loads from another server; until they arrive, text shows in the system font.

BU's own [Peak & Quiet Hours](https://www.bu.edu/fitrec/peak-quiet-hours/) page already reports FitRec
traffic. BU-sy explores planning around free time, not a replacement for it.
