# BU-sy demo runbook

Integration checks (October 25, 2026): all fetched feature branches are combined locally.
198 Python tests and 104 JavaScript tests pass. Calendar requires the declared cryptography
dependency and optional OAuth configuration described in README; no Google account was connected.
The local integration includes actionable plans, calendar/availability, the Places list,
the club directory and separately sourced facility metadata.

Earlier actionable-plan checks: 115 Python tests and 66 JavaScript tests passed.
The static exporter was run locally. Browser inspection was attempted but the computer-use tool
stopped because it could not reliably determine Edge's current URL. The 390/768/1280 px,
both-theme, keyboard, overflow and external-link browser checks remain **not executed** for this change.
Historical browser reports in section 4 below belong to older builds and are not new verification.

## 0. Before the demo (once, with internet)

| Need | Version | Used for |
|---|---|---|
| Python | 3.12 or newer (verified 3.14; CI uses 3.12) | the site's local server, the API, pytest |
| Node | 22 or newer (verified 24; CI uses 22) | **only** the JS tests (planner engine, static clubs, .ics import); not needed to run the app |
| Browser | any current Chromium/Edge (verified); Firefox/Safari *not verified* | the app |

```bash
git clone https://github.com/jadenlee202/bu-sy.git
cd bu-sy
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python -m pip …
.venv\Scripts\python -m pytest -q                           # expect 115 passed
node --test "tests/*.test.mjs"                              # expect 66 passed (or: npm test)
```
No API keys, accounts or secrets are needed. `.env` files are ignored by git anyway.

## 1. Start (pick one)

**A. Static, recommended for the demo.** There's no backend to crash and it needs no install:
```bash
python -m http.server 8000 -d web
```
Open http://localhost:8000. The footer should read *Data source: built-in demo files, no server*.

**B. With the API** (clubs and sign-ups are then shared between devices):
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

The home URL opens the planner, with no large hero ahead of the controls. Both static and API
modes use the same campus payload and recommendation engine. These sample outputs were checked
through the real engine in Node; the browser interaction sequence still needs visual verification.

1. Choose **Study** and **60 min**. Leave the starting point unset: options are browsable, travel
   is not checked and no plan can be chosen. Set **Mugar Library** as the start.
2. Under **Preferences**, set the demo time to **15:00**, next stop **Warren Towers**, minimum
   activity **30**, preparation **3**, cleanup **2**, buffer **10**. Check the library entry
   requirements in **Facility details & sources**, then confirm access for this session.
   Do not confirm access for a real visit without checking it.
3. Choose **Mugar Library**. The evaluated timeline is: depart/arrive **3:00 PM**, prepare
   **3:00-3:03**, study **3:03-3:44** (41 minutes), clean up **3:44-3:46**, leave by **3:46**,
   reach Warren **3:50**, protect **3:50-4:00** as buffer. Every minute is counted once.
   **Open directions** uses the verified address; it does not validate the sample walk.
4. **Change plan** returns to options. **Edit inputs** preserves inputs and opens settings.
   Change the next stop to **Fenway**. The old selection is invalidated; for Mugar only 25
   activity minutes remain, below the 30-minute minimum. Choose a suggested change explicitly
   or revise the plan. Never treat the former timeline as current.
5. Try **80 free minutes, workout + changing, then class (access checked)**. This sample
   explicitly assumes eligibility. It used to be a 70-minute window; that no longer meets
   the unchanged 35-minute workout minimum after changing/cleanup. At 80 minutes, FitRec
   gives **36 activity minutes**: walk 3:00-3:10, prepare 3:10-3:15, exercise 3:15-3:51,
   cleanup 3:51-3:56, walk onward to Warren 3:56-4:10, buffer 4:10-4:20.
6. Try **30-minute lunch across campus**. Nothing fits. Each proposed fix is checked by the
   engine with preparation/cleanup included; the form changes only when you choose one.
7. Open a facility's sources and current weekly schedule. Current published dining weeks
   do not establish October 19 historical hours. Fenway planner hours remain unknown,
   and its entrance is unverified, so it has no confirmed plan or directions action.
8. Browse **Sources & Simulation** and the historical references under **Places**. ROBOD,
   NOVANIMAL, COD and campus-gym attribution remains. References never become campus plans.

For the pending human study use [the five-task script](team/usability/test_script.md).
Pending browser checks: at 390, 768 and 1280 px in both themes, verify planner-first order,
no horizontal overflow, visible keyboard focus, readable timeline, back/edit preservation,
accurate provenance labels, and supported directions links. No results are invented here.

## 3. After changing data or server code

```bash
.venv\Scripts\python server/export_static.py    # rewrites web/data/*.json
.venv\Scripts\python -m pytest -q               # includes "static export == API"
```
Keep regenerated `web/data/` with the local change; do not commit, push or deploy without explicit instruction. GitHub Pages serves those files as they are; it doesn't run
the export.

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
| API dies mid-demo | The planner keeps working with data already loaded. Other screens show *"Can't reach the data source"* with **Try again**. Restart the API and press Try again, or switch to option A. Nothing is ever relabelled as live. |
| No internet | Nothing needed: the app makes no external requests. Only `pip install` and the DOI link on About need the internet. |
| `?api=https://host` is wrong or down | A notice says the API couldn't be reached, and the app uses the built-in demo files. |
| Port 8000 busy | Use another port, e.g. `8080`. |
| Phone can't connect | Same Wi-Fi? Firewall prompt accepted? Using the laptop's IP, not `localhost`? Otherwise demo from the laptop. |
| Old version showing | Hard refresh (Ctrl+Shift+R). |
| Clubs cluttered | Static mode: clear this site's data in the browser. API mode: stop the server, delete `server/clubs.json` (sample clubs come back). |

## 6. What is local-only

| Feature | Static mode | API mode |
|---|---|---|
| Planner, Places, playback, About | same data and results in both | same |
| Clubs (created, signed up) | this browser only (localStorage) | shared via `server/clubs.json` (git-ignored) |
| Uploaded schedule (.ics): event titles and times, busy times | this tab, or this browser if remembered; never sent to the server | same |
| Planner inputs | this tab only; cleared on reload | same |
| Light/dark choice | this browser (localStorage) | same |

## 7. Known limitations

- **GitHub Pages deployment has not been verified.** It needs the repo owner to set **Settings → Pages →
  Source: GitHub Actions**, and a public repo (or a paid plan for private repos). The Pages workflow deploys
  on every push to `main` without waiting for the tests. The `/bu-sy/` layout was checked locally by
  serving the site from that subpath.
- *Not verified:* Python 3.12 (CI uses it), Node 22, Firefox, Safari, physical phones, screen readers.
- `--host 0.0.0.0` and the API's open CORS (`*`, no credentials) suit a demo network. Restrict CORS with
  `BUSY_CORS_ORIGINS` for anything public.
- pytest prints a Starlette deprecation warning about `httpx` in the test client. It's harmless today.
- Data: one sample Monday; walking times, amenities and capacities are illustrative, and so are hours except the verified BU hours in `web/data/hours.json`. FitRec is one
  building-level count (no courts, pools, rooms or reservations). Busyness is read at the selected time (and, with a starting point, profiled over the estimated visit),
  not forecast.
