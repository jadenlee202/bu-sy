# Group FitRec workout options into one destination

Branch: `feature/group-workout-options` (based on `origin/feature/what-fits-now`,
commit `129c7fb`). Not pushed, not merged.

## Problem

In the "What fits now?" planner, FitRec was represented as **seven separate area
places** (two weight rooms, two basketball courts, biking, climbing, pool), each
a full `Place` at the same `fitrec` location with identical walking times. For a
`workout` search they were ranked as independent destinations, so the top-3 list
(`MAX_SHOWN = 3`) filled up with near-identical FitRec cards and crowded out any
real variety. Study and dining never hit this because each is one facility-level
place.

## Desired behavior (from the brief) and how it's met

| Requirement | How |
|---|---|
| Show FitRec as one destination | Area options sharing a `facility_id` collapse into a single grouped option in the engine. |
| Within it, show eligible activities/areas | The grouped card lists each eligible area with its own synthetic busyness and any reservation. |
| Choose workout interests (weights/basketball/cardio/swimming…) | New `interest` tag per area + `interest_labels`; a `interests` request field filters areas. Picker shown only for workout. |
| Match recommendations to the chosen activity | Interest filter runs in `evaluate`, right after the activity-compatibility check, before travel/time math. |
| Show applicable area reservations and closures | Each area keeps its own `closures`; reserved areas are excluded from the fit and listed areas show "reserved for … (sample)". |
| Retain shared facility travel calculation | All FitRec areas share one `location_id`, so `there`/`onward` are identical; the group inherits the representative area's travel. Asserted in tests. |
| Avoid several near-identical FitRec cards | Exactly one FitRec card appears; excess areas live inside it, and the excluded "why not" list also collapses to one FitRec row. |
| Reuse the existing engine, no second ranking | Grouping runs **after** the existing `rankKeys`/`compare` sort; the group is ranked by its best area's keys. No new scoring. |
| Preserve study & dining flows | Facility-level places (`area_id === null`) pass through `groupByFacility` unchanged. Test: "dining/study unchanged". |

## Data-honesty rules (all preserved)

- Every area still carries the **"Demo · Synthetic"** tag; the card header shows
  it and the disclaimer is unchanged.
- **Area counts are never summed** into a building number. The card's headline
  busyness is the single top-ranked area's count, explicitly labeled "the
  top-ranked area below, not a whole-building count." Test:
  "never sums to a building number."
- **No equipment availability is inferred** from headcount — the areas list
  shows busyness level + count only, never "a rack is free."
- **No area headcount is inferred from building-entry counts** — area busyness
  comes from each area's own `observations`, never the facility total.
- **Unknown stays unknown**: an unlisted interest is a validation error
  (`interests` field), not a guess; an interest with no supporting area returns
  no fit plus a "show all workout types" suggestion; unknown hours still route
  to "check hours."

## Before / after

**Request:** workout, 90 free minutes, from Mugar to Warren (sample scenario
shape), default prefer-quiet.

- **Before:** up to 7 FitRec cards compete; top 3 are all FitRec areas
  (e.g. Weight Room 1, Pool, Biking), differing only by area name and count. No
  way to say "I want to swim." Dining/study unaffected.
- **After:** one **FitRec** card, ranked among the other destinations by its best
  eligible area, listing the eligible areas inside (each with its own synthetic
  count and any reservation). A **Workout type** picker (Weights / Basketball /
  Cardio / Swimming / Climbing) narrows the areas; picking Swimming shows only
  the Competition Pool. If nothing matches, a clear empty state offers to widen
  the window, shorten the minimum, change activity, or drop the interest filter.

## Files changed (7)

- `data/campus_sample.json` — add `interest` per FitRec area, `interest_labels`,
  and `interests` on the workout activity.
- `server/campus.py` — `ActivityInfo.interests`, `Place.interest`,
  `Campus.interest_labels`, with validation that every offered/used interest has
  a label and every place interest is known.
- `web/js/recommend.js` — `interests` request field + validation; interest
  filter in `evaluate`; `groupByFacility` (post-sort collapse); per-facility
  dedupe of the excluded list; "drop interest" suggestion.
- `web/js/plan.js` — workout-type picker (shown only for workout); grouped card
  with an eligible-areas block; facility names in the "more"/"check hours"/
  "why not" rows.
- `web/styles.css` — styles for `.workout-interests` and `.rec-areas`.
- `web/data/campus.json` — regenerated static payload (see caveat below).
- `tests/recommend.test.mjs` — 10 new cases (grouping, shared travel, no
  summing, interest filter, no-eligible-area, reserved sibling, excluded
  collapse, dining/study untouched, invalid interest).

## Validation results

**Environment blocker:** this machine has **no Node.js and no pytest/FastAPI**
(`node: command not found`; `No module named pytest`). I therefore could **not
execute** the JS engine tests (`node --test tests/`) or the Python API tests. I
am not inventing results. The checks below are what I ran vs. what remains.

| Check | Status |
|---|---|
| `data/campus_sample.json` parses; interest tags correct | **Pass** (Python `json`) |
| `web/data/campus.json` parses; area interests set, non-area interests null | **Pass** (Python `json`) |
| Engine/UI static self-review (refs, grouping invariants, honesty) | **Done** |
| `node --test tests/` (incl. 10 new grouping/interest tests) | **Not run** — no Node here |
| `python -m pytest` (campus loader validation) | **Not run** — no pytest/FastAPI |
| Mobile navigation / empty-state visual check | **Not run** — needs a browser |

### To verify (anyone with the runtimes)

```bash
node --test tests/              # expect existing + 10 new tests green
python -m pytest                # campus.py loads with new fields
python server/export_static.py  # confirm web/data/campus.json matches byte-for-byte
```

**Caveat on `web/data/campus.json`:** it is normally generated by
`export_static.py`. I hand-synced it to match the loader's output shape
(adding `interest`/`interest_labels`/`interests`), and validated it parses, but
it should be regenerated with the command above to guarantee an exact match.

## Mobile & accessibility notes (need a browser to confirm)

- The workout-type picker reuses the existing `.check` checkbox pattern (≥18px
  targets, keyboard-focusable, labeled). It only appears for workout via
  `syncForm`.
- The areas list uses the shared `level()` helper, so busyness is conveyed by a
  3-step meter **and** a word — not color alone — consistent with the rest of
  the app.
- Grouped card content reflows in a column; the areas block is a bordered
  sub-list. Visual confirmation at 360px width is still **pending** (no browser).

## Scope / coordination

Changes touch shared planner files (`recommend.js`, `plan.js`, `campus.py`,
`campus_sample.json`, `styles.css`) owned by the planner/frontend authors —
coordinate before merging. No push or merge performed, per instruction.
