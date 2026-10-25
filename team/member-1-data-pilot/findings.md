# Findings: existing BU facility-usage data

Checked: 2026-10-24. Investigator: Member 1 (with Claude). Nothing here has been confirmed by FitRec staff.

## TL;DR

- FitRec publishes a **Power BI "publish to web" report** of **visits** (turnstile entries). It does **not** report occupancy (people currently inside).
- The public view shows **hourly visit counts for the last 7 days**, a **weekly visits history**, and totals for yesterday, the academic year and the calendar year.
- **No export, download, API or reuse terms are offered** on the page or in the report. Being publicly viewable doesn't make the data downloadable or licensed for reuse. We have **not** extracted any data from it.
- The likely data owner is FitRec **Business & Analytics** (see Contacts).

## Sources (direct links)

| # | Source | What it is |
|---|--------|-----------|
| S1 | https://www.bu.edu/fitrec/peak-quiet-hours/ | Official FitRec "Peak & Quiet Hours" page |
| S2 | `https://app.powerbi.com/view?r=eyJrIjoiYmFkYTZlY2QtMTkwYi00ODNhLTkzNmEtN2I2ZmJmODUzMjk0IiwidCI6ImQ1N2QzMmNjLWMxMjEtNDg4Zi1iMDdiLWRmZTcwNTY4MGM3MSIsImMiOjN9` | The Power BI report embedded in S1 (iframe title: **"Big FitRec Visits (wordpress)"**) |
| S3 | https://www.bu.edu/fitrec/wp-json/wp/v2/pages?slug=peak-quiet-hours | WordPress metadata for S1 (page id 23744) |
| S4 | https://dailyfreepress.com/2025/01/30/fitrec-sees-surge-in-visitors-develops-new-usage-heat-map | Daily Free Press, Julia Hendler, 2025-01-30 |
| S5 | https://www.bu.edu/articles/2025/fitrec-what-to-know | BU Today, Sangmin Song (COM'26), 2025-11-03 |
| S6 | https://www.bu.edu/fitrec/about-us/contact-us/ | FitRec staff directory |
| S7 | https://www.bu.edu/fitrec/visit-us/hours/ and https://www.bu.edu/fitrec/files/2026/07/Fall-2026-Summer-2027.pdf | Building hours |

## What is verified

Each item gives its source and how we checked it.

1. **The S1 page has no text explaining the data.** Apart from the heading, the only content is the iframe embed. There's no methodology, no update-frequency statement and no download link. *(S1: fetched the raw HTML and searched it for iframe, csv, xlsx and API links.)*
2. **The embed is a Power BI "publish to web" report** titled "Big FitRec Visits (wordpress)". *(S1 raw HTML)*
3. **The metric is visits.** The weekly bar chart is labelled **"visits per week"**, and the report's accessibility labels include "Visits". *(S2: rendered with headless Chrome on 2026-10-24, then screenshot and DOM text reviewed.)*
4. **What the public view shows** (S2, as rendered on 2026-10-24):
   - Headline tiles: **Calendar Year 754,318**, **Academic Year 197,474**, **Yesterday 3,434**.
   - A **heat map of the last 7 days** (Sat 10/17/26 – Fri 10/23/26), with one row per hour from **5:00 AM to 10:00 PM**. Each cell shows a count. On weekdays the 6:00 AM row is about 140–210 and the 3–4 PM rows are about 250–330.
   - A **weekly visits bar chart** coloured by term (Fall, Spring, Summer). It covers roughly 40 weeks, from about 6,600 per week in summer to about 28,400 per week in fall.
   - Bookmarks labelled **"Last 7 Days"** and **"Previous Weeks"**.
   - **No visible export or download control.** That is normal for publish-to-web, but we did not confirm how this report's export settings are configured.
5. **Turnstiles are the data source** (stated, not independently verified). FitRec's Director of Finance & Admin (Shaun Bossio) described the heat map as built from "data from the gym turnstiles", showing "what times are busier over the last seven days." *(S4)*
6. **Update cadence (stated by BU, not measured):** BU Today calls it "usage data FitRec updates daily." *(S5)* The "Yesterday" tile fits a daily refresh. We have observed only one snapshot, though.
7. **Page history:** S1 was created on 2025-02-12 and last modified on 2025-10-10. *(S3)* That modified date is for the WordPress page, not the data.
8. **Context figures** (reported, not verified): "more than 4,000 members stopping by every day" *(S5)*, and 34,761 guests in one week of spring 2025 *(S4)*.

## Why visits ≠ occupancy (important for BU-sy)

Our app's datasets use `occupancy_count`, meaning people present at a timestamp (see `data/bu_campus_synthetic_occupancy.csv`). FitRec's numbers are **entries per hour**. Turning them into occupancy needs either:

- exit counts (occupancy = start + entries − exits), or
- an assumed visit duration (occupancy at hour *h* ≈ the sum of entries over the previous *d* hours). This is a **modelling assumption** and must be labelled as one.

So FitRec visits must **not** be loaded into an `occupancy_count` column as-is. Label them `visits` or `entries`.

## Unknown / unresolved questions

| # | Question | Why it matters |
|---|----------|----------------|
| U1 | Is the data downloadable or reusable at all? What are the terms? | Without permission we cannot ship it in the app |
| U2 | Do turnstiles record **exits**? Is there an exit gate count or an occupancy figure? | Decides whether real occupancy is possible |
| U3 | Does each heat-map row label (for example "5:00 AM") mean the 5:00–5:59 bucket? Is it entries started in that hour? | Interval semantics |
| U4 | Timezone. Presumably America/New_York, but how are DST transitions handled? | Joining with other data |
| U5 | Facility coverage. "Big FitRec" suggests 915 Comm Ave only. Does it include the pool, the rink, or other gyms (for example Case Gym)? Are there per-zone counts, such as the weight room? | BU-sy recommends specific spaces |
| U6 | Are re-entries, guests, staff, class or event attendees, and failed swipes deduplicated or excluded? | Count meaning |
| U7 | Is a finer interval available (for example 15 minutes) and how much history is there? | Model quality |
| U8 | What time does the daily refresh happen, and how big is the lag? | Freshness in the app |
| U9 | Would FitRec support or permit a student counting pilot? | Pilot feasibility |

## Contacts (from S6; nobody has been contacted)

- **Brendan Buckley**, Assistant Director, Business & Analytics. The most likely owner of the report. *(Our inference from the title.)*
- **Shaun Bossio**, Director, Finance & Admin. Quoted as the person behind the heat map *(S4)*.
- **Alexander Southall**, Director, Facilities & Operations, or **Keith Kantor**, Assistant Director, Facilities & Operations. For turnstiles, doors and a pilot.
- General inbox: **fitrec@bu.edu**, (617) 358-3740. The staff page lists no individual email addresses, so route the request through fitrec@bu.edu and ask for it to be forwarded to Business & Analytics.

## Not done, on purpose

- We did not query Power BI's internal data endpoints or scrape values in bulk. Reuse needs permission (U1).
- We did not change the app, the datasets, the server, the tests or the root README.
