# Demo Script (≈3 minutes)

**Author:** Member 5 (product / validation)
**Status:** script is **ready**. Every step that depends on the live
"What fits now?" UI is marked **[VERIFY ON APP]** because the feature is still
being built and I have not driven it. Steps that reflect the current, confirmed
app are marked **[confirmed in code]**. Do not present unverified UI behavior as
real during the actual demo — swap placeholders for what you see on screen.

## One-line setup (say this first)

> "BU-sy is an independent student prototype — not a BU product — that helps you
> figure out where to study, eat, or work out in the gap between classes, and
> it's honest about which numbers are real."

## Beat 1 — A concrete student problem (≈30 sec)

> "It's 1:40. Maya has a 55-minute gap before her 2:35 class across campus. She
> wants to get a workout in but doesn't want to walk over and find the weight
> room slammed — or get stuck and be late."

*(Real, relatable, time-boxed. No app needed yet.)*

## Beat 2 — One feasible recommendation (≈40 sec) **[VERIFY ON APP]**

> "She opens BU-sy, enters that she's free for 55 minutes and wants to lift.
> It suggests FitRec."

**[VERIFY ON APP]** Confirm the recommendation UI exists, accepts available time
+ activity, and returns FitRec. If the feature isn't wired yet at demo time,
show the current **places list + playback** instead and narrate the intended
flow, clearly saying "this part is in progress."

## Beat 3 — The travel / activity / buffer explanation (≈30 sec) **[VERIFY ON APP]**

> "And it shows *why* it fits: about 10 minutes to walk over, a 45-minute
> minimum workout, 10 minutes on to class, plus a 5-minute buffer — 70… wait,
> that's over 55. So BU-sy would actually flag this as *too tight* and suggest a
> shorter activity or a closer option."

**Use honest numbers.** The rule is
`available ≥ outbound + duration + onward + buffer`. Pick a demo case that is
genuinely feasible (e.g. a 30-minute study session: 10 + 30 + 10 + 5 = 55 ≤ 55,
exactly fits). **[VERIFY ON APP]** that the on-screen breakdown matches this
arithmetic — Member 4's `test_matrix.md` case 1 is the oracle.

## Beat 4 — An example where nothing fits (≈25 sec) **[VERIFY ON APP]**

> "Now say Maya only has 15 minutes. BU-sy doesn't force a bad pick — it says
> nothing fits that gap and suggests widening the time or choosing something
> closer."

**[VERIFY ON APP]** Confirm the empty/"nothing fits" state exists and is
graceful (Member 4 usability Task 5).

## Beat 5 — Honest data labeling (≈25 sec) **[confirmed in code]**

> "Important: the campus numbers here are **sample data** — they're clearly
> tagged 'Sample', and the app says it's replaying one recorded Monday. The one
> **real** data source is a historical office conference room from a public
> research dataset (COD), labeled 'office room, not BU', with its timezone marked
> unverified. We're showing the pipeline works on real sensor data without
> pretending to track BU."

*(All of this is confirmed in the current code: the "Sample"/"Real data" tags,
the "Replaying one recorded Monday" hint, the COD source note and
"timezone unverified" label.)*

## Beat 6 — The next real-campus pilot (≈20 sec)

> "The next step is a real pilot: swap our data adapter for one authorized,
> aggregate campus count — the code is built so only that one module changes —
> and start with a single building's official feed. Calendar sync and live
> counting are future work, not claims we're making today."

## Closing line

> "So: a mobile-first way to see what fits your gap, with every number labeled
> for what it really is. Honest prototype, clear next step."

## Demo-day pre-flight checklist

- [ ] **[VERIFY ON APP]** recommendation input (time + activity) works
- [ ] **[VERIFY ON APP]** a genuinely feasible case displays with correct
      travel/activity/buffer breakdown (matches matrix case 1)
- [ ] **[VERIFY ON APP]** "nothing fits" empty state is graceful
- [ ] **[confirmed]** "Sample" vs real-data labels visible
- [ ] Fallback ready: if the feature isn't merged, demo the current places list +
      playback and narrate the in-progress flow honestly
- [ ] Have Member 4's `findings.md` open in case a judge asks about data honesty
