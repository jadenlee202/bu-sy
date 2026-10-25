# BU-sy

**Make the most of your time between classes.** Tell BU-sy what you want to do (study, eat or work out),
how long you're free, where you are and where you're heading next. It suggests campus places that actually
fit, and shows the arithmetic: *"Fits your 70-minute window: 10 min there + 36-minute workout + 14 min
onward + 10-minute buffer."*

Occupancy supports the decision; it isn't the product. Browsing places, the replayable traffic charts and
unofficial student meetups are still there as secondary screens.

Independent student project, **not affiliated with Boston University**.

> **Data honesty:** every campus place, count, capacity, amenity and walking time is **demo data**
> (labelled *Demo · Synthetic campus data*). Places cards show date-bounded building hours where
> available; unavailable or unpublished hours are called out explicitly. Planner fit calculations
> still use the illustrative schedules in the demo campus data. Two real datasets appear as **historical
> references** under Places: the *Clemente Room*, an office conference room from the public COD dataset, and
> the *Campus Gym — Historical Reference*, 2015–2017 head counts from a non-BU university gym (Kaggle, ODbL).
> They show the pipeline on real recordings, are never presented as live, and are **never** suggested as
> places to go.

## Run it

**Demo day?** Follow [`DEMO.md`](DEMO.md): exact startup, the demo sequence, checks and recovery steps.

Requires **Python 3.12+**. Node 22+ is only needed for the JS tests. There are no accounts, keys or secrets.

**Just the site (no install):**
```bash
python -m http.server 8000 -d web       # macOS/Linux: python3
# open http://localhost:8000
```
It reads the pre-built JSON in `web/data/`; meetups are saved in your browser.

**Operating hours.** Location identity and categories come from `web/data/facilities.json`;
`web/data/campus.json` contains illustrative planner hours, not the displayed verified schedules.
The detail page uses date-scoped building and meal-service schedules from `web/data/hours.json`,
keyed by facility ID. It displays a Monday–Sunday week, lets users select dates and navigate weeks,
and displays named meal-service periods for dining locations while retaining building hours for
other locations. The detail-page building and meal-service status updates with the selected slider
time; Places cards show open/closed status based on the selected slider time. Dates outside a published
schedule are marked unavailable; unverified locations remain explicit. Source and verification
metadata remain in the hours data file and are not linked in the UI.

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

### Optional Google Calendar availability

The Calendar page uses Google's OAuth authorization-code flow with PKCE and the single
`calendar.freebusy` scope. It requests only the primary calendar's busy intervals; event names,
descriptions, attendees, and locations are not read, returned to the browser, or logged. BU-sy
does not send calendar data to an AI service. The API encrypts access and refresh tokens at rest,
keeps them in a private SQLite session database, and exposes only the opaque session cookie to
the browser. Disconnect removes the local session and asks Google to revoke its refresh token.
Daily free-time windows are calculated in the timezone entered on the Calendar page (defaulting
to the browser timezone), then intersected with the date-scoped building and meal-service data in
`web/data/hours.json`. No travel time is estimated.

This feature is **not active on GitHub Pages alone**. To enable it, deploy the FastAPI app over
HTTPS and configure Google Cloud:

