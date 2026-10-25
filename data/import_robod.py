"""Import ROBOD Room 5 (a library space) as a reference input for Mugar's simulation.

Source: Tekler, Ono, Peng, Zhang, Lasternas & Chong, "ROBOD, Room-level Occupancy and
Building Operation Dataset", figshare, doi:10.6084/m9.figshare.19234530 (CC BY 4.0).
Paper: Building Simulation 15 (2022), doi:10.1007/s12273-022-0925-9.
Room 5 is a library space at the National University of Singapore (SDE4 building). It is
not Boston University and not Mugar Library.

Reads the publisher's file, unchanged, from data/raw/robod/combined_Room5.csv and writes:
    clean_robod_library_occupancy.csv   facility_id,timestamp,occupancy_count (chronological)
    robod_import.json                   statistics, gap policy, source (read by the generator)
    robod_quality.md                    the same summary for people

Run:    python data/import_robod.py                 (offline: uses the stored original)
        python data/import_robod.py --download      (fetch the publisher's archive first)
        python data/import_robod.py --csv path/to/combined_Room5.csv

Only `occupant_count [number]` is used: the ground-truth count of people in the room.
Wi-Fi connected devices and the binary presence flag are not counts of people
(presence is only cross-checked). Timestamps ("YYYY-MM-DD HH:MM +08:00") keep their
UTC offset; nothing is converted to Boston time. Standard library only; the output is
the same every time for the same input. Nothing here runs at app startup or in tests.
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
RAW_DIR = HERE / "raw" / "robod"
RAW_CSV = RAW_DIR / "combined_Room5.csv"
RAW_README = RAW_DIR / "publisher_README.md"
SOURCE_JSON = RAW_DIR / "SOURCE.json"
OUT_CSV = HERE / "clean_robod_library_occupancy.csv"
OUT_JSON = HERE / "robod_import.json"
OUT_MD = HERE / "robod_quality.md"

FACILITY_ID = "ROBOD_ROOM5_LIBRARY"   # a reference record ID, never a campus destination
ARTICLE_ID = 19234530
METADATA_URL = f"https://api.figshare.com/v2/articles/{ARTICLE_ID}"
ARCHIVE_FILE = "SupplementaryData.zip"
MEMBER = "combined_Room5.csv"
TIME_FIELD, COUNT_FIELD, PRESENCE_FIELD = "timestamp", "occupant_count [number]", "occupant_presence [binary]"
COLUMNS = ["facility_id", "timestamp", "occupancy_count"]

# Gap policy from the documented and observed cadence (every 5 minutes): one reading stands
# for its own 5-minute interval and no longer, and never past local midnight. Anything
# longer is "no data", never zero and never the last count stretched out.
CADENCE = timedelta(minutes=5)
MAX_HOLD = CADENCE


# ---------- retrieval ----------
def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BUsy-robod-import/1.0"}),
                                timeout=180) as r:
        return r.read()


def download() -> None:
    """Fetch the publisher's metadata and archive (public figshare API, no credentials).
    Refuses to store anything unless the record still says CC BY 4.0 and the checksum matches."""
    meta = json.loads(fetch(METADATA_URL))
    license_name = meta["license"]["name"]
    if license_name != "CC BY 4.0":
        sys.exit(f"Licence is now {license_name!r}, not CC BY 4.0. Review it before redistributing; nothing stored.")
    entry = next(f for f in meta["files"] if f["name"] == ARCHIVE_FILE)
    print(f"Downloading {entry['download_url']} ({entry['size']:,} bytes) ...")
    archive = fetch(entry["download_url"])
    if hashlib.md5(archive).hexdigest() != entry["computed_md5"]:
        sys.exit("Archive checksum doesn't match the publisher's MD5; nothing stored.")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        RAW_CSV.write_bytes(z.read(MEMBER))
        RAW_README.write_bytes(z.read("README.md"))
    SOURCE_JSON.write_text(json.dumps({
        "title": meta["title"],
        "creators": ", ".join(a["full_name"].replace("  ", " ") for a in meta["authors"]),
        "publisher": "figshare", "doi": meta["doi"], "version": meta["version"],
        "page": f"https://doi.org/10.6084/m9.figshare.{ARTICLE_ID}",
        "published": meta["published_date"], "modified": meta["modified_date"],
        "license": license_name, "license_url": meta["license"]["url"],
        "citation": meta["citation"],
        "paper": "Tekler, Z.D., Ono, E., Peng, Y., Zhang, S., Lasternas, B., Chong, A. (2022). ROBOD, room-level "
                 "occupancy and building operation dataset. Building Simulation. "
                 "https://doi.org/10.1007/s12273-022-0925-9",
        "code_repository": "https://github.com/ideas-lab-nus/robod",
        "download_url": entry["download_url"], "archive": ARCHIVE_FILE, "member": MEMBER,
        "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "archive_md5": entry["computed_md5"], "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "csv_sha256": hashlib.sha256(RAW_CSV.read_bytes()).hexdigest(),
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {RAW_CSV.relative_to(HERE.parent)}, {RAW_README.name} and {SOURCE_JSON.name}")


# ---------- cleaning ----------
def parse_time(text: str) -> datetime:
    """"2021-09-07 00:00 +08:00" (the publisher's format) or ISO 8601. An offset is required."""
    text = text.strip()
    try:
        dt = datetime.strptime(text, "%Y-%m-%d %H:%M %z")
    except ValueError:
        dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("no UTC offset")
    return dt


def parse(lines):
    """Validate every row. Returns (records, problems, presence disagreements)."""
    reader = csv.DictReader(lines)
    missing = {TIME_FIELD, COUNT_FIELD} - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"Missing columns {sorted(missing)}; found {reader.fieldnames}")
    records, problems, disagree = [], [], 0
    for line_no, r in enumerate(reader, start=2):
        raw_time, raw_count = (r[TIME_FIELD] or "").strip(), (r[COUNT_FIELD] or "").strip()
        try:
            dt = parse_time(raw_time)
        except ValueError:
            problems.append((line_no, "unparseable timestamp or no offset", raw_time))
            continue
        if raw_count == "" or raw_count.upper() in ("NA", "NAN"):
            problems.append((line_no, "missing count", raw_count))     # missing is not zero
            continue
        try:
            value = float(raw_count)
        except ValueError:
            problems.append((line_no, "count is not a number", raw_count))
            continue
        if value < 0:
            problems.append((line_no, "negative count", raw_count))
            continue
        if not value.is_integer():
            problems.append((line_no, "count is not a whole number", raw_count))
            continue
        count = int(value)
        presence = (r.get(PRESENCE_FIELD) or "").strip()
        if presence in ("0", "1") and (count > 0) != (presence == "1"):
            disagree += 1
        records.append((dt, count, line_no))
    return records, problems, disagree


