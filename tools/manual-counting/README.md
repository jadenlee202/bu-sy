# Manual counting pilot tool

**Manual controlled pilot — not live BU facility data.**

A team-only tool for counting entries and exits by hand, checking the running estimate against manual headcounts,
and exporting the results as CSV. Use it to collect and validate real occupancy measurements in a room we control
before buying any sensor. It goes with [`team/member-1-data-pilot/pilot_plan.md`](../../team/member-1-data-pilot/pilot_plan.md).

It lives in `tools/`, not `web/`, on purpose. GitHub Pages publishes `web/`, and the FastAPI server serves only
`web/`. So this tool is never part of the student-facing site, and nothing here changes the recommendation flow.

## Run it

```bash
python -m http.server 8001 -d tools/manual-counting
# open http://localhost:8001
```

It needs a local server: browsers block ES modules on `file://`. On a phone, open the laptop's address on the same
Wi-Fi (`python -m http.server 8001 --bind 0.0.0.0 -d tools/manual-counting`, then `http://<laptop-ip>:8001`).
Only do that on a network you trust: the page itself has nothing to protect, but it's a plain HTTP server.

**Tests** (37 checks, logic and the real page in headless Chrome):

```bash
python tools/manual-counting/run_tests.py     # needs Chrome/Chromium; set CHROME=/path if not found
```

Or open `http://localhost:8001/tests.html` in any browser. The tests back up and restore any real pilot session
saved in that browser.

## Where data is stored: this device only

- Every tap is saved right away to this browser's `localStorage` (`busy.manualPilot.session`), so a refresh,
  closed tab or dead battery doesn't lose the session.
- **It is not shared.** Another phone, another browser or a private window has its own separate copy. Teammates
  only see your data when you **export CSV** and send the files.
- Two tabs of the same browser share one session. Records are merged by their unique ID, so neither tab overwrites
  the other.
- If the browser blocks storage (some private modes), a yellow warning says a refresh will lose the session.
  Export often.
