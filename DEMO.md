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
.venv\Scripts\python -m pytest -q                           # expect 55 passed
node --test "tests/*.test.mjs"                              # expect 32 passed (or: npm test)
```
No API keys, accounts or secrets are needed. `.env` files are ignored by git anyway.

## 1. Start (pick one)

**A. Static, recommended for the demo.** There's no backend to crash and it needs no install:
```bash
python -m http.server 8000 -d web
```
Open http://localhost:8000. The footer should read *Data source: built-in demo files (no server)*.

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

1. **Home, "What fits now?"** Point out the *Demo · Synthetic campus data* label and the tagline.
2. **Try a sample scenario** (70 min at 3 PM, work out, Mugar Library → class at Warren Towers).
   - Expect **"7 places fit · top 3"** and *"Fits your 70-minute window: 10 min there + 36-minute workout +
     14 min onward + 10-minute buffer."*
   - There's no "Best match": the app explains that the options are equal on the evidence.
   - Show "Why this fits", the timeline and the disclaimer.
3. **"An hour to study, outlets needed"** (link under the sample button).
   - Expect **Best match: Marciano Commons** (quieter at the selected demo time), then Mugar Library (busy).
   - *Why 1 other place doesn't fit*: West Campus Dining, "Outlets not listed in sample metadata".
4. **"30-minute lunch across campus (nothing fits)"**.
   - Expect **"Nothing fits this window"**, with reasons and a per-place list.
   - Tap **Extend to 48 minutes**: the form updates and 2 options fit.
5. **View facility** on any card. The chart and playback open at the same demo time (3:00 PM). Press play.
6. **Places → "Real data": Clemente Room.** Real office data from the COD dataset, "never a campus
   suggestion", timestamps "timezone unverified".
7. *(Optional)* **Student meetups** (footer): join an example, or create an invite-only one.

## 3. After changing data or server code

```bash
.venv\Scripts\python server/export_static.py    # rewrites web/data/*.json
.venv\Scripts\python -m pytest -q               # includes "static export == API"
```
Commit `web/data/` together with the change. GitHub Pages serves those files as they are; it doesn't run
the export.

## 4. Checks and results (2026-10-24)

| Check | Result |
|---|---|
| `pytest`: analytics, API, planner data loader, CORS, meetups, static export == API | **23 passed** |
| `node --test`: planner engine (fit maths, closures, unknown hours/routes/busyness, ranking, COD exclusion, sample scenarios) | **24 passed** |
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
- Data: one sample Monday; walking times, hours, amenities and capacities are illustrative. The workout
  sample has no best match because all FitRec areas share a location. Busyness is read at the selected time,
  not forecast.
