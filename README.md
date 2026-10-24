# BUsy

**How busy is it?** A mobile-first prototype that shows how busy campus places are, replays a day of
traffic, suggests a quieter time to go, and lets students post unofficial meetups ("basketball run, court 4").

Built in 24 hours by a five-person team. Independent student project, **not affiliated with Boston University**.

> **Data honesty:** FitRec, dining and Mugar use **synthetic** numbers. The one **real** place is the
> *Clemente Room*: an office conference room from the public COD dataset. It shows the pipeline working on
> real sensor data. Nothing here tracks BU facilities.

## Run it

**Just the site (no install):**
```bash
python -m http.server 8000 -d web
# open http://localhost:8000
```
It reads the pre-built JSON in `web/data/`, and events are saved in your browser.

**With the API** (events shared between everyone using the server):
```bash
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cd server
uvicorn main:app --reload
# open http://127.0.0.1:8000   (API docs at /docs)
```
The site detects the API automatically. To use an API on another host, add `?api=https://host` to the URL.

**Tests:** `python -m pytest`

## Publish on GitHub Pages

1. Push this repo to GitHub (branch `main`).
2. **Settings → Pages → Source: GitHub Actions.**
3. Every push to `main` deploys `web/` (see `.github/workflows/pages.yml`).

Pages has no server, so it runs in static mode: same screens, and events are kept on each visitor's device.

## What's inside

```
data/      Member 1  raw + cleaned data, clean_cod.py, sources and cleaning notes (data/README.md)
server/    Member 2  FastAPI app (main.py), data adapter (sources.py), events, static export
           Member 4  analytics.py: busyness, time-weighted averages, playback lookup
web/       Member 3  the site: index.html, styles.css, js/ (app, data adapter, icons), data/ (generated)
tests/     Member 4  pytest suite for analytics, API and event flows
```

### How busyness works
- **Count → busyness:** count ÷ capacity for sample places (capacities are illustrative), or count ÷ the room's
  usual high for Clemente (95th-percentile time-weighted count, because its real capacity is unknown).
  Under 40% is *quiet*, under 75% *moderate*, otherwise *busy*. These are demo thresholds, not validated.
  Weight rooms and basketball courts tolerate bigger crowds (÷ 1.25).
- **Playback:** one clock replays the recorded day (7 AM–11 PM). Each place shows its latest observation
  at or before that time. Before the first one, or after recording ends, it shows *no data*, never zero.
- **Hourly chart:** time-weighted averages (each count holds until the next), so busy periods with many
  sensor events aren't overcounted.
- **Quieter time:** the quietest upcoming hour. For Clemente this comes from all recorded days that share its
  weekday ("usually quieter"); for sample places it comes from the sample day. It's a historical pattern,
  not a forecast.

### Events (unofficial)
Anyone can host: what, where (FitRec area or campus place), when, optional spots, and **Anyone** or
**Invite only** (a 6-character code the host shares). There are no accounts: just a nickname and a random device ID.
Invite codes are only ever returned to the host. Hosts can cancel; guests can leave.

### API
| | |
|---|---|
| `GET /api/facilities?at=17:30` | all places at a playback time |
| `GET /api/facilities/{id}?at=18:00` | one place (+ FitRec areas and sample class reservations) |
| `GET /api/facilities/{id}/history` | the recorded day: observations, hourly averages, typical profile |
| `GET /api/schedule`, `GET /api/programs` | **sample** official schedule (placeholders) |
| `GET/POST /api/community-events`, `POST …/{id}/join`, `…/leave`, `…/cancel` | student events |

After changing data or server logic, refresh the static copy: `python server/export_static.py`.

### Swapping in a real campus feed
Replace `server/sources.py` with a loader for an authorized, aggregate count, keeping the `Facility` shape.
The screens, analytics and API don't change.

## Data sources
- Liu et al., *COD: A Dataset of Commercial Building Occupancy Traces*, Zenodo 2017,
  [doi:10.5281/zenodo.996587](https://doi.org/10.5281/zenodo.996587), CC BY-SA 4.0.
- Synthetic campus data made by the team. Details and cleaning results: [`data/README.md`](data/README.md).

BU's own [Peak & Quiet Hours](https://www.bu.edu/fitrec/peak-quiet-hours/) page already reports FitRec
traffic; BUsy explores a clearer mobile view across place types, not a replacement for it.
