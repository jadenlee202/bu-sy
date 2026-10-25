# BU-sy

**Make the most of your time between classes.** Tell BU-sy what you want to do (study, eat or work out),
how long you're free, where you are and where you're heading next. It suggests campus places that actually
fit, and shows the arithmetic: *"Fits your 80-minute window: 10 min there + 5 min preparation +
36-minute workout + 5 min cleanup + 14 min onward + 10-minute buffer."* Choose a feasible option to
see when to depart, prepare, do the activity, pack up and reach the next destination.

Occupancy supports the decision; it isn't the product. Browsing places, the replayable traffic charts and
a student club directory are still there as secondary screens.

**Live demo:** https://jadenlee202.github.io/bu-sy/ · People counter: https://jadenlee202.github.io/bu-sy/counter/

Independent student project, **not affiliated with Boston University**.

> **Data honesty:** busyness at BU-named places is **simulated** (labeled *Simulated*): FitRec follows one
> recorded day at a real campus gym elsewhere; Mugar follows people counts in one small library room in
> Singapore (ROBOD); dining halls follow canteen purchases in Switzerland at lunch (NOVANIMAL), turned into
> diners with an assumed 30-minute meal, while breakfast and dinner stay modeled. All of it is rescaled to
> illustrative sizes. Capacities, amenities and walking times are illustrative. Places cards and place
> pages show date-bounded building and meal-service hours from official BU pages where available
> (`web/data/hours.json`); unavailable or unpublished hours are called out explicitly. The planner uses
> those verified hours for the demo day when they cover it, and otherwise the illustrative schedules in the
> demo campus data, and says which one decided each fit. The
> **Sources & Simulation** page (`#/sources`) maps every place to its source. Two real datasets appear as **historical
> references** under Places: the *Clemente Room*, an office conference room from the public COD dataset, and
> the *Campus Gym — Historical Reference*, 2015–2017 head counts from a non-BU university gym (Kaggle, ODbL).
> They show the pipeline on real recordings, are never presented as live, and are **never** suggested as
> places to go.

## Run it

**Demo day?** Follow [`DEMO.md`](DEMO.md): exact startup, the demo sequence, checks and recovery steps.

Requires **Python 3.12+**. Node 22+ is needed for the JS/CSS and browser tests; see
[`LAYOUT_CHECKS.md`](LAYOUT_CHECKS.md) for setup and the enforced phone-frame contract.
There are no accounts, keys or secrets.

**Just the site (no install):**
```bash
python -m http.server 8000 -d web       # macOS/Linux: python3
# open http://localhost:8000
```
It reads the pre-built JSON in `web/data/`; clubs and club sign-ups are saved in your browser.

