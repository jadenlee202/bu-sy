# Findings — Independent QA Review

**Author:** Member 4 (independent QA)
**Version inspected:** commit `d871a30968df453756babdb0317ad4dd47245627`
(branch `main`).
**Scope:** static source review + prepared validation package. The
"What fits now?" recommendation feature is **not present** at this commit, so
the matrix in `test_matrix.md` could not be executed. The test suite could not
be run (environment lacks pytest/fastapi — see `baseline.md`). **No pass results
are invented.**

## Severity scale

- **S1 Blocker** — wrong/misleading result a user would act on, or data
  dishonesty.
- **S2 Major** — feature gap or logic risk that will likely cause S1 once wired.
- **S3 Minor** — polish, clarity, or maintainability.
- **Obs** — observation / coordination note, not a defect.

---

## Data-honesty review

The brief asked me to look for seven specific over-claims. Current state at
`d871a30`:

### DH-1 — Synthetic BU numbers presented as live — **Obs (currently handled)**
- **Checked:** `web/js/app.js` (`tag()`, `.hint` text), `server/sources.py`
  (`SYNTHETIC_SOURCE`, `data_mode="synthetic"`), `facilities.json`.
- **Expected vs actual:** Synthetic facilities are labeled **"Sample"**, sourced
  "Synthetic demo data … not a BU measurement", and the UI says "Replaying one
  recorded Monday." No "live" claim is made today.
- **Risk for the new feature:** a recommendation card that drops the "Sample"
  tag would reintroduce this. **Test case 12** guards it.
- **Suggested fix:** carry the `data_mode`/"Sample" label onto every
  recommendation card.

### DH-2 — Capacity inferred from observed peaks — **S3 Minor (watch)**
- **Checked:** `server/sources.py` COD block, `analytics.time_weighted_percentile`.
- **Expected vs actual:** COD has no capacity; its reference is the 95th
  time-weighted percentile ("typical high … Not capacity"). This is **correctly
  labeled as not capacity**. The honesty risk is downstream: a recommendation
  that says "has room" based on this percentile would be inferring availability
  from a peak.
- **Suggested fix:** if recommendations use the COD reference, phrase as
  "relative to its typical high", never "X% full / seats available".

### DH-3 — Whole-building counts used to claim seat/equipment availability — **S2 Major (likely once wired)**
- **Checked:** FitRec is a building total (`sum of 21 areas`); dining/library are
  single building counts.
- **Expected vs actual:** today the app only states busyness, not "a seat is
  free" or "a squash court is open". A recommendation like "FitRec fits — go
  lift" implies a free rack from a **building-level** number.
- **Suggested fix:** when the activity is area-specific (weights, a court), base
  availability on the **area** series (`build_areas`), not the facility total; or
  state "building is moderately busy" without promising a specific resource.
  **Test case 10** (unsupported amenities) and the area data are the hooks.

### DH-4 — Current counts presented as arrival-time forecasts — **S2 Major (likely once wired)**
- **Checked:** `facility_fields()` returns the **latest observation at/before the
  playback time**; `quieterTime()` is the only forward-looking piece and it is
  explicitly phrased "usually quieter at …".
- **Expected vs actual:** the recommendation rule involves `outbound_travel`, so
  the student arrives **later** than "now". If the card shows the current count
  as if it's what they'll meet on arrival, that's a forecast dressed as a fact.
- **Suggested fix:** either show the typical value at the **arrival hour** (COD
  has `typical`; synthetic has `hourly`) or label the number "now, may change by
  the time you arrive". **Test cases 1–7** arrival timing feeds this.

