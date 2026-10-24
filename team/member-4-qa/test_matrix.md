# Black-Box Test Matrix — "What fits now?" Recommendations

**Author:** Member 4 (independent QA)
**Version inspected:** commit `d871a30` (pre-feature; the recommendation engine
is not yet in the code).
**Execution status:** every case below is **Not run** — the feature does not
exist yet at this commit and the test environment cannot run the suite (see
`baseline.md`). These are prepared, ready-to-execute specs. I have computed the
expected time-budget results by hand so they can be checked the moment the
feature lands. **No pass/fail is claimed.**

## The rule under test

A candidate activity is **feasible** when:

```
available_time >= outbound_travel + min_activity_duration + onward_travel + buffer
```

- `available_time` — the student's free gap (minutes).
- `outbound_travel` — travel from the student's start to the facility.
- `min_activity_duration` — the shortest useful visit for that activity.
- `onward_travel` — travel from the facility to the next destination
  (0 if there is no next destination, per the "missing next destination" case —
  **this assumption must be confirmed with the implementer**).
- `buffer` — a single safety margin, applied **once** per candidate.

The feature must also respect: opening hours, activity compatibility,
preferences, and data availability (never fabricate a result from missing data).

## Shared assumptions (CONFIRM with implementer before running)

These are not visible in the code at `d871a30`; I state them so expected values
are reproducible. If the implementer's real values differ, substitute them and
recompute — the arithmetic method stays the same.

| Symbol | Assumed value for worked examples |
|---|---|
| `buffer` | 5 min |
| `min_activity_duration` (study) | 30 min |
| `min_activity_duration` (gym) | 45 min |
| `min_activity_duration` (dining) | 20 min |
| Default `onward_travel` when no next destination | 0 min |
| "Stale" threshold | measurement older than 60 min |

## Test matrix

Legend for **Expected**: ✅ = recommended/feasible, ❌ = excluded/infeasible,
⚠️ = shown with an explicit caveat, not silently.

| # | Case | Inputs | Expected behavior | Hand-calculated budget | Status |
|---|------|--------|-------------------|------------------------|--------|
| 1 | **Exactly enough time** | avail=60, out=10, dur=30, onward=10, buf=5 | ✅ feasible (equality passes) | need = 10+30+10+5 = **55 ≤ 60** → feasible, 5 min slack | Not run |
| 2 | **One minute too little** | avail=54, out=10, dur=30, onward=10, buf=5 | ❌ infeasible; not shown as a fit | need = **55 > 54** → infeasible by 1 min | Not run |
| 3 | **Missing next destination** | avail=50, out=10, dur=30, onward=∅, buf=5 | ✅ feasible with onward=0; must state the assumption ("assumes you stay / no return trip"), not silently assume a return | need = 10+30+0+5 = **45 ≤ 50** → feasible | Not run |
| 4 | **Unknown route times** | avail=60, out=unknown, dur=30, onward=unknown, buf=5 | ⚠️ cannot compute; must **not** assume 0. Either exclude or show "travel time unknown" — never present as a confident fit | need = **undefined** (unknown terms) → no numeric verdict | Not run |
| 5 | **Same start and destination** | avail=40, out=0, dur=30, onward=0, buf=5 | ✅ feasible; travel legs are 0 but buffer still applies once | need = 0+30+0+5 = **35 ≤ 40** → feasible | Not run |
| 6 | **Buffer applied once** | avail=50, out=10, dur=30, onward=10, buf=5 | ✅ feasible; verify buffer added a single time, not per leg | correct need = **55** (infeasible); double-buffer bug would compute 10+30+10+5+5=60. If feasible/infeasible flips vs. #1's sibling, buffer is miscounted. Here 55>50 → ❌; a single-buffer engine must agree it's infeasible by 5, **not** by 10 | Not run |
| 7 | **Facility closing before visit ends** | avail=90, out=10, dur=30, buf=5, opens 08:00–17:30, arrival 17:10 | ❌ infeasible (or ⚠️): arrival 17:10 + 30 min = 17:40 > 17:30 close. Budget alone says feasible, so opening hours must override | time-budget need = 45 ≤ 90 **(budget OK)** but closes mid-visit → must be excluded | Not run |
| 8 | **Unknown opening hours** | avail=90, hours=∅, otherwise feasible | ⚠️ shown with "hours unknown" caveat, or excluded by policy — never asserted "open now" | budget feasible; honesty gate on hours | Not run |
| 9 | **Zero vs missing occupancy** | A: count=0 (recorded empty). B: count=null (no data) | A: ✅ treat as genuinely empty/quiet. B: ⚠️ "no data", never rendered as 0 or "quiet" | n/a (data-honesty, not budget) — mirrors `latest_at` returning None vs 0 | Not run |
| 10 | **Unsupported amenities** | preference="squash", facility lacks squash | ❌ excluded on activity compatibility before budget math runs | n/a (compatibility gate) | Not run |
| 11 | **Stale measurements** | last obs 90 min ago, threshold 60 | ⚠️ shown with "last updated 90 min ago"; not presented as current | n/a (freshness gate) | Not run |
| 12 | **Synthetic vs historical data** | FitRec (synthetic) vs COD (historical_playback) | both may appear but each must carry its honest label ("Sample" / historical office room); neither labeled "live" | n/a (labeling gate) | Not run |
| 13 | **COD excluded from campus recommendations** | request campus study/gym/dining fit | ❌ COD (`office`, "not BU") must not surface as a BU campus recommendation | n/a (scope gate) — COD is a non-BU office room | Not run |
| 14 | **No feasible result** | avail=20, every candidate need>20 | graceful empty state explaining nothing fits + how to recover (widen time / change filter), not a blank or a forced bad pick | all needs > 20 → empty result set | Not run |
| 15 | **Stable tie-breaking** | two candidates, identical budget + occupancy | deterministic order across repeated runs (e.g. by id/name); same input → same output ordering every time | equal needs → tie broken by a stable key | Not run |

