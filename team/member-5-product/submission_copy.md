# Submission Copy

**Author:** Member 5 (product / validation)
**Status:** copy is **ready**. It reflects the app as it exists in code at commit
`d871a30` plus the "What fits now?" feature **as planned** (marked future/in-
progress where not yet verified). Calendar sync and live sensors are presented as
**future work**. Nothing is claimed as working that I haven't confirmed.

## One-sentence description

> BU-sy is an independent, mobile-first student prototype that helps you find a
> place to study, eat, or work out that fits the gap between your classes — with
> every busyness number honestly labeled as sample or real.

## ~100-word project summary

> BU-sy helps students use the gaps between commitments. You tell it how long
> you're free and what you want to do — study, eat, or train — and it points to
> places that fit, factoring in travel time and a safety buffer, and explains
> why each one fits. It shows how busy places are by replaying a recorded day and
> suggesting quieter times. We're deliberately honest about data: campus numbers
> are synthetic and clearly tagged "Sample," while one real room from a public
> research dataset proves the pipeline works on genuine sensor data. It's a
> student project, not affiliated with Boston University.
> *(~100 words.)*

## What works today (confirmed in code at `d871a30`)

- **Busyness view + playback:** a shared clock replays one recorded day
  (7 AM–11 PM); each place shows its latest observation at or before that time,
  and "no data" (never zero) outside recorded hours.
- **Honest data labeling:** synthetic facilities tagged **"Sample"**; the real
  COD room labeled as a historical office room, "not BU," with timezone marked
  unverified.
- **Busyness math:** count ÷ illustrative capacity (sample) or ÷ a room's typical
  high (COD 95th time-weighted percentile), with demo thresholds explicitly
  called out as not validated.
- **Hourly chart + "quieter time":** time-weighted hourly averages and the
  quietest upcoming hour (a historical pattern, labeled as such — not a forecast).
- **Unofficial community events:** students post/join/leave meetups with
  anonymous device identity and optional invite codes.
- **Two deployment modes:** FastAPI server, or a static GitHub Pages build with
  events kept in the browser.
- **Tested server logic:** a pytest suite covers analytics, playback, COD
  history, and the events flow. *(Note: QA could not execute it in the current
  environment — see Member 4's `baseline.md`; no results are claimed here.)*

## What's in progress / not yet verified

- **"What fits now?" recommendation** (time + preference + travel + buffer): the
  feature this submission is built around is **being implemented**; treat any
  recommendation claim as **in progress** until Member 4's test matrix passes.
- **Opening hours:** the API currently returns `opening_hours: null` for every
  facility — hours handling is a known gap.

## Data limitations (state plainly)

- Campus occupancy is **synthetic** — made by the team, not measured at BU.
- Only the **Clemente Room (COD)** uses real data, and it's a **historical office
  conference room**, not a BU facility; its timezone is unverified.
- Capacities are **illustrative**, not official.
- The schedule/programs endpoints return **sample placeholders**, not the real
  FitRec timetable.
- Busyness thresholds (40% / 75%) are **demo values, not validated**.

## Future integration plan

- **Real campus feed:** replace one data-adapter module (`server/sources.py`)
  with an authorized, aggregate count, keeping the same shape — screens,
  analytics, and API stay unchanged. Pilot with a single building first.
- **Calendar integration:** auto-detect free gaps from a student calendar —
  **future work, not implemented or verified.**
- **Live sensor counting:** real-time occupancy — **future work, not implemented
  or verified.**
- **Opening-hours + travel-time data:** source real hours and on-campus walking
  times to replace placeholders.

## Likely judge questions — with honest answers

**Q: Is this real BU data?**
A: No. Campus numbers are synthetic and labeled "Sample." One room uses a real
historical office dataset (COD) to prove the pipeline on genuine sensor data.
We don't track BU facilities.

**Q: Does it connect to my calendar or show live counts?**
A: Not yet. Both are future work. Today you enter your free time manually, and
occupancy is a replay of a recorded day, not live.

**Q: How do you decide something "fits"?**
A: `available time ≥ outbound travel + minimum activity duration + onward travel
+ buffer`, with opening-hours, activity-compatibility, and preference checks. The
buffer is applied once. (This is the feature under active implementation.)

**Q: Why trust the busyness labels?**
A: We don't ask you to trust them blindly — every number carries its provenance
and caveats, thresholds are marked "not validated," and unknown values show as
"no data," never zero.

**Q: What's unique?**
A: We're not claiming uniqueness we haven't verified. The honest pitch:
combining time-fit, preference, travel, and clearly-labeled occupancy evidence in
one mobile view, with unusually transparent data honesty. See `alternatives.md`.

**Q: What would a real pilot take?**
A: One authorized building feed swapped into a single module, plus real opening
hours and walking times. The architecture is already set up so only the data
adapter changes.

---

## The three most important assumptions the team still needs to validate

1. **The problem is real and frequent enough.** We assume students regularly hit
   usable gaps where crowding changes their plans and they'd welcome help
   choosing. This is **untested** until the interviews in `interview_script.md`
   are run.
2. **Students will trust and prefer a transparent-but-synthetic/partly-real
   tool** over just walking over, texting friends, or checking FitRec's own
   page. Our honesty-first bet is **unvalidated** against real behavior.
3. **A real, authorized campus feed is actually obtainable** for a pilot. The
   whole value proposition depends on swapping synthetic data for a real
   aggregate count; we have **not** confirmed access, and calendar/live-sensor
   integration remain unverified future work.