- There is **no upload and no server endpoint**. Adding one needs an access-control design first (see
  [Integration](#integration-with-the-app)).

## Using it

1. **Setup:** session name, facility ID (must start with `PILOT_`), doorway/counter ID, and the **known starting
   occupancy** (headcount the room right before you start).
2. **Entry +1 / Exit +1:** one tap per person crossing the doorway threshold. For a group of 3, tap 3 times.
3. **Undo last event:** cancels the newest Entry/Exit. The tap stays in the log, struck through, and an `undo`
   record is added. You can't undo past a reconciliation: take a new headcount instead.
4. **Manual headcount:** type the number of people you count in the room. The tool shows
   `difference = estimate − headcount` at that moment.
5. **Reconcile:** an explicit correction that sets the estimate to the headcount. It's stored as its own record
   (`from`, `to`, `adjustment`). Taps after the headcount still count on top of it.
6. **Negative estimate:** never clamped to 0. A warning appears and the value stays negative in the data until
   you undo a mistaken Exit or reconcile to a headcount.
7. **Export CSV**, then **Reset session…** (asks for confirmation; one previous session is kept in this browser
   and can still be exported from the setup screen).

Don't type names, student IDs or descriptions of people in the session name or notes. The tool records counts only:
no photos, no identities, no per-person tracks.

## Data model

Every record has a UUID `id`, an increasing `seq`, and a timestamp with its UTC offset
(`2026-10-28T14:05:12.345-04:00`). Records are append-only; nothing is edited or deleted.

| type | meaning | fields |
|---|---|---|
| `start` | known starting occupancy | `count` |
| `in` / `out` | one tap | `count` (always 1) |
| `undo` | cancels one tap | `target_id` |
| `headcount` | manual count | `observed`, `estimate_at_capture`, `note` |
| `reconcile` | correction | `headcount_id`, `from`, `to`, `adjustment` |

`estimate = start + Σin − Σout (not undone) + Σadjustment`

## Exports

| File | Columns | Notes |
|---|---|---|
| `…_events.csv` | `event_id,facility_id,sensor_id,timestamp,direction,count` | Same as `team/member-1-data-pilot/event_template.csv`. Undone taps left out. |
| `…_headcounts.csv` | `facility_id,timestamp,observed_count,observer_note` | Same as `headcount_template.csv`. |
| `…_occupancy.csv` | `facility_id,timestamp,occupancy_count` | Same columns as `data/*.csv`: the estimate after each change. **Can contain negatives** (kept on purpose). |
| `…_audit.csv` | `seq, record_id, type, …, estimate_after, flag, note, data_origin` | Everything, including undone taps, undo records and corrections. `data_origin` is always `manual_controlled_pilot`. |

Free text that starts with `= + - @` is prefixed with `'` so spreadsheets don't run it as a formula.

## Comparing against an independent tally

Goal: measure how far the tool's running estimate drifts from what is actually in the room.

1. **Roles (at least 3 people):** a *counter* uses this tool at the doorway; a *tallier* keeps an independent
   paper tally of ins and outs at the same doorway and does not look at the phone; a *checker* does room headcounts.
   Use one doorway for the first sessions. With more doors, each door needs its own device, and the per-device
   estimate only covers that door.
2. **Sync clocks:** everyone sets their phone to network time. The tallier writes `HH:MM:SS` for each tick.
3. **Start:** the checker headcounts the room. The counter enters it as the starting occupancy; the tallier
   writes it at the top of the sheet.
4. **Every 5 minutes:** the checker headcounts the room and calls out the number. The counter records it as a
   **headcount but does not reconcile** during comparison runs, so drift stays visible. The tallier writes the
   same number on the paper.
5. **Run the scripted scenarios** from the pilot plan (single, group, turnaround, simultaneous in+out).
6. **End:** final headcount, then export all four CSVs. Type the paper tally into
   `team/member-1-data-pilot/event_template.csv` format with `sensor_id = TALLY_<door>`, one row per tick.
7. **Compare** at each headcount time *t*:
   - tool error = tool estimate(t) − headcount(t) (from `…_headcounts.csv` + `…_occupancy.csv`, or the audit's
     `estimate_at_capture`)
   - tally error = (start + tally ins − tally outs up to t) − headcount(t)
   - tool vs. tally: the difference in ins and outs per 5-minute window
   Report the largest absolute error, the final error, and which scenarios caused it. Don't quote an accuracy
   figure from fewer than 3 sessions.
8. **Then** run a session with reconciliation on, to check that corrections are recorded as expected.

## Integration with the app

There is **no adapter yet, on purpose.** `server/` belongs to Member 2, and adding pilot data changes what students
see. Coordinate with them before doing any of this.

What the server would need (in `server/sources.py` and `server/main.py`):

1. **Loader.** Read `…_occupancy.csv` (columns already match `data/*.csv`). The timestamps carry an offset, so
   `datetime.fromisoformat` returns *aware* datetimes. The app's series are *naive* local time (`observed_at` is
   "naive, in `timezone`"). Convert with `.astimezone(ZoneInfo("America/New_York")).replace(tzinfo=None)` and set
   `Facility.timezone = "America/New_York"`. Mixing aware and naive datetimes raises `TypeError` in comparisons.
2. **Rows to reject.** Negative `occupancy_count` (unresolved inconsistency), and any session whose audit shows an
   open (unreconciled) headcount with a non-zero difference, unless you deliberately want raw data.
3. **Labels.** `data_mode` is `Literal["historical_playback", "synthetic", "live"]` and `measurement_method` is
   `Literal["estimated", "measured", "synthetic"]`. Pilot data is neither live nor BU data. Add a new value such as
   `data_mode="manual_pilot"`, `measurement_method="measured"`, and a `source` that says
   "BUsy manual controlled pilot (team-collected, not BU facility data)". The site's `isReal()` in
   `web/js/app.js` treats anything not `synthetic` as **Real data**, so Member 3 needs to add a "Pilot" tag too.
4. **Window and capacity.** `window` = the session's hours. `capacity` = the room's posted capacity if known,
   otherwise `reference` as for the COD room.
5. **Facility id.** Keep the `PILOT_` prefix so it can never be confused with a real or sample place.
6. Run `python server/export_static.py` and `python -m pytest` afterwards.

**Live upload is out of scope.** Before any `POST` endpoint exists it needs: authentication for named team devices
(not public), an append-only store keyed by `event_id` (so resent events are deduplicated), per-session ownership,
rate limits, and no exposure on GitHub Pages.

## Files

```
index.html, pilot.css    the tool
js/session.js            records, estimate, undo, headcount, reconcile, merge, CSV (pure logic, no DOM)
js/store.js              localStorage persistence, tab merge, unreadable-data backup, previous session
js/app.js                UI wiring
tests.html, js/tests.js  37 browser tests, incl. a full UI run with a page reload
run_tests.py             serves the folder and runs tests.html in headless Chrome
```
