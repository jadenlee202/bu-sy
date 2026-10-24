# Data

Two inputs, used once each. Nothing here is live, and nothing here measures BU.

| File | What it is | Real? |
|---|---|---|
| `bu_campus_synthetic_occupancy.csv` | One made-up Monday (2026-10-19), hourly 08:00–22:00: 21 FitRec areas, 4 dining halls, Mugar Library. 390 rows. | **No, synthetic** |
| `clean_cod_occupancy.csv` | Every valid event from the Clemente conference room in COD, cleaned by `clean_cod.py`. | **Yes**, but an office room, not BU |
| `sample_10_records.csv` | The first 10 rows of the cleaned COD file (chronological, not random). | Yes |

Columns everywhere: `facility_id,timestamp,occupancy_count`.

## COD (real historical data)

**Source:** Kin Sum Liu, Elvin Vindel Pinto, Sirajum Munir, Jonathan Francis, Charles Shelton, Mario Bergés, Shan Lin.
*COD: A Dataset of Commercial Building Occupancy Traces.* Zenodo, 2017.
[doi:10.5281/zenodo.996587](https://doi.org/10.5281/zenodo.996587). License: **CC BY-SA 4.0**, so the cleaned
files in this folder are shared under the same license with this attribution.

**Regenerate:** `python data/clean_cod.py` (downloads the archive; standard library only).

**Cleaning results** (run on 2026-10-24):

| | |
|---|---|
| Source file | `COD/Bosch_Office_1/processed_occupancy_FORK_Clemente.csv` |
| Valid records | 8,340 |
| Skipped | 1 (the header row); 0 malformed; 0 negative counts |
| Range | 2015-08-26 07:00:00 → 2016-06-06 20:00:00 |
| Days | 165, weekdays only (Mon 34, Tue 34, Wed 35, Thu 30, Fri 32) |
| Counts | 0–22 people |

**Things to know before analysing it**

- **Event-based, not hourly.** A row is written when someone enters or leaves, so busy periods have many
  rows and quiet ones have few. Averaging rows would overweight busy periods; we use time-weighted
  averages instead (each count holds until the next row).
- **Each recorded day runs 07:00–20:00.** Every day starts with a `0` row at 07:00 and ends with a `0` row
  at 20:00, so counts are never carried overnight. Outside that window we show *no data*, not zero.
- **Timezone unverified.** Timestamps are kept exactly as written (no offset added, never converted to
  New York time). The app labels them "source local time; timezone unverified".
- **Estimated counts.** Depth sensors at the doorways estimated these, so they are not perfect ground truth.
- **Capacity unknown.** We show no "% full". Busyness is relative to the room's own history: its
  95th-percentile time-weighted count (4 people).

## Synthetic campus data

Made by the team for the demo. Capacities used for busyness (in `server/sources.py`) are illustrative too.
The FitRec building total is the sum of its 21 areas. The `Hackathon.pdf` notes also contain this same table,
plus an older sample (FitRec / Howard Thurman / Mugar / Agganis) that this CSV replaces, so it isn't used.
