# Existing Alternatives & Positioning

**Author:** Member 5 (product / validation)
**Status:** desk research using official sources where possible. Facts about BU
FitRec are cited to bu.edu. Claims about third-party tools are described at a
general level; anything I could not verify is marked **[UNVERIFIED]**. I did not
invent competitor findings.

> Content from external sources below is paraphrased for licensing compliance.

## 1. BU FitRec's own "Peak & Quiet Hours" + published guidance

- BU runs a **Peak & Quiet Hours** page for FitRec traffic, linked from our own
  README: [bu.edu/fitrec/peak-quiet-hours](https://www.bu.edu/fitrec/peak-quiet-hours/).
- A 2025 BU article states FitRec sees more than 4,000 visitors daily, is
  generally least crowded from **6 am to 2 pm**, and builds up later in the day,
  especially **4–8 pm**
  ([New to FitRec?](https://www.bu.edu/articles/2025/fitrec-what-to-know/)).
- FitRec publishes **facility hours** (e.g. a summer schedule of Mon–Thu 6 am–10
  pm, Fri 6 am–8 pm, Sat–Sun 8 am–8 pm) and notes schedules are **subject to
  change** and some areas may be unavailable at times
  ([Hours](https://bu.edu/fitrec/visit-us/hours/),
  [Summer services](https://www.bu.edu/summer/high-school-programs/admitted-students/student-services/health-wellness/),
  [Membership policies](https://www.bu.edu/fitrec/about-us/forms-policies/membership-policies)).

**Strengths:** official, authoritative, free, covers real FitRec patterns and
hours.
**Gaps for a student in a gap-between-classes:** it's FitRec-only (not dining or
libraries), it's a general pattern page rather than a personalized "does this
fit my next 50 minutes?" answer, and it doesn't combine travel time or activity
choice.

*Content was rephrased for compliance with licensing restrictions.*

## 2. Campus occupancy / space tools (general category) **[UNVERIFIED specifics]**

Many universities and libraries deploy live space-availability or seat-finder
tools (sensor counts, study-room booking dashboards). Whether BU exposes a
single student-facing live-occupancy tool across study/dining/gym at the time of
writing is **[UNVERIFIED]** — I did not confirm a specific product. If one
exists, it should be compared directly before we claim any gap.

**Strengths (category):** can be live and authoritative when official.
**Gaps (category):** usually single-domain (just libraries, or just the gym),
often desktop-oriented, and rarely explain *why* a place fits a specific time
window with travel included.

## 3. General "popular times" tools (e.g. mapping/search popular-times) **[UNVERIFIED specifics]**

Consumer map/search products show typical "popular times" and sometimes a live
busyness estimate for public venues.

**Strengths:** familiar, zero setup, cover many venues.
**Gaps:** coverage of specific campus interiors (a particular dining hall line,
a weight-room floor, a library reading room) is inconsistent; they don't know a
student's class schedule, free gap, or on-campus walking distances; and they
don't distinguish a whole-building count from "is there a free squash court".
Exact coverage for BU venues is **[UNVERIFIED]**.

## The gap BU-sy is probing

Combining **four** things in one student-facing view:

1. **Time feasibility** — does the option fit the actual free gap
   (travel + activity + buffer)?
2. **Personal preferences** — study vs eat vs train, and activity compatibility.
3. **Travel** — on-campus distance between where you are and the option.
4. **Transparent occupancy evidence** — every number labeled by provenance
   (**Sample** synthetic vs the one real historical COD room), with honest
   caveats about thresholds and timezone.

**Honest positioning:** I am **not** claiming this combination is unique — I have
not verified every campus or third-party tool. The defensible claim is narrower
and true today:

> BU-sy is an independent student prototype that tries to answer "what fits my
> next free gap?" by combining time feasibility, preference, travel, and
> **clearly-labeled** occupancy evidence in one mobile view. Its campus numbers
> are synthetic; one room shows the pipeline on real historical data.

## Comparison table

| Capability | FitRec Peak/Quiet page | Campus occupancy tool (category) | Popular-times tools | BU-sy (prototype) |
|---|---|---|---|---|
| Authoritative/live BU data | ✅ (FitRec only) | ✅ if official **[UNVERIFIED]** | ⚠️ estimate | ❌ synthetic (+1 real historical room) |
| Covers study + dining + gym | ❌ gym only | ⚠️ often single-domain | ⚠️ inconsistent coverage | ✅ (as sample data) |
| Fits a specific free gap (time budget) | ❌ | ❌ typically | ❌ | 🔜 the feature under build |
| Personal activity preference | ❌ | ❌ typically | ❌ | 🔜 planned |
| On-campus travel time | ❌ | ❌ | ⚠️ driving/transit, not campus walk | 🔜 planned |
| Transparent data provenance | ✅ (official) | varies | ❌ | ✅ explicit labels |
| Mobile-first | ⚠️ | varies | ✅ | ✅ |

🔜 = depends on the "What fits now?" feature currently being implemented; not yet
verified working.

## What still needs checking before any public claim

- Confirm whether BU already offers a cross-domain live-occupancy student tool
  (turns "[UNVERIFIED]" into a real comparison).
- Verify third-party popular-times coverage for the specific BU venues we name.
- Re-label every "🔜" as done **only** after Member 4's matrix passes on the real
  build.
