# BU-sy Usability Test Script (≈10 minutes)

**Branch:** `research/student-usability` (off `main`). No application code changed.
**Author:** usability research (Member 3 / research role).
**Status:** ready to run with a human facilitator and 3–5 students. No test has
been run; this file is the protocol, not results.

---

## Which build to test (read first)

BU-sy has features at different stages. The facilitator must know which build is
in front of the student, because several tasks below exercise the
**"What fits now?" planner**, which is **not on `main` yet** — it lives on the
`feature/what-fits-now` branch (and the FitRec grouping work on `dennis-1`).

| Feature | Where it lives | Tasks that need it |
|---|---|---|
| Places list + playback + "quieter time" | `main` (shipped) | Task 5 (partly) |
| Community events (meetups) | `main` (shipped) | none here |
| "What fits now?" planner (free window, travel, buffer) | `feature/what-fits-now` | Tasks 1, 2, 4 |
| Workout-type grouping of FitRec | `dennis-1` | Task 1 (interest part) |

**Rule for the facilitator:** run the study on the **planner build** so all five
tasks apply. If only `main` is available, mark Tasks 1, 2, and 4 as **"feature
not in build"** on the recording sheet — do **not** improvise a substitute and
do **not** record a pass. Note the exact commit/branch at the top of each
recording sheet.

## Facilitator rules

- One student at a time; ~10 minutes total.
- **Ask about recent real behavior before any opinion about the idea** (see the
  warm-up). Never ask leading questions ("wouldn't this be useful?").
- Give one task at a time. Read it verbatim, then stay quiet. Let the student
  struggle for a bit before offering help.
- Record **completed independently / completed with help / failed**, plus the
  other fields on the recording sheet. Capture quotes verbatim where you can.
- You are testing the app, not the student. If they're stuck, that's data.
- Anonymous: no names, no BUID. Use a participant code (P1, P2, …).

## Warm-up — recent real experience (≈2 min, ask BEFORE the tasks)

Neutral, behavior-first questions. Capture answers before the student sees the app.

1. "Think about the last time a place on campus being too crowded changed what
   you did. What happened?"
2. "When you have a gap between classes and want to study, eat, or work out, how
   do you decide where to go right now? Walk me through the last time."
3. "What would make you trust — or doubt — a busyness number an app showed you?"

Do not pitch the app during the warm-up.

## The five tasks (≈7 min)

For each task, hand the student the device at the start screen for that flow.

### Task 1 — Find a workout that fits a free window *(needs planner; interest part needs `dennis-1`)*
> "You have about 90 minutes free right now before your next class. You want to
> work out. Use the app to find a place that fits. If you specifically wanted to
> swim, show me how you'd narrow it to that."
- **Looking for:** can they enter the free window, run it, and read the FitRec
  result as one destination with areas inside? Can they find the workout-type
  picker and narrow to swimming?

### Task 2 — Change the next destination and explain the effect *(needs planner)*
> "Now say that after your workout you have to be at Warren Towers instead of
> where you first said. Change that in the app. Tell me what changed in the
> result and why."
- **Looking for:** do they find the "heading to" field? Do they understand that
  onward travel time now counts and can change what fits / the timings?

### Task 3 — Find somewhere to study with a required amenity *(planner; study flow on `feature/what-fits-now`)*
> "You need to study for an hour and you must have outlets. Find somewhere."
- **Looking for:** can they switch activity to Study, find the "needs outlets"
  option, and understand that unlisted ≠ confirmed-absent?

### Task 4 — Hit a window where nothing fits, then recover *(needs planner)*
> "Change your free time to just 15 minutes and look for a place to eat across
> campus. What does the app tell you, and what would you do next?"
- **Looking for:** do they reach a clear "nothing fits" state? Do they use a
  suggested fix (extend time, shorter minimum, different activity) or get stuck?

### Task 5 — Explain what's real, historical, or synthetic *(runnable on `main`)*
> "Look at the busyness numbers on this screen. Tell me, in your own words,
> which of these are real live BU numbers, which are historical, and which are
> made up — and how you can tell."
- **Looking for:** do they notice the **"Sample"** vs **"Real data"** tags, the
  "replaying one recorded Monday" note, and that the COD room is a historical
  office (not BU, timezone unverified)? Do they mistake any of it for live data?

## Wrap-up (≈1 min)

> "Last thing: would any of what you saw actually change where you'd go in a gap
> between classes? Be honest — including if the answer is no."

Record the answer verbatim. Thank them. No debate, no pitching.

## Capture per task (facilitator fills the recording sheet)

For every task record all of:
1. **Outcome:** completed independently / completed with help / failed / feature
   not in build.
2. **Confusing wording** the student stumbled on (quote it).
3. **Misunderstood data claims** (e.g. thought "Sample" was live, thought a
   building count meant a free machine).
4. **Would it change their decision?** yes / no / unsure — with their words.
5. **Information they needed but couldn't find.**

See `recording_template.md`.