## Worked expected calculations (independent of the implementation)

I computed these from the rule only, so they serve as an oracle.

- **Case 1 (equality):** `10+30+10+5 = 55`. `55 ≤ 60` → feasible, slack `+5`.
  Equality is the boundary; a `>` (strict) comparison would wrongly reject the
  exactly-enough case, so verify the engine uses `>=` toward available time
  (i.e. `need <= available`).
- **Case 2 (off-by-one):** `55 > 54` → infeasible by exactly 1 min. This catches
  a `<`/`<=` boundary error in the opposite direction.
- **Case 5 (same place):** `0+30+0+5 = 35 ≤ 40`. Confirms buffer survives even
  when both travel legs vanish.
- **Case 6 (buffer once):** correct `need = 55`; a per-leg double buffer yields
  `60`. With `available = 50`, both say infeasible, but the **reported shortfall**
  differs (5 vs 10). Assert on the shortfall, not just the boolean, to catch a
  double-count that happens not to flip the verdict.
- **Case 7 (closing):** budget `45 ≤ 90` passes, yet `17:10 + 0:30 = 17:40`
  exceeds a `17:30` close. The expected result is **infeasible**; a budget-only
  engine would wrongly accept it. This isolates the opening-hours gate.

## Oracle table for boundary sweeps (buffer=5, onward=10, out=10)

For `min_activity_duration = 30`, `need = 55`. Sweep `available_time`:

| available | need | expected |
|---|---|---|
| 53 | 55 | ❌ |
| 54 | 55 | ❌ |
| 55 | 55 | ✅ (boundary) |
| 56 | 55 | ✅ |

The only transition is between 54 and 55. Any engine that flips at 56
(strict `>`) or at 54 (off-by-one) is wrong.

## How to execute once the feature exists

1. Rebuild the baseline (`baseline.md` protocol) at the feature commit.
2. If the logic is **server-side**, add cases 1–15 as pytest functions in a
   **new** file under `team/member-4-qa/` (e.g. `test_recommendation.py`) that
   imports the engine — do **not** edit `tests/test_api.py`.
3. If the logic is **frontend-only** (`web/js`), drive it through the exported
   function or via DOM-level checks; record results manually since no JS runner
   exists.
4. Fill the **Status** column with pass/fail **and the commit hash**. Never mark
   a row passed without an actual run.
