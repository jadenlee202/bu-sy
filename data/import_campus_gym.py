"""Import "Crowdedness at the Campus Gym" as a historical reference (not BU, not live).

Source: Nick Rose, "Crowdedness at the Campus Gym", Kaggle dataset
nsrose7224/crowdedness-at-the-campus-gym (version 2, updated 2017-03-19).
License: Open Database License (ODbL 1.0) for the database, Database Contents
License (DbCL 1.0) for its contents. Files derived from it in this repo are
shared under the same terms with this attribution.

Reads the original file, unchanged, from data/raw/campus_gym/data.csv and writes:
    clean_campus_gym_occupancy.csv   facility_id,timestamp,occupancy_count (chronological)
    campus_gym_import.json           statistics, gap policy, playback days (read by the server)
    campus_gym_quality.md            the same summary for people

Run:    python data/import_campus_gym.py                 (offline: uses the stored original)
        python data/import_campus_gym.py --download      (fetch from Kaggle's public endpoint first)
        python data/import_campus_gym.py --csv path/to/data.csv

Timestamps: the `date` column is the full observation datetime with a UTC offset
(-07:00 or -08:00). It is kept exactly as written: no named timezone is assigned,
nothing is converted to Boston time, and weekday/hour come from the supplied local
clock. The `timestamp` column is NOT a Unix epoch: the dataset describes it as
seconds since the beginning of the (local) day, and it is only cross-checked.
Standard library only; output is deterministic for the same input.
"""
import argparse
import csv
import hashlib
import io
import json
import statistics
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / "raw" / "campus_gym"
RAW_CSV = RAW_DIR / "data.csv"
SOURCE_JSON = RAW_DIR / "SOURCE.json"
OUT_CSV = HERE / "clean_campus_gym_occupancy.csv"
OUT_JSON = HERE / "campus_gym_import.json"
OUT_MD = HERE / "campus_gym_quality.md"

FACILITY_ID = "CAMPUS_GYM_HISTORICAL_REFERENCE"
DATASET = "nsrose7224/crowdedness-at-the-campus-gym"
DOWNLOAD_URL = f"https://www.kaggle.com/api/v1/datasets/download/{DATASET}"
METADATA_URL = f"https://www.kaggle.com/api/v1/datasets/view/{DATASET}"
EXPECTED = ["number_people", "date", "timestamp", "day_of_week", "is_weekend", "is_holiday",
            "temperature", "is_start_of_semester", "is_during_semester", "month", "hour"]
COLUMNS = ["facility_id", "timestamp", "occupancy_count"]

# Gap policy, derived from the measured cadence (median ~10 min, second mode 20 min =
# one missed reading). A count holds until the next reading, for at most MAX_HOLD,
# and never past local midnight. Longer gaps are "no data", never zero.
MAX_HOLD = timedelta(minutes=30)
LONG_GAP = timedelta(hours=6)
PLAYBACK_MIN_COVERAGE_H = 18.0


