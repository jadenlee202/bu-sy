# BU-sy

**Make the most of your time between classes.** Tell BU-sy what you want to do (study, eat or work out),
how long you're free, where you are and where you're heading next. It suggests campus places that actually
fit, and shows the arithmetic: *"Fits your 80-minute window: 10 min there + 5 min preparation +
36-minute workout + 5 min cleanup + 14 min onward + 10-minute buffer."* Choose a feasible option to
see when to depart, prepare, do the activity, pack up and reach the next destination.

Occupancy supports the decision; it isn't the product. Browsing places, the replayable traffic charts and
unofficial student meetups are still there as secondary screens.

Independent student project, **not affiliated with Boston University**.

> **Data honesty:** busyness at BU-named places is **simulated** (labelled *Simulated*): FitRec follows one
> recorded day at a real campus gym elsewhere; Mugar follows people counts in one small library room in
> Singapore (ROBOD); dining halls follow canteen purchases in Switzerland at lunch (NOVANIMAL), turned into
> diners with an assumed 30-minute meal, while breakfast and dinner stay modeled. All of it is rescaled to
> illustrative sizes. Capacities, amenities and walking times are illustrative. Places cards and place
> pages show date-bounded building and meal-service hours from official BU pages where available
> (`web/data/hours.json`); unavailable or unpublished hours are called out explicitly, and planner fit
> calculations still use the illustrative schedules in the demo campus data. The
> **Sources & Simulation** page (`#/sources`) maps every place to its source. Two real datasets appear as **historical
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
other locations. The weekly card's building and meal-service status updates with the selected slider
time for the date selected in the card. Next to a busyness value (Places cards and the place page's count),
open/closed uses the verified hours for the **replayed day** (the sample Monday, Oct 19, 2026), not today,
so the count and the status describe the same day; when those hours say closed, the place shows Closed
instead of a simulated count. Without verified hours for that date, the illustrative sample hours decide
Closed only when there is no count. Dates outside a published schedule are marked unavailable; unverified
locations remain explicit. The facility-details disclosure links field-level official sources,
independently of occupancy provenance. The current home
screen is the planner; Places and Meetups remain secondary navigation destinations.

**With the API** (meetups shared between everyone using the server):
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

Current operating-hour cards may repeat a published weekly pattern outside its dates, labelled Assumed. Fenway opts out. These assumptions do not establish historical operating hours for the replay.

### Optional Google Calendar availability

**Sample-week preview:** open **Calendar** (or the sample-week link on the planner). It defaults to the
supplied October 25–31, 2026 screenshot, in `America/New_York` (GMT-04), and works on GitHub Pages without
a calendar server. Pick any day to see the shared availability engine calculate free windows and campus
hour matches. Class blocks with cropped ends use a labelled 50-minute estimate; Saturday's code review
uses a labelled 15-minute estimate. Halloween is informational and does not block the day. Overlapping
Wednesday commitments count once. Dates outside that week stay unknown, and the sample replays the full
day without filtering against today's clock. No sample titles, locations or intervals are sent to Google,
and preview choices do not overwrite personal calendar preferences. Turn off **Use sample schedule** to
return to the normal connection flow. The source fixture is `web/js/sample-schedule.js`.

Each Pages deployment versions the stylesheet, entry module and all local module imports with the same
commit key, preventing a fresh page from mixing old cached scripts with the new preview.

The Calendar page uses Google's OAuth authorization-code flow with PKCE and the single
`calendar.freebusy` scope. It requests only the primary calendar's busy intervals; event names,
descriptions, attendees, and locations are not read, returned to the browser, or logged. BU-sy
does not send calendar data to an AI service. The API encrypts access and refresh tokens at rest,
keeps them in a private SQLite session database, and exposes only the opaque session cookie to
the browser. Disconnect removes the local session and asks Google to revoke its refresh token.
Daily free-time windows are calculated in the timezone entered on the Calendar page (defaulting
to the browser timezone), then intersected with the date-scoped building and meal-service data in
`web/data/hours.json`. No travel time is estimated.
Each place's detail page has a *Find a time to eat* (dining) or *Find free time here* card that
searches the next 7 days in one FreeBusy request and lists windows where you're free, the
building is open and, for dining, the chosen meal is being served. Without a connection the
Calendar page shows an empty day with no events (it never assumes you're free) alongside the
selected location's published hours. Calendar settings (window, minimum, timezone, location) are
saved in the browser; busy times never are.
On Places, *Open now* filters by each place's published hours. With Google Calendar connected,
*Open during my free time* and *Serving lunch/dinner during my free time* filter by a chosen date
and minimum length. Places whose hours aren't verified for that date are listed as unchecked
rather than hidden, and historical references are never suggested.

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
   one backend instance with a persistent disk. Calendar endpoints that reach Google or write sessions
   (`connect`, `callback`, `freebusy`, `disconnect`) are rate-limited to 30 requests per minute per
   session (or client address), counted in memory per process; behind a reverse proxy run Uvicorn
   with `--proxy-headers` so client addresses are real. Temporary Google
   failures (network errors, 5xx, rate limits) are retried twice with backoff, and authorizations
   left unfinished expire after 10 minutes. Configure reverse-proxy/access logs to redact
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
a visible default under **Preferences**. Or open **Try a sample** (80 free minutes at 3 PM, work out, from
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
`free minutes ≥ walk there + preparation + activity time + cleanup + walk onward + buffer`
and `activity time ≥ your minimum`.
Each part is counted once, and the parts shown always add up to the window. With no next stop, onward travel
isn't counted, and the app says so.

**Before ranking, a place is excluded when:**
- it doesn't support the activity;
- it lacks a study need you required (an amenity that isn't listed is treated as unknown, not as present);
- the sample walking time is missing (unknown, never zero; the same location is zero);
- there isn't enough time;
- it is closed during any part of the visit (illustrative hours). If a place opens a little later, the
  visit waits for opening; if it closes early, the unused minutes are shown. Preparation and cleanup
  must both occur inside the visit's opening interval.
- the student says they do not meet the listed access requirements. Unknown eligibility appears under
  **Check access**, with no choose action until the student confirms it for this session.

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
A request is `{activity, start, minutes, source, from, to, minActivity, buffer, preparation, cleanup,
access, preferQuiet, preferShortTravel, needs}`. Missing allowances receive activity defaults;
`access` records session-only self-confirmation for library, fitness and dining requirements.
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
4. Each deploy also writes `web/version.json` from `main`'s history (`server/write_version.py`), so the
   **version note** in the page's corner (bottom right on wide screens, under the footer on phones) shows the
   new version and opens the full history. Every merge or direct commit on `main` is one version. The file is
   generated, not committed; run `python server/write_version.py` to preview it locally.

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
| `GET /api/facilities/{id}?at=18:00` | one place |
| `GET /api/facilities/{id}/history?date=YYYY-MM-DD` | one recorded day: observations, hourly averages, typical profile; historical references add playback days, the gap rule and a weekday × hour grid |
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
2. **Verified hours**, from published schedules, with `hours_basis: "verified"`. FitRec is tracked as one
   building: per-court, pool or room occupancy, classes and reservations aren't modelled, because no data
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
- Interface font: Plus Jakarta Sans (Tokotype), bundled in `web/assets/fonts/` under the SIL Open Font
  License 1.1 ([`OFL.txt`](web/assets/fonts/OFL.txt)). It is served with the site, so nothing loads from
  another server; until it arrives, text shows in the system font.

BU's own [Peak & Quiet Hours](https://www.bu.edu/fitrec/peak-quiet-hours/) page already reports FitRec
traffic. BU-sy explores planning around free time, not a replacement for it.
