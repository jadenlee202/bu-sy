# BU-sy demo runbook

Everything below was run on **2026-10-24** (Windows 11, Python 3.14.7, Node 24.21, Microsoft Edge headless)
unless it is marked *not verified*. All data in the demo is sample data; nothing is live.

## 0. Before the demo (once, with internet)

| Need | Version | Used for |
|---|---|---|
| Python | 3.12 or newer (verified 3.14; CI uses 3.12) | the site's local server, the API, pytest |
| Node | 22 or newer (verified 24; CI uses 22) | **only** the JS tests (planner engine, static meetups); not needed to run the app |
| Browser | any current Chromium/Edge (verified); Firefox/Safari *not verified* | the app |

```bash
git clone https://github.com/jadenlee202/bu-sy.git
cd bu-sy
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python -m pip …
.venv\Scripts\python -m pytest -q                           # expect 85 passed
node --test "tests/*.test.mjs"                              # expect 45 passed (or: npm test)
```
No API keys, accounts or secrets are needed. `.env` files are ignored by git anyway.

## 1. Start (pick one)

**A. Static, recommended for the demo.** There's no backend to crash and it needs no install:
```bash
python -m http.server 8000 -d web
```
Open http://localhost:8000. The footer should read *Data source: built-in demo files, no server*.

**B. With the API** (meetups are then shared between devices):
```bash
.venv\Scripts\python -m uvicorn main:app --app-dir server --port 8000
```
Open http://localhost:8000. The footer should read *Data source: BU-sy API*. API docs are at `/docs`.
This command works from the repo root and doesn't need `activate`, which PowerShell often blocks.

**On a phone (same Wi-Fi).** Add `--bind 0.0.0.0` (option A) or `--host 0.0.0.0` (option B), then open
`http://<laptop-ip>:8000` on the phone. Windows may ask to allow Python through the firewall.
Verified with the laptop's LAN address in a desktop browser; *not verified on a physical phone*.
This exposes the server to that network, so stop it after the demo.

## 2. Demo sequence (about 3 minutes)

Every result below comes from the real engine (`web/js/recommend.js`) running on the sample data. Results
don't depend on the time of day or the viewer's timezone (verified with the browser set to Asia/Tokyo), and
API mode gives exactly the same text as static mode (verified).

1. **Quick start.** On "What fits now?", tap **Work out** and **60 min**. With no starting point, the app
   lists FitRec as *could work* and says travel isn't checked. Pick **Mugar Library** as the starting point:
   now it *fits*, with the walk counted. Open **Preferences** to show the visible defaults (start time from
   the demo clock, minimum, 10-min buffer, ranking). Point out the persistent **Demo data** card (sidebar) or
   **Demo** pill (phone).
2. Open **Try a sample** under the form and choose *70 free minutes, workout, then class* (3 PM, Mugar Library →
   class at Warren Towers).
   - Expect **FitRec**, *"The only place that fits"* (quiet), and *"Fits your 70-minute window: 10 min there +
     36-minute workout + 14 min onward + 10-minute buffer."* FitRec is one building-level count: courts, pools,
     rooms and reservations aren't tracked.
   - Open **Why this fits** on a card: calculation, timeline, busyness source, hours and limits.
3. **"An hour to study, outlets needed"** (under *Try a sample*).
   - Expect **Best match: Marciano Commons** (quieter at the selected demo time), then Mugar Library (moderate).
   - *Why 1 other place doesn't fit*: West Campus Dining, "Outlets not listed in sample metadata".
4. **"30-minute lunch across campus (nothing fits)"**.
   - Expect **"Nothing fits this window"**, with reasons and a per-place list.
   - Tap **Extend to 48 minutes**: the form updates and 2 options fit.
5. **View place** on any card. The chart and playback open at the same demo time (3:00 PM). Press play.
   Point out the **Simulated** tag and **How it's simulated**: it opens **Sources & Simulation**, which maps
   FitRec to the campus gym dataset (rescaled, whole building only), shows dining and Mugar as modeled with no
   dataset, and explains why the Chapel Hill library and UCI room datasets weren't used.
6. **Places → Historical references → Campus Gym — Historical Reference.** Point out the notice
   ("Historical gym data — not live and not BU FitRec."), pick another **Recorded day** (5–11 Dec 2016), press
   play, and show "Replay 5:30 PM · observed 5:24 PM (UTC−08:00)", the busyness line "Relative to this gym's
   historical traffic", the typical weekday × hour grid and **How this works** (capacity unknown, 30-minute gap
   rule, source and license). The Clemente Room (COD) is the other reference: an office room, timezone unverified.
7. *(Optional)* **Meetups** (sidebar, or the footer on a phone): join an example, or create an invite-only one.

## 3. After changing data or server code

```bash
.venv\Scripts\python server/export_static.py    # rewrites web/data/*.json
.venv\Scripts\python -m pytest -q               # includes "static export == API"
```
Commit `web/data/` together with the change. GitHub Pages serves those files as they are; it doesn't run
the export.

## 4. Checks and results (2026-10-24)

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
| API dies mid-demo | The planner keeps working with data already loaded. Other screens show *"Can't reach the data source"* with **Try again**. Restart the API and press Try again, or switch to option A. Nothing is ever relabelled as live. |
| No internet | Nothing needed: the app makes no external requests. Only `pip install` and the DOI link on About need the internet. |
| `?api=https://host` is wrong or down | A notice says the API couldn't be reached, and the app uses the built-in demo files. |
| Port 8000 busy | Use another port, e.g. `8080`. |
| Phone can't connect | Same Wi-Fi? Firewall prompt accepted? Using the laptop's IP, not `localhost`? Otherwise demo from the laptop. |
| Old version showing | Hard refresh (Ctrl+Shift+R). |
| Meetups cluttered | Static mode: clear this site's data in the browser. API mode: stop the server, delete `server/community_events.json` (examples come back). |

## 6. What is local-only

| Feature | Static mode | API mode |
|---|---|---|
| Planner, Places, playback, About | same data and results in both | same |
| Meetups (created, joined) | this browser only (localStorage) | shared via `server/community_events.json` (git-ignored) |
| Planner inputs | this tab only; cleared on reload | same |
| Light/dark choice | this browser (localStorage) | same |

## 7. Known limitations

- **GitHub Pages deployment has not been verified.** It needs the repo owner to set **Settings → Pages →
  Source: GitHub Actions**, and a public repo (or a paid plan for private repos). The Pages workflow deploys
  on every push to `main` without waiting for the tests. The `/bu-sy/` layout was checked locally by
  serving the site from that subpath.
- *Not verified:* Python 3.12 (CI uses it), Node 22, Firefox, Safari, physical phones, screen readers.
- Meetup dates are relative to today's real date (by design). The planner and Places don't use the clock.
- `--host 0.0.0.0` and the API's open CORS (`*`, no credentials) suit a demo network. Restrict CORS with
  `BUSY_CORS_ORIGINS` for anything public.
- pytest prints a Starlette deprecation warning about `httpx` in the test client. It's harmless today.
- Data: one sample Monday; walking times, hours, amenities and capacities are illustrative. FitRec is one
  building-level count (no courts, pools, rooms or reservations). Busyness is read at the selected time,
  not forecast.