def dedupe(records):
    """Same instant twice: identical counts collapse to one row; conflicting counts are all
    dropped, because there's no way to know which one is right."""
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
            conflicting.append({"timestamp": instant.isoformat(), "counts": sorted(c for _, c, _ in recs),
                                "lines": [n for _, _, n in recs]})
    kept.sort(key=lambda x: (x[0], x[2]))
    return kept, identical, conflicting


def summarize(records, problems, disagree, identical, conflicting, out_of_order, source, rows_in_file):
    times = [t for t, _, _ in records]
    counts = [c for _, c, _ in records]
    gaps = [(a, b) for a, b in zip(times, times[1:]) if b - a > MAX_HOLD]
    steps = Counter(round((b - a).total_seconds() / 60, 2) for a, b in zip(times, times[1:]))
    days = defaultdict(list)
    for t in times:
        days[t.date()].append(t)
    per_day = Counter(len(v) for v in days.values())
    weekday_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return {
        "facility_id": FACILITY_ID,
        "source": {k: source.get(k) for k in ("title", "creators", "publisher", "doi", "version", "page",
                                               "modified", "license", "license_url", "citation", "paper",
                                               "download_url", "retrieved_at", "archive_md5", "csv_sha256")},
        "original_location": "Room 5, a library space in the SDE4 building, National University of Singapore",
        "metric": "occupant_count [number]: people in the room (ground truth), a whole number",
        "fields_not_used": "wifi_connected_devices [number] (devices, not people) and occupant_presence [binary] "
                           "(only cross-checked against the count); environmental and energy fields",
        "timestamp_interpretation": "Local time with a +08:00 UTC offset, as written (Singapore). Kept as-is; no "
                                    "named timezone is assigned and nothing is converted to Boston time.",
        "rows_in_file": rows_in_file,
        "rows_kept": len(records),
        "rows_rejected": dict(sorted(Counter(p[1] for p in problems).items())),
        "rejected_examples": [{"line": n, "problem": p, "value": v} for n, p, v in problems[:10]],
        "duplicate_instants": {"identical_collapsed": identical, "conflicting_dropped": conflicting},
        "out_of_order_in_file": len(out_of_order),
        "presence_disagreements": disagree,
        "first": times[0].isoformat(), "last": times[-1].isoformat(),
        "offsets": dict(sorted(Counter(t.isoformat()[-6:] for t in times).items())),
        "local_dates": len(days),
        "dates": [d.isoformat() for d in sorted(days)],
        "dates_by_weekday": {weekday_names[i]: sum(1 for d in days if d.weekday() == i) for i in range(7)},
        "readings_per_date": {str(k): v for k, v in sorted(per_day.items())},
        "count_min": min(counts), "count_max": max(counts), "zero_rows": counts.count(0),
        "count_distribution": {str(k): v for k, v in sorted(Counter(counts).items())},
        "interval_median_min": statistics.median([(b - a).total_seconds() / 60 for a, b in zip(times, times[1:])]),
        "intervals_min": {str(k): v for k, v in sorted(steps.items())},
        "gaps": [{"from": a.isoformat(), "to": b.isoformat(), "hours": round((b - a).total_seconds() / 3600, 1)}
                 for a, b in gaps],
        "gap_policy": {"max_hold_minutes": int(MAX_HOLD.total_seconds() // 60), "day_boundary": "local midnight",
                       "rule": "A reading stands for its own 5-minute interval only; longer gaps are no data."},
        "transformations": [
            f"Parsed `{TIME_FIELD}` with its +08:00 offset; no timezone conversion.",
            f"Used `{COUNT_FIELD}` only. Rejected rows with an unparseable timestamp, or a missing, non-numeric, "
            "fractional or negative count (listed above). Zero is a reading, kept as zero.",
            "Collapsed identical duplicate instants; dropped conflicting ones.",
            "Sorted by instant (stable); kept only facility_id, timestamp, occupancy_count.",
        ],
    }


def write_markdown(s):
    src = s["source"]
    rej = ", ".join(f"{k}: {v}" for k, v in s["rows_rejected"].items()) or "none"
    dup = s["duplicate_instants"]
    lines = [
        "# ROBOD Room 5 (library space): data quality",
        "",
        "Generated by `data/import_robod.py`. Do not edit by hand.",
        "",
        "| | |", "|---|---|",
        f"| Source | {src['title']}, {src['creators']} ({src['publisher']}, version {src['version']}, modified {src['modified']}) |",
        f"| DOI | {src['page']} |",
        f"| Retrieved | {src['retrieved_at']} from {src['download_url']} (archive MD5 `{src['archive_md5']}`, "
        f"sha256 of combined_Room5.csv `{src['csv_sha256']}`) |",
        f"| Licence | {src['license']} ({src['license_url']}): attribution required; changes must be indicated |",
        f"| Original location | {s['original_location']} (not BU) |",
        f"| Metric | {s['metric']} |",
        f"| Not used | {s['fields_not_used']} |",
        f"| Timestamps | {s['timestamp_interpretation']} |",
        f"| Rows in file | {s['rows_in_file']:,} |",
        f"| Rows kept | {s['rows_kept']:,} |",
        f"| Rows rejected | {rej} |",
        f"| Duplicate timestamps | {dup['identical_collapsed']} identical collapsed, {len(dup['conflicting_dropped'])} conflicting dropped |",
        f"| Out of order in the file | {s['out_of_order_in_file']} row(s) |",
        f"| Count vs presence flag | {s['presence_disagreements']} disagreement(s) |",
        f"| Range | {s['first']} → {s['last']} |",
        f"| UTC offsets | {s['offsets']} |",
        f"| Recorded dates | {s['local_dates']} ({s['dates_by_weekday']}); readings per date: {s['readings_per_date']} |",
        f"| Count range | {s['count_min']}–{s['count_max']} people; {s['zero_rows']:,} readings are 0 |",
        f"| Sampling interval | median {s['interval_median_min']:g} min; intervals (min): {s['intervals_min']} |",
        f"| Gaps over {s['gap_policy']['max_hold_minutes']} min | {len(s['gaps'])} (between recorded dates) |",
        "",
        "## Gap policy",
        "",
        s["gap_policy"]["rule"] + " Readings are never carried across a gap or past local midnight.",
        "",
        "## Gaps between recorded periods",
        "",
        "| From | To | Hours |", "|---|---|---|",
        *[f"| {g['from']} | {g['to']} | {g['hours']} |" for g in s["gaps"]],
        "",
        "## Transformations",
        "",
        *[f"- {t}" for t in s["transformations"]],
        "",
    ]
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")


def run(path: Path) -> dict:
    source = json.loads(SOURCE_JSON.read_text(encoding="utf-8")) if SOURCE_JSON.exists() else {}
    source.setdefault("csv_sha256", hashlib.sha256(path.read_bytes()).hexdigest())
    with open(path, newline="", encoding="utf-8") as f:
        records, problems, disagree = parse(f)
    rows_in_file = len(records) + len(problems)
    out_of_order = [b for a, b in zip(records, records[1:]) if b[0] < a[0]]
    records, identical, conflicting = dedupe(records)
    if not records:
        sys.exit("No valid rows; inspect the source format.")
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows((FACILITY_ID, t.isoformat(), c) for t, c, _ in records)
    summary = summarize(records, problems, disagree, identical, conflicting, out_of_order, source, rows_in_file)
    OUT_JSON.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_markdown(summary)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true", help="fetch the publisher's archive from figshare first")
    parser.add_argument("--csv", help="use this copy of combined_Room5.csv instead of data/raw/robod/")
    args = parser.parse_args()
    if args.download:
        download()
    path = Path(args.csv) if args.csv else RAW_CSV
    if not path.exists():
        sys.exit(f"{path} not found. Run `python data/import_robod.py --download`, or put {MEMBER} from "
                 f"https://doi.org/10.6084/m9.figshare.{ARTICLE_ID} into {RAW_DIR}.")
    s = run(path)
    print(f"Rows kept:   {s['rows_kept']:,} of {s['rows_in_file']:,}; rejected: {s['rows_rejected'] or 'none'}")
    print(f"Duplicates:  {s['duplicate_instants']['identical_collapsed']} identical collapsed, "
          f"{len(s['duplicate_instants']['conflicting_dropped'])} conflicting dropped")
    print(f"Range:       {s['first']} -> {s['last']} ({s['local_dates']} dates, offsets {s['offsets']})")
    print(f"Counts:      {s['count_min']}-{s['count_max']} ({s['zero_rows']:,} zero readings)")
    print(f"Intervals:   median {s['interval_median_min']:g} min; {len(s['gaps'])} gaps over 5 min")
    print(f"Wrote {OUT_CSV.name}, {OUT_JSON.name}, {OUT_MD.name}")


if __name__ == "__main__":
    main()