**Operating hours.** Location identity and categories come from `web/data/facilities.json`;
`web/data/campus.json` contains illustrative planner hours, used only as a fallback when no verified schedule covers the planning date.
The detail page uses date-scoped building and meal-service schedules from `web/data/hours.json`,
keyed by facility ID. It displays a Monday–Sunday week, lets users select dates and navigate weeks,
and displays named meal-service periods for dining locations while retaining building hours for
other locations. The weekly card's building and meal-service status updates with the selected slider
time for the date selected in the card. Next to a busyness value (Places cards and the place page's count),
open/closed uses the verified hours for the **replayed day** (the sample Monday, Oct 19, 2026), not today,
so the count and the status describe the same day; when those hours say closed, the place shows Closed
instead of a simulated count. Without verified hours for that date, the illustrative sample hours decide
Closed only when there is no count. Dates outside a published schedule are marked unavailable; unverified
locations remain explicit. The facility-details disclosure links field-level official sources,
independently of occupancy provenance. The current home
screen is the planner; Places, Calendar and Clubs are secondary navigation destinations.

**With the API** (clubs and sign-ups shared between everyone using the server):
```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt          # macOS/Linux: .venv/bin/python
.venv\Scripts\python -m uvicorn main:app --app-dir server --reload
# open http://127.0.0.1:8000   (API docs at /docs)
```
This runs from the repo root and doesn't need `activate`, which PowerShell often blocks.
The site detects the API automatically. To use an API on another host, add `?api=https://host` to the URL.
The API allows cross-origin requests (`BUSY_CORS_ORIGINS` restricts them). Cookies are only
allowed across origins for the exact origins listed there, which the Google Calendar session needs
when the site and API are on different origins.

Current operating-hour cards may repeat a published weekly pattern outside its dates, labeled Assumed. Fenway opts out. These assumptions do not establish historical operating hours for the replay.

### Calendar: your .ics schedule

The Calendar page lets a student upload a calendar file (`.ics`, exported from Google Calendar,
Apple Calendar, Outlook or any iCalendar app). There is no sign-in and no calendar account
connection. The file is parsed **in the browser** with [ical.js](https://github.com/kewisch/ical.js)
2.2.1 (MPL-2.0, vendored unmodified in `web/vendor/`), and never sent to a server or AI service.

- **What's kept:** merged busy intervals (start/end instants) for free time; each event
  occurrence's title, start, end and all-day/free flags for the calendar view; the file name,
  import counts and the date range covered. Never the file, descriptions, locations or attendees.
  By default this lives in `sessionStorage` (cleared when the tab closes); *Remember my schedule
  on this device* moves it to `localStorage`. *Clear calendar* deletes it from both.
- **Validation:** `.ics` name (or `text/calendar` type), at most 2 MB, and contents must start
  with `BEGIN:VCALENDAR` and parse. A failed upload, or a valid calendar with no events, never
  replaces the previous schedule. The import reports events imported and entries skipped (no
  start, no end/duration, end before start, unknown timezone, unsupported repeat rule).
- **Times:** a `TZID` is used as written (IANA names via the browser's timezone data; other
  names such as Outlook's `Eastern Standard Time` via the file's own `VTIMEZONE`), UTC stays UTC,
  and floating times and all-day dates use America/New_York. Weekly classes keep their local time
  across daylight-saving changes. Recurrence rules, `EXDATE`, moved occurrences (`RECURRENCE-ID`)
  and cancellations are honored; events marked free (`TRANSP:TRANSPARENT`, Outlook *Free*) and
  cancelled events aren't busy. Occurrences are expanded from 31 days before the import to 366 days
  after it; dates outside that range are shown as unknown, never as free.
- **No upload = empty schedule:** without an uploaded file, the Calendar page, the place cards and
  the Places free-time filters treat the student as free for the whole preferred window (8 AM–10 PM
  by default), and each of them says so. Dates outside an uploaded file's range stay unknown.
- **Free time** is the gap between merged busy blocks inside your preferred hours, at least your
  minimum length, intersected with the date-scoped building and meal-service hours in
  `web/data/hours.json`. No travel time is estimated.
- **Club events:** a club's page lists its next four regular meetings (from its weekly day and
  times; extra meetings have no time, so they're listed but can't be added) with *Add to Calendar*,
  and the Clubs list offers the next one. Added meetings are stored apart from the .ics file
  (`busy.clubEvents.v1` in this browser, keyed by club + date so they can't be added twice), show in
  the calendar as club events, and count as busy everywhere free time is worked out. Uploading,
  replacing or clearing the imported file never touches them; each is removed on its own. When a
  club's schedule changes, saved meetings follow it (new times) or are flagged (dropped day or club).
- **Calendar view:** the Calendar tab always shows a month grid (empty until a file is imported)
  with previous/next month and *Today*. Weeks start on Sunday; *Week starts* switches to Monday
  (saved in this browser). Imported events appear on every date they
  cover, in the display timezone (all-day events on their calendar dates); free events are shown
  dashed and aren't busy. Clicking a date (or an event) selects that day: its events are listed
  below the grid, and the date control and free-time results switch to the same day. On narrow
  screens cells show an event count and the day's list holds the details. Replacing the file
  replaces the events (no merging); *Clear calendar* deletes events and busy times together.

The server still contains the earlier Google Calendar free/busy integration (`server/google_calendar.py`,
`/api/calendar/*`), but the Calendar page no longer uses it: availability comes from an uploaded `.ics`
file, handled in the browser.

Each place's detail page has a *Find a time to eat* (dining) or *Find free time here* card that
searches 7 days from a chosen date. On Places, *Open now* uses published hours; with a schedule
uploaded, *Open during my free time* filters by date and minimum length. Places whose hours can't be checked are listed as
unchecked rather than hidden, and historical references are never suggested.

The footer always names the data source (*built-in demo files* or *BU-sy API*). If a requested API can't be
reached, a notice says so and the built-in demo files are used. Both modes give the same suggestions
(see *Static and API modes* below).

**Try it:** choose an activity and how long you're free; options appear right away. Everything else has
a visible default under **Preferences**. Or open **Try a sample** (80 free minutes at 3 PM, work out, from
Mugar to a class at Warren Towers). The other samples show a best match chosen on evidence (*study, outlets needed*) and a
window where nothing fits, with a one-tap fix the engine has checked.

**Minimal prototype** (branch `proto/minimal-brownstone`): open `http://localhost:8000/proto.html`. The planner as
one sentence ("I have **1 hr** to **study**, starting from **Mugar Library**"), in the Brownstone palette, with three
tabs (Plan, Schedule, Explore), a first-run guide, press feedback and page transitions (off under reduced motion).
It uses the same engine, data, verified hours, `.ics` import and saved club meetings as the main app, so both see
the same schedule. Its own settings (onboarding, access, start and next stop) live under `busy.proto.v1` in this browser.

**People counter** (camera, on-device): open `http://localhost:8000/counter/`. It counts people crossing a line
and never uploads video. It's a prototype for producing real counts; nothing in the planner uses it yet.
Setup, model download and how it works: [`web/counter/README.md`](web/counter/README.md).

## Checks

```bash
python -m pytest                        # API, clubs, hours, calendar OAuth/freebusy, data loaders + gym import, analytics
npm ci                                  # dev tools only (PostCSS, Playwright); Node 22+
npm run check:css                       # strict CSS parse + merge-conflict markers
npm test                                # planner engine, static clubs, .ics import + free time, CSS validator, people counter
npx playwright install chromium
npm run test:browser                    # phone-frame layout, motion and service worker in Chromium
```
CI runs all of them (`.github/workflows/tests.yml`), and the Pages deploy waits for them.
`npm test` needs `npm ci` first: the CSS validator test runs PostCSS.

## How "What fits now?" works

The rules live in one file, [`web/js/recommend.js`](web/js/recommend.js). They are deterministic, with no ML,
no randomness and no clock reads, and the same code runs in the browser and in the Node tests.

**The window.** It starts at the selected time (the demo clock by default) and ends at your next commitment.
Enter it either as **How long** (a preset, or **Other** in minutes or decimal hours: 1.5 hours = 90 minutes,
rounded to the nearest minute; `start + free minutes`) or **Until next class** (the time
your next class or commitment starts; free minutes = that time − start). Both feed the same engine
(`normalizeRequest` in `recommend.js`). The next-class time must be later the same day: a time at or before
the start is rejected, never wrapped to tomorrow, because the demo models one day. Switching modes carries a
valid window across (45 min from 5:30 PM ⇄ until 6:15 PM) and otherwise keeps what each mode had; samples
switch back to **How long**. The buffer is kept free just before the boundary, once.

**Fit rule.** A place fits only if
`free minutes ≥ walk there + preparation + activity time + cleanup + walk onward + buffer`
and `activity time ≥ your minimum`.
Each part is counted once, and the parts shown always add up to the window. With no next stop, onward travel
isn't counted, and the app says so.

**Before ranking, a place is excluded when:**
- it doesn't support the activity;
- it lacks a study need you required (an amenity that isn't listed is treated as unknown, not as present);
- the sample walking time is missing (unknown, never zero; the same location is zero);
- there isn't enough time;
- it is closed during any part of the visit. If a place opens a little later, the visit waits for
  opening; if it closes early, the unused minutes are shown. Preparation and cleanup must both occur
  inside the visit's opening interval.
- the student says they do not meet the listed access requirements. Unknown eligibility appears under
  **Check access**, with no choose action until the student confirms it for this session.

**Which hours decide "open".** The planner plans for the **demo day**, the date the simulated occupancy
replays (Mon, Oct 19, 2026, read from the histories), and looks hours up for that same date
(`planningHours` in `recommend.js`, using `daySchedule` from `web/js/hours.js`):
- **Verified** when `hours.json` has `status: "verified"` and the date is inside `effectiveFrom`–
  `effectiveThrough`, or is a listed special date (special closures and adjusted hours win). Weekly hours
  alone never count as verified. Eating at a dining hall uses the **meal-service** periods (kept inside
  verified building hours); studying or working out uses **building** hours.
- Otherwise the **illustrative** demo hours from the campus data, labeled as not official, with the reason
  (for example *BU hours not published for Monday, Oct 19*).
- With neither, hours are **unknown** and the place goes to *Hours unknown*, never a confirmed fit.

Which verified hours cover the demo day depends on the date ranges in `web/data/hours.json`; each card and
each *closed* reason names the hours that decided it. Overnight periods are cut at midnight, since the
planner models one day.

**Unknown hours.** A place that fits on time but has no hours is never shown as confirmed. It appears under
**Hours unknown**.

**No starting point.** The starting point is optional. Without it the walk there can't be counted, so the
engine only rules places out (too little time even before walking, closed, missing a need) and lists the rest
as *could work, travel not checked*. It never calls them a fit, shows no leave/arrive times, offers no "would
fit" fixes, and doesn't compare walks when ranking.

**Quick start and remembered settings.** Only the activity and free time are required. The rest has visible
defaults under **Preferences**: start time (the demo clock), next stop (none), minimum (per activity), buffer,
ranking, preparation, cleanup and study needs. Values you change by hand, and your last chosen starting point, are kept in this
browser (`localStorage`, see [`web/js/prefs.js`](web/js/prefs.js)) and shown as *Last selected*, never as your
current location. The next stop isn't kept, so a stale one can't silently add an onward walk. **Reset
preferences** restores every default. Sample scenarios never change what's remembered. Results update after
each choice; typed numbers update after a short pause, and errors appear only once you leave the field.

Preparation/cleanup defaults are editable allowances: study **3 + 2**, eat **5 + 2**, work out **5 + 5**
minutes. These are not measured service or queue times. A 35-minute workout means 35 minutes of activity.
They are stored per activity in the existing `busy.plan.prefs.v1` key as `preparationByActivity` and
`cleanupByActivity`; older saved settings receive the new defaults. Access responses and selected plans
are session-only. No identities or new backend persistence are introduced.

**Choose and follow a plan.** For a confirmed illustrative time fit, **Choose this plan** shows the
engine's evaluated preparation/activity/cleanup intervals, latest departure, onward arrival (if supplied),
and protected buffer. **Change plan** returns to options; **Edit inputs** opens settings while preserving
inputs. Any input edit immediately invalidates the selection, including during the typing debounce.
There is no reservation, guaranteed access, countdown, notification or calendar write.

**Directions.** An external walking-directions link is offered only for a separately verified address.
The starting point in BU-sy is manually chosen; the mapping service can use a different origin or route.
It does not validate the app's sample walking allowances. No automatic location permission is requested.

**Ranking.** Comparisons are lexicographic and documented in the code:
1. Your preference: busyness if you chose *quieter*; total sample walking if you chose *shorter walks*;
   if neither, more activity time.
2. Then, in order: busyness, walking, activity time, and study amenities listed.
3. Then name and id, so results are reproducible.

Busyness is compared by **level** (quiet < moderate < *unavailable* < busy), not by exact percentage,
because capacities are illustrative. A place with no count is never treated as quiet.

**Busyness during the visit.** With a starting point, the engine knows the estimated visit (arrive → leave by,
from the sample walk and the hours) and reads the simulated history minute by minute across it, with the same
rule as the snapshot (latest value, coverage end, maximum hold). The profile (`visitProfile`) keeps minutes
per level and every change in order, so *"Quiet, then busy during your visit"* isn't flattened to one word.
Minutes the history doesn't cover are *no simulated data*: never zero, never quiet. Ranking then uses the
profile's time-weighted level (unavailable still ranks between moderate and busy) instead of the departure
snapshot, and the reasons say *"during the planned visit (simulated)"*. Without a starting point or route, no
visit is estimated and nothing is claimed about it; ranking falls back to the departure-time level.

**Best match.** This label appears only when something other than the alphabetical tie-break separates
#1 from #2, and never when #1's busyness is unavailable. Otherwise the app says the options are equal.

**Busyness wording.** Cards keep three things apart: the departure-time count (*"Quiet at 3:00 PM (when you
leave)"*), the estimated visit interval, and the simulated profile over it. It's simulated BU-named data,
not live occupancy and not a forecast, and campus places have no multi-day history that could support
"historically quieter".

**Nothing fits.** The app says why (grouped reasons, plus a per-place list) and offers changes such as a
longer window, a shorter minimum, another activity or dropping a requirement. It suggests a change only
after re-running the engine to confirm it would really fit. The form keeps your inputs.

### Inputs designed for later
A request is `{activity, start, minutes, mode, until, date, source, from, to, minActivity, buffer,
preparation, cleanup, access, preferQuiet, preferShortTravel, needs}`. Missing allowances receive activity
defaults; `access` records session-only self-confirmation for library, fitness and dining requirements;
`mode`, `until` and `date` are optional (see the top of `recommend.js`).
- **`source`** is `"manual"` today. A future calendar integration would set `source: "calendar"` and fill
  `start`/`minutes` from the gap before the next event, and `to` from that event's location.
- **`from`** is always chosen by the student. A calendar event is never taken as proof of where someone is,
  and there is no location tracking.

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

Current schedules in `hours.json` remain date-scoped and separate from the October 19 historical/demo
simulation. The planner deliberately continues to label its Monday hours, walking allowances and amenity
flags illustrative. The chosen view repeats this limitation; a real visit requires checking current hours.
No occupancy-to-queue inference or forecast has been added.

The ordering rules are unchanged: preference keys, then busyness level, total walking, activity time,
study amenities, name and stable ID. Numeric comparison explanations use actual evaluated differences;
busyness comparisons explicitly say **in the simulation**. Unknown occupancy remains useful for planning
but never receives a best-match badge. See [DEMO.md](DEMO.md) for the complete walkthrough and actual checks,
and [the five-task usability protocol](team/usability/test_script.md) for the pending student study.

**What COD demonstrates.** Event-based sensor data handled honestly:
- time-weighted averages rather than plain row averages;
- *no data* rather than zero outside the recorded hours;
- its original facility id and source attribution are kept;
- timestamps stay in their unverified source timezone (never forced to New York);
- busyness is relative to the room's own 95th-percentile time-weighted count, because capacity is unknown.

It lives in **Places** as a data demo and is excluded from campus suggestions.

**What the campus gym demonstrates.** Sampled counts (about every 10 minutes) over 535 days, handled honestly:
- timestamps keep the source's UTC offset; weekday and hour are read on that clock, never converted to Boston;
- an explicit gap rule: a reading stands for at most 30 minutes, so overnight pauses and multi-day outages show
  as *no data*, not zero;
- a typical-traffic grid by weekday and hour, time-weighted across all days, with thin hours left blank;
- busyness *relative to this gym's historical traffic* (95th-percentile time-weighted count, 72 people), since
  capacity is unknown; no "% full";
- a week of selectable days (also in static mode) with replay time and observation time shown separately.

It is labeled "Historical gym data — not live and not BU FitRec." To set it up or refresh it:
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
4. Each deploy also writes `web/version.json` from `main`'s history (`server/write_version.py`), so the
   **version note** in the page's corner (bottom right on wide screens, under the footer on phones) shows the
   new version and opens the full history. Every merge or direct commit on `main` is one version. The file is
   generated, not committed; run `python server/write_version.py` to preview it locally.
5. Each deploy versions the stylesheet, entry module and all local module imports with the same commit key,
   so a fresh page never mixes old cached scripts with new ones.

## What's inside

```
data/      raw + cleaned data, planner samples, sources and cleaning notes (data/README.md)
server/    FastAPI app (main.py), data adapter (sources.py), planner data loader (campus.py),
           analytics.py (busyness, time-weighted averages, playback), clubs.py, static export
web/       the site: index.html, styles.css, js/
             recommend.js  planner engine (single source of truth)
             plan.js       "What fits now?" screen     prefs.js  remembered planner settings
             app.js        router, Places, playback, About   clubs.js  club directory
             calendar.js / findtime.js  availability   ics.js / schedule.js  .ics import (in the browser)
             source.js     data adapter (API or static)   clock.js / ui.js / icons.js  helpers
           data/ (generated)
           counter/      on-device people counter (detector, tracker, line crossing)
           proto.html, proto/  minimal one-sentence prototype (Brownstone)
           sw.js, manifest.webmanifest  offline support and install metadata
           vendor/       ical.js (unmodified)
tests/     test_*.py (pytest), *.test.mjs (node --test), browser/*.spec.js (Playwright)
tools/     check-css.mjs, serve-web.mjs (test server), manual-counting/ pilot tool
DEMO.md    demo runbook: startup, demo sequence, checks, recovery
LAYOUT_CHECKS.md  phone-frame contract and browser regression checks
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

## Clubs (secondary)

A directory of student clubs: browse and filter, view details, sign up, see *My clubs*, and (for a
club's creator) edit it and approve, decline or waitlist applications. Sample clubs are labeled and
aren't real BU organizations. What it does **not** protect:

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
