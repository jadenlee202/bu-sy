# Baseline — Member 4 (Independent QA)

This records the exact state of the repository I inspected, what checks I ran,
and what I could not run. I did not modify any application code, tests,
dependencies, or the root README. All work lives under `team/member-4-qa/`.

## Working-tree state inspected

- **Repository:** `bu-sy`
- **Branch:** `main` (tracking `origin/main`, `origin/HEAD`)
- **HEAD commit:** `d871a30968df453756babdb0317ad4dd47245627`
- **HEAD subject:** `BUsy second draft: minimal BU-red UI, real COD data, student events`
- **Previous commit:** `811a22b Initial commit`
- **Working tree at inspection:** no application files changed by me. The only
  additions are my own documents under `team/member-4-qa/`.

> Note on the "What fits now?" feature: as of commit `d871a30`, the codebase does
> **not** contain a time-budget / travel-aware recommendation engine. The only
> recommendation present is `quieterTime()` in `web/js/app.js`, which picks the
> lowest-occupancy future hour for a single facility. The brief I was given
> describes a feature still being implemented by another teammate. This baseline
> therefore captures the **pre-feature** state so that, when the feature lands, I
> can distinguish new failures from pre-existing ones. See `test_matrix.md` for
> the validation package prepared against the expected rule.

## Expected recommendation rule (from the brief, not yet in code)

```
available time >= outbound travel + minimum activity duration + onward travel + buffer
```

The feature is also expected to account for: opening hours, activity
compatibility, user preferences, and data availability.

## Checks available in the repo

- **`tests/test_api.py`** — pytest suite over the FastAPI server
  (analytics math, facility playback, COD history, community-events CRUD).
  Run command per the file header: `python -m pytest`.
- **CI workflows** present:
  - `.github/workflows/tests.yml`
  - `.github/workflows/pages.yml`
- **No JS test suite** exists. The frontend (`web/js/app.js`, including
  `quieterTime()`) has no automated tests; the brief's recommendation logic, if
  built in the frontend, will also be untested unless the implementer adds tests.

## Check execution results

| Check | Command | Result | Applies to |
|---|---|---|---|
| Python API tests | `python -m pytest` | **Not run** — blocked | commit `d871a30` |
| JS/recommendation tests | n/a | **Not run** — none exist | commit `d871a30` |

### Why "Not run"

Command execution in my environment is effectively unavailable for the test suite:

- The workspace shell exposes only the macOS system interpreter
  `/usr/bin/python3` → **Python 3.9.6**.
- `python` is not on `PATH` (`command not found: python`).
- `pytest` is **not installed** for that interpreter
  (`No module named pytest`), and neither are `fastapi`, `uvicorn`, or `httpx`
  (the test-only HTTP client). `requirements.txt` lists
  `fastapi>=0.115, uvicorn>=0.30, tzdata, pytest>=8, httpx>=0.27`.
- `pip 21.2.4` is present, but I did not install dependencies: doing so would
  mutate the environment and is outside a read-only QA baseline, and I was asked
  not to repeatedly retry shell commands.

Because I cannot execute the suite, I am **not** recording any pass/fail results
for it. I will not invent them. When a runnable environment is available
(Python ≥ 3.11 recommended for `tzdata`/modern FastAPI, with
`pip install -r requirements.txt`), run `python -m pytest` from the repo root
and record the output here, tagged with the commit it applied to.

### Pre-existing vs. new failures

I have **no executed baseline**, so I cannot yet partition failures. The
protocol once execution is possible:

1. Run `python -m pytest` at `d871a30` (pre-feature). Record pass/fail per test.
2. After the recommendation feature merges, re-run at that commit.
3. Any test green at step 1 but red at step 2 is a **new** regression.
   Anything red at both is **pre-existing**.

## Static review performed instead (no execution required)

I read the full server and web source. Observations relevant to the baseline:

- The test suite hard-codes expected values (e.g. FitRec `occupancy_count == 741`
  at `18:00`, COD `busyness_reference == 4`). If the implementer changes
  capacities, thresholds, or the COD percentile, these will fail for data
  reasons, not feature bugs — worth noting when triaging.
- `opening_hours` is **always `None`** in `facility_fields()` (`server/main.py`).
  The brief expects the recommendation to respect opening hours, but the API
  currently exposes none. This is a likely integration gap to watch.
- There is no travel-time, no activity-duration, and no preference data anywhere
  in the current server or frontend. The recommendation feature will have to
  introduce all of these; none can be validated against existing endpoints yet.

## Version tag for all my deliverables

Everything in `team/member-4-qa/` was authored against commit **`d871a30`**
(pre-recommendation-feature). Each finding in `findings.md` will restate the
commit it was checked against.
