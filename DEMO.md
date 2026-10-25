# BU-sy demo runbook

Checks (October 25, 2026): 167 Python, 206 JavaScript and 18 Chromium browser tests pass locally,
and CI runs the same suites on every push; the Pages deploy waits for them. The browser tests drive the app's
flows (onboarding, planning from a simulated location, location refused, nothing fits, schedule import, Explore,
place and club pages, About, directions), check that no screen scrolls sideways from 320 to 1280 px, and test the
service worker. Firefox, Safari and physical phones remain unverified.
Historical browser reports in section 4 below belong to older builds and are not new verification.

## 0. Before the demo (once, with internet)

| Need | Version | Used for |
|---|---|---|
| Python | 3.12 or newer (verified 3.14; CI uses 3.12) | the site's local server, the API, pytest |
| Node | 22 or newer (verified 22 and 24; CI uses 22) | **only** the JS, CSS and browser tests; not needed to run the app |
| Browser | any current Chromium/Edge (verified); Firefox/Safari *not verified* | the app |

```bash
git clone https://github.com/jadenlee202/bu-sy.git
cd bu-sy
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python -m pip …
.venv\Scripts\python -m pytest -q                           # expect 167 passed
npm ci                                                      # dev tools for the JS checks
npm test                                                    # expect 206 passed
```
No API keys, accounts or secrets are needed. `.env` files are ignored by git anyway.

## 1. Start (pick one)

**A. Static, recommended for the demo.** There's no backend to crash and it needs no install:
```bash
python -m http.server 8000 -d web
```
Open http://localhost:8000. Location works here because it is `localhost`.

**B. With the API** (clubs and sign-ups are then shared between devices):
```bash
.venv\Scripts\python -m uvicorn main:app --app-dir server --port 8000
```
Open http://localhost:8000. Club sign-ups now go to the server. API docs are at `/docs`.
This command works from the repo root and doesn't need `activate`, which PowerShell often blocks.

**On a phone (same Wi-Fi).** Add `--bind 0.0.0.0` (option A) or `--host 0.0.0.0` (option B), then open
`http://<laptop-ip>:8000` on the phone. Windows may ask to allow Python through the firewall.
Browsers only share location with `https://` or `localhost`, so on a LAN address the app falls back to *I'm near a
campus building*; for location on a phone, demo the live site (HTTPS). This exposes the server to that network, so
stop it after the demo.

## 2. Demo sequence (about 3 minutes)

