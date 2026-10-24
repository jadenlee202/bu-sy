# Usability Checklist — Student Tester Tasks

**Author:** Member 4 (independent QA)
**Version inspected:** commit `d871a30`.
**Status:** The "What fits now?" recommendation UI does not exist yet at this
commit. These tasks are **prepared**; each UI step that depends on the unbuilt
feature is marked **[PENDING feature]**. Tasks that exercise the current app
(places list, playback, events) can be run today and are marked **[runnable now]**.
Do not record a task as passed unless a real person attempted it on a real build.

## How to run

- Recruit 1 student tester per session; no coaching, no leading.
- Give one task at a time; ask them to think aloud.
- Record: did they complete it unaided (yes / with hint / no), time taken, and
  any confusion. Keep observations factual; interpretation goes in a separate
  column.

## The five tasks

### Task 1 — Find a recommendation **[PENDING feature]**
> "You have about an hour free right now. Find a place the app says fits that
> gap."
- **Success:** tester reaches a recommended option that respects their available
  time without help.
- **Watch for:** can they find where to enter available time? Is the "fits"
  result distinguishable from the plain busyness list?

### Task 2 — Understand why it fits **[PENDING feature]**
> "Tell me, in your own words, why the app picked that place."
- **Success:** tester can state the travel + activity + buffer reasoning from the
  on-screen explanation, not a guess.
- **Watch for:** is the breakdown (outbound travel, duration, onward travel,
  buffer) visible and in plain language, or hidden/jargon?

### Task 3 — Recognize sample data **[runnable now]**
> "Is the number shown for this place a real, live count from BU right now?
> How can you tell?"
- **Success:** tester identifies that synthetic facilities are labeled
  **"Sample"** and that the app is replaying a recorded day — not live.
- **Watch for:** do they mistake the "Sample" tag or the playback clock for a
  live feed? Current UI cues: the "Sample" vs "Real data" tag, the hint
  "Replaying one recorded Monday", and "source local time, timezone unverified"
  on COD.

### Task 4 — Change preferences **[PENDING feature]**
> "You'd rather study than work out. Change the app so it suggests study spots."
- **Success:** tester finds and changes the activity/preference control and the
  results update.
- **Watch for:** is the control discoverable? Does the result set visibly react?
  (Today only category filter chips exist: All / Fitness / Dining / Library /
  Real data — note whether testers conflate filtering with preference-setting.)

### Task 5 — Recover when nothing fits **[PENDING feature]**
> "Set your free time to just 15 minutes. What does the app do, and what would
> you do next?"
- **Success:** tester sees a clear empty state and understands the suggested
  recovery (widen time, change activity), not a blank screen or a forced
  unsuitable pick.
- **Watch for:** dead-ends, confusing emptiness, or a recommendation that
  obviously violates the 15-minute limit.

## Accessibility & inclusive-design checklist

Run these against whatever is on screen. **[runnable now]** items can be checked
on the current build; **[PENDING feature]** items need the recommendation UI.

### Mobile layout **[runnable now]**
- [ ] Usable at 360 px width (common phone) with no horizontal scroll.
- [ ] Tap targets (filter chips, play/pause, list rows) ≥ ~44 px.
- [ ] Playback slider operable with a thumb; time label stays readable.
- [ ] Recommendation cards reflow instead of truncating **[PENDING feature]**.

### Keyboard access **[runnable now]**
- [ ] Every control reachable by Tab in a sensible order (nav, search, chips,
      playback toggle, slider, list links).
- [ ] Visible focus indicator on each control.
- [ ] Play/pause and reset activate with Enter/Space.
- [ ] Event join/leave/cancel buttons and the new-event form are fully keyboard
      operable.
- [ ] Recommendation controls (time entry, preference) are keyboard operable
      **[PENDING feature]**.

### Labels & semantics **[runnable now]**
- [ ] Search input has an accessible name (currently `aria-label="Search places"`).
- [ ] Playback group labeled (currently `role="group" aria-label`), slider
      labeled.
- [ ] Live regions announce updates (places list uses `aria-live="polite"`;
      confirm it is not over-chatty during playback).
- [ ] Chart has a text alternative (currently an `aria-label` summary on the
      `<svg>` plus a "Show as table" fallback) — confirm the table is reachable.
- [ ] Icon-only buttons have `aria-label` (play, pause, reset do; re-check any
      new ones).

### Error states **[partly runnable now]**
- [ ] Data-fetch failure shows a readable message + "Try again" (current
      `failure()` state) rather than a blank screen.
- [ ] Join errors (wrong code → 403, full → 409) surface inline, readably.
- [ ] "Nothing fits" and "route time unknown" states are explicit and actionable
      **[PENDING feature]**.

### Color-independent status cues **[runnable now — important]**
- [ ] Busyness level is distinguishable **without color**: today each level has a
      **text label** ("Quiet/Moderate/Busy/No data") plus a 3-bar meter, not color
      alone. Verify the meter fill is distinguishable in grayscale.
- [ ] "Sample" vs "Real data" conveyed by text, not just tag color.
- [ ] Feasible vs infeasible recommendations distinguished by text/icon, not
      color alone **[PENDING feature]**.
- [ ] Check with a grayscale filter and a color-blindness simulator.

## Reporting

For each tester and task, record:
`task | runnable? | completed (y / hint / n) | time | observed quote | QA interpretation`.
Keep "observed" and "interpretation" in separate columns so raw behavior stays
untainted. Do not assert a usability pass for any **[PENDING feature]** item
until the feature is built and a real tester has tried it.