### DH-5 — Unknown timezone silently converted — **Obs (currently handled well)**
- **Checked:** `data/clean_cod.py` (naive timestamps), `sources.py`
  (`timezone=None`, "never converted"), `app.js` comment ("read as text, never
  `new Date(...)`"), `main.resolve_time_of_day`.
- **Expected vs actual:** COD stays naive end-to-end and the UI shows "source
  local time, timezone unverified". **No silent conversion** today.
- **Risk:** a recommendation that mixes COD's naive clock with the campus
  `America/New_York` clock could silently cross zones. **Test case 4/12** watch
  this; keep COD out of campus recs (**case 13**).

### DH-6 — Unsupported confidence percentages — **Obs**
- **Checked:** no confidence/probability figure exists anywhere in the code.
- **Risk:** don't introduce "92% likely to have space" without evidence. If the
  feature adds any %, it must trace to data, not a guess.

### DH-7 — Sample hours or walking times presented as verified — **S2 Major (expected gap)**
- **Checked:** `schedule_data.py` ("SAMPLE … Replace with the published FitRec
  schedule before showing it as real"), `main.facility_fields` sets
  `opening_hours=None` always, and **no walking-time data exists** in the repo.
- **Expected vs actual:** the recommendation needs opening hours and travel times;
  neither is real today. Any value the feature uses is a placeholder.
- **Suggested fix:** label all hours/walking times "sample/estimated" until a
  real source is wired. **Test cases 4, 7, 8** cover unknown routes/hours.

---

## Logic & correctness findings (prepared, against the expected rule)

### F-1 — No recommendation engine exists yet — **Obs**
- **Version:** `d871a30`.
- **Expected vs actual:** brief describes `available >= outbound + duration +
  onward + buffer` with opening-hours/compatibility/preference/data gates.
  **Actual:** only `quieterTime()` (single-facility min-occupancy lookup). No
  travel, duration, preference, or buffer logic present.
- **Repro:** read `web/js/app.js`; search server for travel/duration/buffer →
  none.
- **Action:** re-run `baseline.md` + `test_matrix.md` once the feature merges.

### F-2 — `opening_hours` is hard-coded `None` — **S2 Major**
- **Version:** `d871a30`. **File:** `server/main.py`, `facility_fields()`.
- **Expected vs actual:** feature must respect opening hours; the API exposes
  `opening_hours: null` for every facility.
- **Repro:** `GET /api/facilities` → every row has `"opening_hours":null`
  (confirmed in `web/data/facilities.json`).
- **Suggested fix (coordinate with server owner — do not edit myself):** populate
  `opening_hours` from a real/sample source and feed it into **test case 7/8**.

### F-3 — Buffer-once and boundary (`>=`) are the highest-risk arithmetic — **S2 Major (pre-emptive)**
- **Expected vs actual:** per **cases 1, 2, 5, 6**, the two easiest bugs are
  (a) applying buffer per travel leg instead of once, and (b) using strict `>`
  so the exactly-enough case is wrongly rejected.
- **Oracle:** need = `out+dur+onward+buffer`; feasible iff `need <= available`.
  Case 1 `55<=60` ✅; case 2 `55>54` ❌; double-buffer would compute `60`.
- **Action:** assert on the numeric shortfall, not just the boolean (see matrix).

### F-4 — COD scope leakage risk — **S2 Major (pre-emptive)**
- **Expected vs actual:** COD is an **office room, not BU** (`category:"office"`,
  source note "not BU"). It must not appear as a campus study/gym/dining rec
  (**case 13**).
- **Repro once built:** request a campus recommendation; confirm COD is absent.

### F-5 — Tie-breaking determinism unverified — **S3 Minor (pre-emptive)**
- **Expected vs actual:** **case 15** requires stable ordering for equal
  candidates. `Object.fromEntries`/`Promise.all` ordering in `placesView()`
  follows `facilities` order, which is load order; confirm the recommendation
  sort is stable (e.g. secondary key on `facility_id`).

---

## Test execution summary

| Suite | Result | Note |
|---|---|---|
| `tests/test_api.py` (existing) | **Not run** | env lacks pytest/fastapi; no results invented |
| Recommendation matrix (cases 1–15) | **Not run** | feature absent at `d871a30` |
| Usability tasks | **Not run** | needs real tester + built UI |
| Static source review | **Done** | findings above |

## What's still pending (blockers)

1. **A runnable Python env** (Python ≥ 3.11, `pip install -r requirements.txt`)
   to execute `python -m pytest` and record a real baseline.
2. **The merged recommendation feature** to execute matrix cases 1–15 and the
   usability tasks.
3. **Confirmation of the implementer's actual constants** (buffer size, per-
   activity minimum durations, onward-travel default) so my hand-calculated
   oracle values match their intent.

I did not modify any shared/application file. All fixes above are **suggested**
and must be coordinated with the owning teammate.