# ---------- retrieval ----------
def download() -> None:
    """Fetch the publisher's archive and metadata (public endpoint, no credentials)."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "BUsy-gym-import/1.0"}
    print(f"Downloading {DOWNLOAD_URL} ...")
    with urllib.request.urlopen(urllib.request.Request(DOWNLOAD_URL, headers=headers), timeout=120) as r:
        archive = r.read()
    with urllib.request.urlopen(urllib.request.Request(METADATA_URL, headers=headers), timeout=60) as r:
        meta = json.load(r)
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        RAW_CSV.write_bytes(z.read("data.csv"))
    SOURCE_JSON.write_text(json.dumps({
        "title": meta.get("title"), "creator": meta.get("creatorName"), "dataset": DATASET,
        "page": f"https://www.kaggle.com/datasets/{DATASET}",
        "download_url": DOWNLOAD_URL, "version": meta.get("currentVersionNumber"),
        "last_updated": meta.get("lastUpdated"), "license": meta.get("licenseName"),
        "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "csv_sha256": hashlib.sha256(RAW_CSV.read_bytes()).hexdigest(),
        "description": meta.get("description"),
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {RAW_CSV.relative_to(HERE.parent)} and {SOURCE_JSON.name}")


# ---------- cleaning ----------
def parse(lines):
    """Validate every row. Returns (records, problems, crosscheck mismatches, flags by local date)."""
    reader = csv.DictReader(lines)
    if reader.fieldnames != EXPECTED:
        raise ValueError(f"Unexpected columns {reader.fieldnames}; expected {EXPECTED}")
    records, problems = [], []
    mismatches = Counter()
    flags = defaultdict(lambda: {"semester": True, "holiday": False})
    for line_no, r in enumerate(reader, start=2):
        raw_date, raw_count = (r["date"] or "").strip(), (r["number_people"] or "").strip()
        try:
            dt = datetime.fromisoformat(raw_date)
        except ValueError:
            problems.append((line_no, "unparseable date", raw_date))
            continue
        if dt.tzinfo is None:
            problems.append((line_no, "date has no UTC offset", raw_date))
            continue
        if raw_count == "":
            problems.append((line_no, "missing count", ""))      # missing is not zero
            continue
        try:
            count = int(raw_count)
        except ValueError:
            problems.append((line_no, "count is not a whole number", raw_count))
            continue
        if count < 0:
            problems.append((line_no, "negative count", raw_count))
            continue
        # The supplied derived fields must agree with `date`; `date` wins, mismatches are reported.
        expect = {
            "timestamp": dt.hour * 3600 + dt.minute * 60 + dt.second, "day_of_week": dt.weekday(),
            "hour": dt.hour, "month": dt.month, "is_weekend": int(dt.weekday() >= 5),
        }
        for k, v in expect.items():
            try:
                if int(r[k]) != v:
                    mismatches[k] += 1
            except (TypeError, ValueError):
                mismatches[k] += 1
        day = flags[dt.date().isoformat()]
        day["semester"] &= r["is_during_semester"].strip() == "1"
        day["holiday"] |= r["is_holiday"].strip() == "1"
        records.append((dt, count, line_no))
    return records, problems, mismatches, flags


def dedupe(records):
    """Same instant twice: identical counts collapse to one row; conflicting counts are
    all dropped, because there's no way to know which one is right."""
    by_instant = defaultdict(list)
    for rec in records:
        by_instant[rec[0]].append(rec)
    kept, identical, conflicting = [], 0, []
    for instant, recs in by_instant.items():
        counts = {c for _, c, _ in recs}
        if len(recs) == 1:
            kept.append(recs[0])
        elif len(counts) == 1:
            kept.append(min(recs, key=lambda x: x[2]))
            identical += len(recs) - 1
        else:
            conflicting.append((instant.isoformat(), sorted(c for _, c, _ in recs), [n for _, _, n in recs]))
    kept.sort(key=lambda x: (x[0], x[2]))  # chronological by instant; file order breaks ties
    return kept, identical, conflicting


def day_coverage(times):
    """Seconds covered on one local day under the gap policy."""
    covered = 0.0
    midnight = datetime.combine(times[0].date() + timedelta(days=1), datetime.min.time(), times[0].tzinfo)
    for a, b in zip(times, times[1:] + [midnight]):
        covered += min((b - a).total_seconds(), MAX_HOLD.total_seconds())
    return covered