Time of day matters: the plan starts now, and at night most places are closed (that's correct, not a bug). Away from
campus every walk is long, so for a demo set a campus location: Chrome DevTools → ⋮ → More tools → **Sensors** →
Location → *Other…* → **42.351012, -71.107992** (Mugar), or deny location and pick *I'm near a campus building*.

1. Open the site. **Get started** → switch on Mugar, FitRec and dining → **Continue** → the tip → **Got it**.
2. The sentence: *I have **1 hr** to **study**.* Tap **1 hr** and **study** to show the sheets.
3. **Find a spot** → allow location → the pin loader → the answer. From Mugar on a weekday afternoon:
   **Marciano Commons**, *about 12 min from you (estimate)*, then study until the hour is up, *quiet*. Only the walk
   and the activity are counted. **See all options** compares them; **Choose** picks another.
4. **Open directions**: the pin drops and bursts, then Google Maps opens the walking route.
5. Nothing fits: change to **30 min** to **eat** from far away (or set the Sensors location off campus). BU-sy says
   why and offers a fix the engine has checked (*Extend to N minutes*).
6. **Schedule**: upload an `.ics` file. A week strip shows free hours per day; tap a day to see its map: every calendar event
   as a busy block (even ones marked free), and in each gap the club meetings that fit, a meal at mealtimes and a
   study block, none overlapping an event. **Plan this** plans one; **Add to calendar** keeps it. **+ Add event** adds your own;
   events you added (and club meetings) can be removed, the file's own events can't.
7. **Explore** → **Mugar Library**: open status, the busyness meter, the sample day hour by hour, this week's hours,
   official sources. Back → **Clubs** → a club: **Add to calendar**, then join with an `@bu.edu` email.
8. **About the data**: every dataset with its licence, what's illustrative, how location is used.
9. `/counter/`: the on-device people counter (camera; nothing is uploaded).

For the pending human study use [the five-task script](team/usability/test_script.md).

## 3. After changing data or server code

```bash
.venv\Scripts\python server/export_static.py    # rewrites web/data/*.json
.venv\Scripts\python -m pytest -q               # includes "static export == API"
```
Commit the regenerated `web/data/` together with the change that caused it. GitHub Pages serves those
files as they are; it doesn't run the export.

## 4. Checks and results (2026-10-24)

Library and dining references (`feature/library-dining-references`): ROBOD drives Mugar, NOVANIMAL drives dining
lunch (breakfast and dinner modeled).

| Check | Result |
|---|---|
| `pytest`: everything below plus ROBOD parsing/offsets, zero vs missing vs invalid/negative counts, duplicate and conflicting timestamps, time-weighted slots and gaps; NOVANIMAL transaction grouping, repeated lines, multi-menu and kg purchases, refunds, wall-clock reading; dwell-time sums, scaling, explicit periods, no negatives, mappings, static == API, missing source files | **103 passed** |
| `node --test`: everything below plus simulation periods in the card text | **46 passed** |
| Full pipeline rerun (3 importers, generator, export): 29 outputs byte-identical | passed |
| Browser: Sources (mapping, periods, dwell, licences, deep links) 49/49; closed/slider incl. Mugar after 10 PM and Warren periods 43/43; planner 66/66; gym 42/42; meetups 22/22; subpath 9/9; 7 screens at 375–1440 px in light and dark, no overflow or page errors (56/56) | passed |

FitRec as one building (`feature/fitrec-building-only`): areas, the sample class/intramural schedule,
reservations, `/api/schedule` and `/api/programs` removed.

| Check | Result |
|---|---|
| `pytest`: one FitRec series equal to the scaled gym count, no areas/schedule/closures served, one planner place per facility | **85 passed** |
| `node --test` (the reservation-closure test removed with the feature) | **45 passed** |
| Browser: Sources mapping (6 rows), FitRec page without areas, one FitRec planner option, meetup places, static == API | 39/39 passed |
| Browser: planner 66/66, closed/slider 35/35, gym 42/42, meetups 22/22, subpath/playback 9/9; 7 screens at 375–1440 px in light and dark, no overflow or page errors (56/56) | passed |

Reference-driven simulations (`feature/reference-simulations`):

| Check | Result |
|---|---|
| `pytest`: everything below plus simulation steps (gaps, zero, demo clock, allocation), deterministic generation, areas = totals, complete mappings, labels, static sources == API | **85 passed** |
| `node --test` | **46 passed** |
| Browser: Sources & Simulation page (mapping, deep links, footer/sidebar/chip navigation), labels, FitRec total = areas, static == API | 35/35 passed |
| Browser: planner 66/66, gym 42/42, closed/slider 35/35, meetups 22/22, subpath/playback 9/9; 7 screens at 375–1440 px in light and dark, no overflow or page errors | passed |

Campus gym historical reference (`feature/historical-gym-data`):

| Check | Result |
|---|---|
| `pytest`: everything below plus gym import (bad rows, zero vs missing, offsets, duplicates, reruns), gap rule, loader, API, exclusion from suggestions, static days == API | **71 passed** |
| `node --test`: everything below plus the playback gap rule and offsets in the browser | **46 passed** |
| Import of the real file, run twice | identical outputs (62,184 rows kept, 0 rejected) |
| Browser: gym page in static and API mode (notice, day picker, playback, labels, grid, provenance), static == API, never in planner results or meetup places | 41/41 passed |
| Browser: planner 66/66 and meetups 22/22 again; Places, both references and About at 375–1440 px in light and dark, no overflow or page errors | passed |

Interface redesign (`feature/ui-refresh`):

| Check | Result |
|---|---|
| `pytest`: analytics, API, planner data loader, CORS, meetups, static export == API | **55 passed** |
| `node --test`: planner engine (incl. no starting point), remembered preferences, static meetups | **41 passed** |
| Browser: quick start, no-start browse, persistence + reset, typed-input errors, keyboard, static == API, brand red + contrast in both themes | 66/66 passed |
| Browser: every screen at 375, 768, 1280 and 1440 px, light and dark: no horizontal overflow, font loaded, no page errors | 48/48 passed |
| Browser: meetups in static and API mode (honest wording, invite codes, escaping, device ID not logged) | 22/22 passed |
| Browser: `/bu-sy/` subpath, playback, short viewport standing in for a phone keyboard | 9/9 passed |

Earlier round (before the redesign):

| Check | Result |
|---|---|
| Fresh copy of the repo → new venv → `pip install -r requirements.txt` → both suites | passed (fastapi 0.162, starlette 1.10, pydantic 2.14, uvicorn 0.54) |
| Browser, site under `/bu-sy/` like a GitHub Pages project site: direct links + refresh on 6 routes, no broken assets, no requests leave the machine | 18/18 passed |
| Browser: sample scenarios, results identical in static vs API mode and in another timezone, API failing mid-session, unreachable `?api=` | 12/12 passed |
| Browser: planner UI regression (mobile 375 px + desktop, validation, focus, empty state, playback, COD labels, meetups), both modes | 53/53 passed |
| LAN address (non-HTTPS) in static and API mode | loads (was a blank page before this round; fixed) |

The only console error in static mode is an expected 404: the app checking whether an API exists.

## 5. If something goes wrong

| Problem | Do this |
|---|---|
| API won't start or crashes | Ctrl+C, then run option A. The demo results are identical. |
| API dies mid-demo | The app keeps working with data already loaded. A reload shows *Couldn't load campus data* with **Try again**: restart the API, or switch to option A. Nothing is ever relabeled as live. |
| No internet | Planning works: the app makes no external requests. Only *Open directions* (Google Maps), source links, `pip install` and the people counter (unless `python web/counter/get_model.py` was run beforehand) need the internet. |
| `?api=https://host` is wrong or down | A notice says the API couldn't be reached, and the app uses the built-in demo files. |
| Port 8000 busy | Use another port, e.g. `8080`. |
| Phone can't connect | Same Wi-Fi? Firewall prompt accepted? Using the laptop's IP, not `localhost`? Otherwise demo from the laptop. |
| Old version showing | Reload once more (the offline copy updates in the background), or hard refresh (Ctrl+Shift+R). |
| Location blocked or far away | Tap *I'm near a campus building*, or set a campus location in DevTools → Sensors (section 2). |
| Want the first-run screens again | Clear this site's data in the browser. |
| Clubs cluttered | Static mode: clear this site's data in the browser. API mode: stop the server, delete `server/clubs.json` (sample clubs come back). |

## 6. What is local-only

| Feature | Static mode | API mode |
|---|---|---|
| Plan, Explore, place pages, About | same data and results in both | same |
| Clubs (created, signed up) | this browser only (localStorage) | shared via `server/clubs.json` (git-ignored) |
| Uploaded schedule (.ics): event titles and times, busy times | this tab, or this browser if remembered; never sent to the server | same |
| Club meetings added to the calendar | this browser (localStorage) until removed | same |
| Onboarding and access answers | this browser (`busy.app.v1` in localStorage) | same |
| Your location | memory only, for this visit; never stored or sent | same |

## 7. Known limitations

- **GitHub Pages** is live at https://jadenlee202.github.io/bu-sy/ (**Settings → Pages → Source: GitHub
  Actions**; a public repo, or a paid plan for private repos). The workflow deploys pushes to `main` only
  after the checks in `tests.yml` pass.
- *Not verified:* Firefox, Safari, physical phones, screen readers. (CI runs Python 3.12 and Node 22.)
- `--host 0.0.0.0` and the API's open CORS (`*`, no credentials) suit a demo network. Restrict CORS with
  `BUSY_CORS_ORIGINS` for anything public.
- pytest prints a Starlette deprecation warning about `httpx` in the test client. It's harmless today.
- Data: one sample Monday; amenities and capacities are illustrative, and so are hours except the verified BU hours in
  `web/data/hours.json`. Walks are straight-line estimates (× 1.2 at 84 m/min), not routed. FitRec is one
  building-level count (no courts, pools, rooms or reservations). Busyness is simulated over the planned visit, not a
  forecast.
- Creating a club and reviewing applications exist in the API but not in the app's screens.