1. Enable the Google Calendar API and configure the OAuth consent screen. During development,
   add your account as a test user. Review Google's
   [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) and
   [Calendar FreeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
   documentation. Public use may require Google's OAuth verification for the requested scope.
2. Create a Google OAuth **Web application** client. Add the exact backend callback URL as an
   authorized redirect URI: `https://YOUR_API_HOST/api/calendar/callback`.
3. Set these server environment variables (never put the client secret or encryption key in the
   static frontend or repository):

   ```text
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://YOUR_API_HOST/api/calendar/callback
   CALENDAR_FRONTEND_ORIGIN=https://YOUR_SITE_ORIGIN
   CALENDAR_FRONTEND_URL=https://YOUR_SITE_ORIGIN/optional/site/path/
   CALENDAR_TOKEN_ENCRYPTION_KEY=<Fernet key>
   CALENDAR_SESSION_DB=<private persistent writable path>/calendar.sqlite3
   BUSY_CORS_ORIGINS=https://YOUR_SITE_ORIGIN
   ```

   Generate a Fernet key with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
   Preserve that key and the SQLite database across restarts; losing the key invalidates stored
   sessions. The database file is restricted to owner read/write access. SQLite storage assumes
   one backend instance with a persistent disk. Configure reverse-proxy/access logs to redact
   `/api/calendar/callback` query strings, which contain a short-lived OAuth authorization code;
   the built-in Uvicorn access-log filter also redacts that callback path.
4. On the GitHub Pages URL, open the site with the backend query parameter, for example
   `https://YOUR_SITE/?api=https://YOUR_API_HOST#/calendar`. The callback preserves that API
   parameter. Because browsers may block third-party cookies between GitHub Pages and a separate
   API domain, production deployment should use a custom website domain and an API subdomain under
   the same registrable domain (or serve the frontend and API from the same site). Both must use
   HTTPS.

When the API or OAuth configuration is missing, Calendar shows that connection is unavailable;
all existing static Places and planning features continue to work. No OAuth credentials are
included in this repository. The primary calendar is the only supported calendar in this
implementation.

The footer always names the data source (*built-in demo files* or *BU-sy API*). If a requested API can't be
reached, a notice says so and the built-in demo files are used. Both modes give the same suggestions
(see *Static and API modes* below).

**Try it:** choose an activity and how long you're free; options appear right away. Everything else has
a visible default under **Preferences**. Or open **Try a sample** (70 free minutes at 3 PM, work out, from
Mugar to a class at Warren Towers). The other samples show a best match chosen on evidence (*study, outlets needed*) and a
window where nothing fits, with a one-tap fix the engine has checked.

## Checks

```bash
python -m pytest                        # API, calendar OAuth/freebusy, data loaders + gym import, analytics, events
node --test "tests/*.test.mjs"          # planner engine + static meetups (Node 22+, no packages; or: npm test)
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
**Hours unknown**.

**No starting point.** The starting point is optional. Without it the walk there can't be counted, so the
engine only rules places out (too little time even before walking, closed, missing a need) and lists the rest
as *could work, travel not checked*. It never calls them a fit, shows no leave/arrive times, offers no "would
fit" fixes, and doesn't compare walks when ranking.

**Quick start and remembered settings.** Only the activity and free time are required. The rest has visible
defaults under **Preferences**: start time (the demo clock), next stop (none), minimum (per activity), buffer,
ranking and study needs. Values you change by hand, and your last chosen starting point, are kept in this
browser (`localStorage`, see [`web/js/prefs.js`](web/js/prefs.js)) and shown as *Last selected*, never as your
current location. The next stop isn't kept, so a stale one can't silently add an onward walk. **Reset
preferences** restores every default. Sample scenarios never change what's remembered. Results update after
each choice; typed numbers update after a short pause, and errors appear only once you leave the field.

**Ranking.** Comparisons are lexicographic and documented in the code:
1. Your preference: busyness level if you chose *quieter*; total sample walking if you chose *shorter walks*;
   if neither, more activity time.
2. Then, in order: busyness level, walking, activity time, and study amenities listed.
3. Then name and id, so results are reproducible.

Busyness is compared by **level** (quiet < moderate < *unavailable* < busy), not by exact percentage,
because capacities are illustrative. A place with no count is never treated as quiet.

**Best match.** This label appears only when something other than the alphabetical tie-break separates
#1 from #2, and never when #1's busyness is unavailable. Otherwise the app says the options are equal.

**Busyness wording.** Labels are tied to the count's time: *"Quiet at 3:00 PM"* (next to a *Demo* data
chip) or *"No busyness data"*. There's no forecasting for your arrival time, and campus places have no
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
| `data/clean_campus_gym_occupancy.csv` | a non-BU campus gym, imported by `data/import_campus_gym.py` (optional) | real gym data, not BU |

`server/campus.py` validates the planner data at startup:
- every place must point to an existing campus-eligible (**synthetic**) facility or area, so COD and the
  campus gym can't be added (`campus_eligible: false` in the API);
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

**What the campus gym demonstrates.** Sampled counts (about every 10 minutes) over 535 days, handled honestly:
- timestamps keep the source's UTC offset; weekday and hour are read on that clock, never converted to Boston;
- an explicit gap rule: a reading stands for at most 30 minutes, so overnight pauses and multi-day outages show
  as *no data*, not zero;
- a typical-traffic grid by weekday and hour, time-weighted across all days, with thin hours left blank;
- busyness *relative to this gym's historical traffic* (95th-percentile time-weighted count, 72 people), since
  capacity is unknown; no "% full";
- a week of selectable days (also in static mode) with replay time and observation time shown separately.

It is labelled "Historical gym data — not live and not BU FitRec." To set it up or refresh it:
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
             plan.js       "What fits now?" screen     prefs.js  remembered planner settings
             app.js        router, Places, playback, meetups, About
             source.js     data adapter (API or static)   clock.js / ui.js / icons.js  helpers
           data/ (generated)
tests/     test_api.py, test_campus_gym.py (pytest); recommend / plan_prefs / clock / meetups_static .test.mjs (node --test)
DEMO.md    demo runbook: startup, demo sequence, checks, recovery
```

### API
| | |
|---|---|
| `GET /api/campus` | planner data: places, activities, illustrative hours/amenities, sample walking times, scenarios |
| `GET /api/facilities?at=17:30` | all places at a playback time |
| `GET /api/facilities/{id}?at=18:00` | one place (+ FitRec areas and sample class reservations) |
| `GET /api/facilities/{id}/history?date=YYYY-MM-DD` | one recorded day: observations, hourly averages, typical profile; historical references add playback days, the gap rule and a weekday × hour grid |
| `GET /api/schedule`, `GET /api/programs` | **sample** official schedule (placeholders) |
| `GET/POST /api/community-events`, `POST …/{id}/join`, `…/leave`, `…/cancel` | unofficial student meetups (device ID in the `X-BUsy-Device` header or POST body) |

## Meetups (unofficial, secondary)

Students can post things like "basketball run, court 4". It's kept deliberately simple, and here is what it
does **not** protect:

- **No accounts.** A person is a nickname plus a random device ID kept in their browser. That ID is
  *identification, not authentication*: anyone holding it can act as that device. It is sent in POST bodies
  or the `X-BUsy-Device` header, never in a URL, so it stays out of server logs.
- **Invite only means "a code is needed to join"; it is not private.** Every event's title, place and time
  are visible to everyone using the server. Codes (8 characters from 32 symbols, ~10¹² combinations) are
  returned only to the host and compared in constant time. There's no HTTPS locally, so don't use it for
  anything sensitive.
- **Static mode (GitHub Pages)** keeps meetups in that one browser. Nobody else can see or join them, and
  the screens say so.
- **The server enforces the rules:**
  - only the host can cancel, and you can only leave yourself;
  - joining twice is a no-op;
  - capacity holds under concurrent joins (200 max when no limit is set);
  - ended or cancelled events can't be joined;
  - text is trimmed and length-limited, and control characters are refused;
  - dates must be in the future and at most 60 days ahead;
  - at most 300 upcoming events, and old ones are pruned;
  - saves are atomic.

  Static mode follows the same rules (`tests/meetups_static.test.mjs`).
- **Run one server process.** Storage is a JSON file guarded by an in-process lock, so it isn't safe with
  several uvicorn workers.

## What a real BU pilot would need

1. **Authorized, aggregate occupancy feeds** (e.g. FitRec's existing counts), replacing `server/sources.py`
   while keeping the `Facility` shape. The wording would switch from "demo time" to "last count, N min ago".
   The campus-gym and COD references show the handling such a feed needs (offsets, gaps, unknown capacity),
   but neither says anything about BU: a pilot needs BU's own data, a documented counting method and an
   agreed capacity or reference.
2. **Verified hours and closures**, from published schedules, with `hours_basis: "verified"`.
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
- Synthetic campus data and planner samples made by the team. Details: [`data/README.md`](data/README.md).
- Interface font: Plus Jakarta Sans (Tokotype), bundled in `web/assets/fonts/` under the SIL Open Font
  License 1.1 ([`OFL.txt`](web/assets/fonts/OFL.txt)). It is served with the site, so nothing loads from
  another server; until it arrives, text shows in the system font.

BU's own [Peak & Quiet Hours](https://www.bu.edu/fitrec/peak-quiet-hours/) page already reports FitRec
traffic. BU-sy explores planning around free time, not a replacement for it.