def summarize(records, problems, mismatches, flags, identical, conflicting, out_of_order, source):
    times = [t for t, _, _ in records]
    counts = [c for _, c, _ in records]
    gaps = [(b - a) for a, b in zip(times, times[1:])]
    gap_min = [g.total_seconds() / 60 for g in gaps]
    days = defaultdict(list)
    for t in times:
        days[t.date()].append(t)
    mixed = sorted(d.isoformat() for d, ts in days.items() if len({t.utcoffset() for t in ts}) > 1)
    coverage = {d: day_coverage(ts) / 3600 for d, ts in days.items()}

    # Playback days: the most recent full Monday-Sunday week inside a semester, with no
    # holiday, no offset change and at least PLAYBACK_MIN_COVERAGE_H hours covered each day.
    eligible = {d for d in days if d.isoformat() not in mixed and coverage[d] >= PLAYBACK_MIN_COVERAGE_H
                and flags[d.isoformat()]["semester"] and not flags[d.isoformat()]["holiday"]}
    weeks = sorted({d - timedelta(days=d.weekday()) for d in eligible}, reverse=True)
    week = next((w for w in weeks if all(w + timedelta(days=i) in eligible for i in range(7))), None)
    playback = [w.isoformat() for w in ([week + timedelta(days=i) for i in range(7)] if week else sorted(eligible)[-7:])]

    buckets = [(0, 5), (5, 9.5), (9.5, 10.5), (10.5, 15), (15, 25), (25, 30), (30, 60), (60, 360), (360, None)]
    labels = ["< 5 min", "5-9.5 min", "9.5-10.5 min", "10.5-15 min", "15-25 min", "25-30 min", "30-60 min", "1-6 h", "> 6 h"]
    dist = {lab: sum(1 for g in gap_min if g >= lo and (hi is None or g < hi)) for lab, (lo, hi) in zip(labels, buckets)}
    long_list = sorted(((a, b) for a, b in zip(times, times[1:]) if b - a > LONG_GAP), key=lambda x: x[1] - x[0], reverse=True)
    problem_counts = Counter(p[1] for p in problems)
    return {
        "facility_id": FACILITY_ID,
        "source": {k: source.get(k) for k in ("title", "creator", "page", "version", "last_updated", "license",
                                               "retrieved_at", "csv_sha256")},
        "license_terms": "ODbL 1.0 (database) + DbCL 1.0 (contents): attribution required; derived databases "
                         "shared publicly must be offered under ODbL; keep these notices.",
        "measurement_method": "Not documented. The author says counts were 'measured' about every 10 minutes "
                              "with the consent of the university and the gym; the method (sensor, card swipes, "
                              "staff count) is not stated.",
        "timestamp_interpretation": "`date` is the full local datetime with a UTC offset and is used as-is. "
                                    "`timestamp` is seconds since local midnight (documented), not a Unix epoch; "
                                    "it is cross-checked only. No named timezone is assigned.",
        "rows_in_file": len(records) + len(problems) + identical + sum(len(c[1]) for c in conflicting),
        "rows_kept": len(records),
        "rows_rejected": dict(sorted(problem_counts.items())),
        "rejected_examples": [{"line": n, "problem": p, "value": v} for n, p, v in problems[:10]],
        "duplicate_instants": {"identical_collapsed": identical, "conflicting_dropped": conflicting},
        "field_mismatches": dict(sorted(mismatches.items())),
        "out_of_order_in_file": out_of_order,   # rows whose instant is earlier than the row above
        "first": times[0].isoformat(), "last": times[-1].isoformat(),
        "offsets": dict(sorted(Counter(t.isoformat()[-6:] for t in times).items())),
        "local_days": len(days),
        "days_by_weekday": {wd: n for wd, n in zip(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                                                   [sum(1 for d in days if d.weekday() == i) for i in range(7)])},
        "days_with_offset_change": mixed,
        "count_min": min(counts), "count_max": max(counts), "zero_rows": counts.count(0),
        "interval_median_min": round(statistics.median(gap_min), 2),
        "interval_distribution": dist,
        "gaps_over_max_hold": sum(1 for g in gaps if g > MAX_HOLD),
        "long_gaps": [{"from": a.isoformat(), "to": b.isoformat(), "hours": round((b - a).total_seconds() / 3600, 1)}
                      for a, b in long_list[:12]],
        "long_gaps_total": len(long_list),
        "coverage_hours_per_day": {"min": round(min(coverage.values()), 1),
                                   "median": round(statistics.median(coverage.values()), 1),
                                   "max": round(max(coverage.values()), 1)},
        "gap_policy": {"max_hold_minutes": int(MAX_HOLD.total_seconds() // 60), "day_boundary": "local midnight",
                       "excluded_days": "days with an offset change (playback and typical traffic only)"},
        "playback_days": playback,
        "playback_rule": f"Most recent full Monday-Sunday week during a semester with no holiday, no offset "
                         f"change and >= {PLAYBACK_MIN_COVERAGE_H:g} h covered each day.",
        "transformations": [
            "Parsed `date` with its UTC offset; no timezone conversion.",
            "Rejected rows with an unparseable date, no offset, a missing, non-integer or negative count (listed above).",
            "Collapsed identical duplicate instants; dropped conflicting ones.",
            "Sorted by instant (stable); kept only facility_id, timestamp, occupancy_count.",
        ],
    }


def write_markdown(s):
    src = s["source"]
    rej = ", ".join(f"{k}: {v}" for k, v in s["rows_rejected"].items()) or "none"
    lines = [
        "# Campus Gym — Historical Reference: data quality",
        "",
        "Generated by `data/import_campus_gym.py`. Do not edit by hand.",
        "",
        "| | |", "|---|---|",
        f"| Source | {src['title']} by {src['creator']}, Kaggle (version {src['version']}, updated {src['last_updated']}) |",
        f"| Page | {src['page']} |",
        f"| Retrieved | {src['retrieved_at']} (sha256 of data.csv `{src['csv_sha256']}`) |",
        f"| License | Kaggle lists \"{src['license']}\": {s['license_terms']} |",
        f"| Measurement method | {s['measurement_method']} |",
        f"| Timestamps | {s['timestamp_interpretation']} |",
        f"| Rows in file | {s['rows_in_file']:,} |",
        f"| Rows kept | {s['rows_kept']:,} |",
        f"| Rows rejected | {rej} |",
        f"| Duplicate instants | {s['duplicate_instants']['identical_collapsed']} identical collapsed, "
        f"{len(s['duplicate_instants']['conflicting_dropped'])} conflicting dropped |",
        f"| Supplied fields vs `date` | mismatches: {s['field_mismatches'] or 'none'} (timestamp, day_of_week, hour, month, is_weekend checked) |",
        f"| Out of order in the file | {len(s['out_of_order_in_file'])} row(s): "
        + ("; ".join(f"line {o['line']} ({o['date']}) after line {o['after_line']} ({o['after_date']})"
                     for o in s['out_of_order_in_file']) or "none") + " |",
        f"| Range | {s['first']} → {s['last']} |",
        f"| UTC offsets | {s['offsets']} |",
        f"| Local days | {s['local_days']} ({s['days_by_weekday']}) |",
        f"| Days with an offset change | {', '.join(s['days_with_offset_change']) or 'none'} |",
        f"| Count range | {s['count_min']}–{s['count_max']} people; {s['zero_rows']:,} rows are 0 |",
        f"| Sampling interval | median {s['interval_median_min']} min; {s['interval_distribution']} |",
        f"| Gaps over {s['gap_policy']['max_hold_minutes']} min | {s['gaps_over_max_hold']:,} (of which {s['long_gaps_total']} over 6 h) |",
        f"| Coverage per local day | {s['coverage_hours_per_day']} hours, under the gap policy |",
        f"| Playback days | {', '.join(s['playback_days'])} ({s['playback_rule']}) |",
        "",
        "## Notes",
        "",
        "- On a day whose UTC offset changes, the source can label both passes of a repeated hour with the same "
        "offset, so instants there may be off by an hour. Those days are listed above and left out of playback "
        "and typical traffic; their rows stay in the clean file, sorted by the stated instant.",
        "- Intervals under 5 minutes are short bursts of readings (e.g. every 30 seconds), not duplicates; "
        "time weighting gives each reading only the time until the next one.",
        "- Counts are kept as recorded. Zeros (often overnight) are real readings; missing time is never filled.",
        "",
        "## Gap policy",
        "",
        f"A count holds until the next reading, for at most {s['gap_policy']['max_hold_minutes']} minutes, and never past "
        "local midnight. Time beyond that is *no data*, never zero. Days with an offset change are left out of playback "
        "and typical traffic because a wall-clock hour repeats or is skipped.",
        "",
        "## Longest gaps",
        "",
        "| From | To | Hours |", "|---|---|---|",
        *[f"| {g['from']} | {g['to']} | {g['hours']} |" for g in s["long_gaps"]],
        "",
        "## Transformations",
        "",
        *[f"- {t}" for t in s["transformations"]],
        "",
    ]
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true", help="fetch the original from Kaggle's public endpoint first")
    parser.add_argument("--csv", help="use this copy of data.csv instead of data/raw/campus_gym/data.csv")
    args = parser.parse_args()
    if args.download:
        download()
    path = Path(args.csv) if args.csv else RAW_CSV
    if not path.exists():
        sys.exit(f"{path} not found. Run `python data/import_campus_gym.py --download`, or download data.csv from "
                 f"https://www.kaggle.com/datasets/{DATASET} into {RAW_DIR}.")
    source = json.loads(SOURCE_JSON.read_text(encoding="utf-8")) if SOURCE_JSON.exists() else {}
    source.setdefault("csv_sha256", hashlib.sha256(path.read_bytes()).hexdigest())

    with open(path, newline="", encoding="utf-8") as f:
        records, problems, mismatches, flags = parse(f)
    out_of_order = [{"line": b[2], "date": b[0].isoformat(), "after_line": a[2], "after_date": a[0].isoformat()}
                    for a, b in zip(records, records[1:]) if b[0] < a[0]]
    records, identical, conflicting = dedupe(records)
    if not records:
        sys.exit("No valid rows; inspect the source format.")
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows((FACILITY_ID, t.isoformat(), c) for t, c, _ in records)
    summary = summarize(records, problems, mismatches, flags, identical, conflicting, out_of_order, source)
    OUT_JSON.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    write_markdown(summary)

    print(f"Rows kept:       {summary['rows_kept']:,} of {summary['rows_in_file']:,}")
    print(f"Rejected:        {summary['rows_rejected'] or 'none'}")
    print(f"Duplicates:      {identical} identical collapsed, {len(conflicting)} conflicting dropped")
    print(f"Range:           {summary['first']} -> {summary['last']}")
    print(f"Counts:          {summary['count_min']}-{summary['count_max']} ({summary['zero_rows']:,} zero rows)")
    print(f"Median interval: {summary['interval_median_min']} min; gaps over 30 min: {summary['gaps_over_max_hold']:,}")
    print(f"Playback days:   {', '.join(summary['playback_days'])}")
    print(f"Wrote {OUT_CSV.name}, {OUT_JSON.name}, {OUT_MD.name}")


if __name__ == "__main__":
    main()
