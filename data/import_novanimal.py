"""Import NOVANIMAL canteen sales as a reference input for the dining halls' lunch simulation.

Source: Gian-Andrea Egeler, "Supplementary material (aggregated data set): Egeler, G.-A. &
Baur, P. (2020). Menüwahl in der Hochschulmensa: Fleisch oder Vegi? ... (NOVANIMAL Working
Paper No. 5). ZHAW", Zenodo, doi:10.5281/zenodo.3890931 (CC BY 4.0).
Menu sales at two ZHAW university canteens (Grüental and Vista, Wädenswil, Switzerland),
autumn semester 2017. Not Boston University. The aggregate data set is used; the
individual data set (doi:10.5281/zenodo.3890949) is more personally detailed and not needed.

Reads the publisher's file, unchanged, from data/raw/novanimal/ and writes:
    clean_novanimal_transactions.csv   source_location,interval_start,transaction_count
                                       (15-minute intervals, source wall clock)
    novanimal_import.json              statistics, timestamp evidence, rules (read by the generator)
    novanimal_quality.md               the same summary for people

Run:    python data/import_novanimal.py                 (offline: uses the stored original)
        python data/import_novanimal.py --download      (fetch from Zenodo first)
        python data/import_novanimal.py --csv path/to/2017_ZHAW_aggregated_menu_sales_NOVANIMAL.csv

What a row is: one article line of a point-of-sale transaction. Several lines can belong to one
transaction (several articles, or the same article twice), so rows are grouped into
transactions by (canteen, date, transaction_id) and each transaction counts once. A transaction
is a purchase event, not a person entering and not people present. `qty_weight` is a number of
menus or, for "Hot and Cold" buffet plates, a weight in kg (publisher's variable list); it is
never used as a number of people. Transactions whose lines are all negative are refunds or
cancellations and are left out.

Timestamps: `trans_date` reads like "2017-10-02T11:14:07Z", but the publisher's variable list
shows the same field as "2017-10-02 11:29:50" with no zone, and the sales don't move when
Switzerland left summer time on 2017-10-29 (evidence recomputed below). The clock is therefore
read as the canteens' local wall-clock time and the trailing "Z" as an export artefact. The raw
text is kept in the original file; nothing is converted to Boston time.
Standard library only; the output is the same every time for the same input.
"""
import argparse
import csv
import hashlib
import json
import re
import statistics
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / "raw" / "novanimal"
CSV_NAME = "2017_ZHAW_aggregated_menu_sales_NOVANIMAL.csv"
DOC_NAME = "variables_aggregated_dataset_20201007.pdf"
RAW_CSV = RAW_DIR / CSV_NAME
SOURCE_JSON = RAW_DIR / "SOURCE.json"
OUT_CSV = HERE / "clean_novanimal_transactions.csv"
OUT_JSON = HERE / "novanimal_import.json"
OUT_MD = HERE / "novanimal_quality.md"

RECORD_ID = 3890931
METADATA_URL = f"https://zenodo.org/api/records/{RECORD_ID}"
REQUIRED = ["transaction_id", "trans_date", "date", "article_description", "qty_weight", "total_amount",
            "shop_description"]
COLUMNS = ["source_location", "interval_start", "transaction_count"]
INTERVAL_MIN = 15
TRANS_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z$")
DST_END = "2017-10-29"   # Switzerland: CEST (UTC+2) -> CET (UTC+1)


# ---------- retrieval ----------
def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BUsy-novanimal-import/1.0"}),
                                timeout=180) as r:
        return r.read()


def download() -> None:
    """Fetch the record metadata, the CSV and its variable list from Zenodo (no credentials).
    Refuses to store anything unless the record still says CC BY 4.0 and checksums match."""
    meta = json.loads(fetch(METADATA_URL))
    license_id = (meta["metadata"].get("license") or {}).get("id")
    if license_id != "cc-by-4.0":
        sys.exit(f"Licence is now {license_id!r}, not cc-by-4.0. Review it before redistributing; nothing stored.")
    files = {f["key"]: f for f in meta["files"]}
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    stored = {}
    for name in (CSV_NAME, DOC_NAME):
        entry = files[name]
        print(f"Downloading {entry['links']['self']} ({entry['size']:,} bytes) ...")
        body = fetch(entry["links"]["self"])
        algo, expected = entry["checksum"].split(":")
        if hashlib.new(algo, body).hexdigest() != expected:
            sys.exit(f"{name}: checksum doesn't match the publisher's {algo}; nothing stored.")
        stored[name] = (body, entry)
    for name, (body, _) in stored.items():
        (RAW_DIR / name).write_bytes(body)
    m = meta["metadata"]
    SOURCE_JSON.write_text(json.dumps({
        "title": m["title"], "creators": ", ".join(c["name"] for c in m["creators"]),
        "publisher": "Zenodo", "doi": meta["doi"], "page": f"https://doi.org/{meta['doi']}",
        "published": m.get("publication_date"), "updated": meta.get("updated"),
        "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "working_paper": "Egeler, G.-A. & Baur, P. (2020). NOVANIMAL Working Paper No. 5. ZHAW. "
                         "https://doi.org/10.21256/zhaw-1405",
        "files": {name: {"download_url": e["links"]["self"], "size": e["size"], "publisher_checksum": e["checksum"],
                         "sha256": hashlib.sha256(b).hexdigest()} for name, (b, e) in stored.items()},
        "retrieved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "csv_sha256": hashlib.sha256(stored[CSV_NAME][0]).hexdigest(),
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Saved {', '.join(stored)} and {SOURCE_JSON.name} in {RAW_DIR.relative_to(HERE.parent)}")


# ---------- cleaning ----------
def parse(lines):
    """Validate every row. Returns (valid rows, problems). A valid row is
    (key, wall_clock, qty, amount, fields, line_no) with key = (canteen, date, transaction_id)."""
    reader = csv.DictReader(lines, delimiter=";")
    missing = set(REQUIRED) - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"Missing columns {sorted(missing)}; found {reader.fieldnames}")
    rows, problems = [], []
    for line_no, r in enumerate(reader, start=2):
        tid, shop, day = (r["transaction_id"] or "").strip(), (r["shop_description"] or "").strip(), (r["date"] or "").strip()
        raw = (r["trans_date"] or "").strip()
        m = TRANS_DATE.match(raw)
        if not tid or not shop:
            problems.append((line_no, "missing transaction_id or canteen", raw))
            continue
        if not m:
            problems.append((line_no, "unrecognised trans_date", raw))
            continue
        if m.group(1) != day:
            problems.append((line_no, "date doesn't match trans_date", f"{day} / {raw}"))
            continue
        try:
            wall = datetime.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S")   # wall clock; the "Z" is set aside
            qty, amount = float(r["qty_weight"]), float(r["total_amount"])
        except ValueError:
            problems.append((line_no, "unparseable time, qty_weight or total_amount", raw))
            continue
        fields = tuple((k, (v or "").strip()) for k, v in r.items())
        rows.append(((shop, day, tid), wall, qty, amount, fields, line_no))
    return rows, problems


def group(rows):
    """Rows -> transactions. Returns (purchases {key: wall_clock}, report)."""
    by_key = defaultdict(list)
    for row in rows:
        by_key[row[0]].append(row)
    purchases, conflicting, refunds, mixed_sign = {}, [], [], 0
    repeated_lines = 0
    for key, items in by_key.items():
        times = {it[1] for it in items}
        if len(times) > 1:           # one transaction, two clock times: can't place it, so it's dropped
            conflicting.append({"canteen": key[0], "date": key[1], "transaction_id": key[2],
                                "times": sorted(t.isoformat() for t in times)})
            continue
        seen = Counter(it[4] for it in items)
        repeated_lines += sum(n - 1 for n in seen.values())
        if all(it[2] < 0 or it[3] < 0 for it in items):
            refunds.append({"canteen": key[0], "date": key[1], "transaction_id": key[2]})
            continue
        if any(it[2] < 0 for it in items):
            mixed_sign += 1
        purchases[key] = items[0][1]
    ids = defaultdict(set)
    for shop, day, tid in by_key:
        ids[tid].add((shop, day))
    report = {
        "transactions_in_file": len(by_key),
        "purchases_kept": len(purchases),
        "lines_per_transaction": {str(k): v for k, v in sorted(Counter(len(v) for v in by_key.values()).items())},
        "repeated_identical_lines": repeated_lines,
        "conflicting_times_dropped": conflicting,
        "refunds_excluded": refunds,
        "transactions_with_some_negative_lines": mixed_sign,
        "transaction_ids_reused_across_canteen_or_date": sum(1 for v in ids.values() if len(v) > 1),
    }
    return purchases, report


def intervals(purchases):
    """15-minute counts per canteen-day, from that day's first to its last sale. Intervals inside
    that span with no sale are real zeros; times outside it aren't covered by the source."""
    per_day = defaultdict(Counter)
    for (shop, day, _), wall in purchases.items():
        start = wall.replace(minute=wall.minute - wall.minute % INTERVAL_MIN, second=0)
        per_day[(shop, day)][start] += 1
    out = []
    for (shop, day), counts in sorted(per_day.items()):
        t, last = min(counts), max(counts)
        while t <= last:
            out.append((shop, t.isoformat(), counts.get(t, 0)))
            t += timedelta(minutes=INTERVAL_MIN)
    return out


def clock_evidence(purchases):
    """Median sale time per canteen before and after the end of Swiss summer time. If the clock
    were true UTC, local lunch would appear an hour later in UTC terms after the change."""
    out = {}
    for shop in sorted({k[0] for k in purchases}):
        for label, keep in (("before", lambda d: d < DST_END), ("from", lambda d: d >= DST_END)):
            mins = sorted(w.hour * 60 + w.minute + w.second / 60 for (s, d, _), w in purchases.items() if s == shop and keep(d))
            if mins:
                med = statistics.median(mins)
                out[f"{shop} {label} {DST_END}"] = {"purchases": len(mins), "median": f"{int(med // 60):02d}:{int(med % 60):02d}"}
    return out


def summarize(rows, problems, purchases, report, source, rows_in_file):
    walls = sorted(purchases.values())
    minutes = sorted(w.hour * 60 + w.minute for w in walls)
    q = lambda p: minutes[int(p * (len(minutes) - 1))]  # noqa: E731
    hhmm = lambda m: f"{m // 60:02d}:{m % 60:02d}"  # noqa: E731
    days = sorted({k[1] for k in purchases})
    per_day = Counter((k[0], k[1]) for k in purchases)
    qty = [r[2] for r in rows]
    articles = {r[4][3][1] for r in rows if not float(r[2]).is_integer()}
    weekday_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return {
        "source": {k: source.get(k) for k in ("title", "creators", "publisher", "doi", "page", "published", "updated",
                                               "license", "license_url", "working_paper", "retrieved_at", "csv_sha256")},
        "download_url": (source.get("files") or {}).get(CSV_NAME, {}).get("download_url"),
        "original_location": "Two ZHAW university canteens (Grüental and Vista, Wädenswil, Switzerland), not BU",
        "metric": "Point-of-sale transactions (purchases) counted per 15-minute interval; not people present",
        "fields_used": ["transaction_id", "trans_date", "date", "shop_description", "qty_weight (checked only)",
                        "total_amount (refund check only)"],
        "timestamp_interpretation": "trans_date is read as the canteen's local wall-clock time. The publisher's "
                                    "variable list shows it without a zone ('2017-10-02 11:29:50') and the sale "
                                    "times don't move across the end of Swiss summer time (see clock_evidence); "
                                    "the trailing 'Z' is treated as an export artefact. No conversion is applied.",
        "clock_evidence": clock_evidence(purchases),
        "rows_in_file": rows_in_file,
        "rows_valid": len(rows),
        "rows_rejected": dict(sorted(Counter(p[1] for p in problems).items())),
        "rejected_examples": [{"line": n, "problem": p, "value": v} for n, p, v in problems[:10]],
        **report,
        "qty_weight": {"integer_rows": sum(1 for x in qty if float(x).is_integer()),
                       "fractional_rows": sum(1 for x in qty if not float(x).is_integer()),
                       "fractional_articles": sorted(articles),
                       "meaning": "number of menus, or kg for 'Hot and Cold' plates; never a number of people"},
        "canteens": {shop: sum(1 for k in purchases if k[0] == shop) for shop in sorted({k[0] for k in purchases})},
        "dates": len(days), "first_date": days[0], "last_date": days[-1],
        "dates_by_weekday": {weekday_names[i]: sum(1 for d in days if datetime.fromisoformat(d).weekday() == i)
                             for i in range(7)},
        "purchases_per_canteen_day": {"min": min(per_day.values()), "median": statistics.median(per_day.values()),
                                      "max": max(per_day.values())},
        "sale_time_quantiles": {"p0.5": hhmm(q(0.005)), "p1": hhmm(q(0.01)), "median": hhmm(q(0.5)),
                                "p99": hhmm(q(0.99)), "p99.5": hhmm(q(0.995))},
        "earliest_sale": walls[0].isoformat(), "latest_sale": walls[-1].isoformat(),
        "interval_minutes": INTERVAL_MIN,
        "transformations": [
            "Read the semicolon-separated file; rejected rows with a missing ID or canteen, an unrecognised "
            "trans_date, a date that disagrees with trans_date, or unparseable numbers (listed above).",
            "Grouped rows into transactions by (canteen, date, transaction_id); each transaction counts once, "
            "however many article lines or menus it has. Lines identical to another line of the same transaction "
            "are kept inside that one transaction (they look like the same article bought twice).",
            "Dropped transactions with two different clock times; left out refunds/cancellations (all lines negative).",
            "Read trans_date as local wall-clock time (raw text unchanged in the original file).",
            "Counted purchases per canteen in 15-minute intervals from each canteen-day's first to last sale; "
            "empty intervals inside that span are zeros.",
        ],
    }


def write_markdown(s):
    src = s["source"]
    rej = ", ".join(f"{k}: {v}" for k, v in s["rows_rejected"].items()) or "none"
    ev = "; ".join(f"{k}: median {v['median']} ({v['purchases']:,} purchases)" for k, v in s["clock_evidence"].items())
    lines = [
        "# NOVANIMAL canteen sales: data quality",
        "",
        "Generated by `data/import_novanimal.py`. Do not edit by hand.",
        "",
        "| | |", "|---|---|",
        f"| Source | {src['title']}, {src['creators']} ({src['publisher']}, published {src['published']}) |",
        f"| DOI | {src['page']} |",
        f"| Retrieved | {src['retrieved_at']} from {s['download_url']} (sha256 `{src['csv_sha256']}`) |",
        f"| Licence | {src['license']} ({src['license_url']}): attribution required; changes must be indicated |",
        f"| Original location | {s['original_location']} |",
        f"| Metric | {s['metric']} |",
        f"| Timestamps | {s['timestamp_interpretation']} |",
        f"| Clock evidence | {ev} |",
        f"| Rows in file | {s['rows_in_file']:,} (article lines, not people) |",
        f"| Rows rejected | {rej} |",
        f"| Transactions | {s['transactions_in_file']:,} by (canteen, date, transaction_id); lines per transaction "
        f"{s['lines_per_transaction']} |",
        f"| Repeated identical lines | {s['repeated_identical_lines']} (kept inside their one transaction) |",
        f"| Conflicting clock times | {len(s['conflicting_times_dropped'])} transaction(s) dropped |",
        f"| Refunds/cancellations | {len(s['refunds_excluded'])} left out; {s['transactions_with_some_negative_lines']} "
        "purchase(s) with some negative lines kept |",
        f"| Transaction IDs reused across canteen or date | {s['transaction_ids_reused_across_canteen_or_date']} |",
        f"| Purchases kept | {s['purchases_kept']:,} ({s['canteens']}) |",
        f"| qty_weight | {s['qty_weight']['integer_rows']:,} whole-number rows, {s['qty_weight']['fractional_rows']:,} "
        f"fractional rows ({', '.join(s['qty_weight']['fractional_articles'])}); {s['qty_weight']['meaning']} |",
        f"| Dates | {s['dates']} ({s['first_date']} → {s['last_date']}; {s['dates_by_weekday']}) |",
        f"| Purchases per canteen-day | {s['purchases_per_canteen_day']} |",
        f"| Sale times (wall clock) | {s['sale_time_quantiles']}; earliest {s['earliest_sale']}, latest {s['latest_sale']} |",
        "",
        "## What these numbers are",
        "",
        "Purchases, not occupancy. A transaction is one checkout: it can cover several menus or a weighed buffet "
        "plate, one person can pay for others, and nobody's arrival, departure or seat is recorded. Any "
        "translation into people present is a model (see `data/generate_campus_simulation.py`).",
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
        rows, problems = parse(f)
    purchases, report = group(rows)
    if not purchases:
        sys.exit("No valid transactions; inspect the source format.")
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows(intervals(purchases))
    summary = summarize(rows, problems, purchases, report, source, len(rows) + len(problems))
    OUT_JSON.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_markdown(summary)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true", help="fetch the publisher's files from Zenodo first")
    parser.add_argument("--csv", help=f"use this copy of {CSV_NAME} instead of data/raw/novanimal/")
    args = parser.parse_args()
    if args.download:
        download()
    path = Path(args.csv) if args.csv else RAW_CSV
    if not path.exists():
        sys.exit(f"{path} not found. Run `python data/import_novanimal.py --download`, or put {CSV_NAME} from "
                 f"https://doi.org/10.5281/zenodo.{RECORD_ID} into {RAW_DIR}.")
    s = run(path)
    print(f"Rows:          {s['rows_in_file']:,} article lines; rejected: {s['rows_rejected'] or 'none'}")
    print(f"Transactions:  {s['transactions_in_file']:,}; purchases kept {s['purchases_kept']:,} {s['canteens']}")
    print(f"Excluded:      {len(s['refunds_excluded'])} refund(s), {len(s['conflicting_times_dropped'])} with conflicting times")
    print(f"Dates:         {s['dates']} ({s['first_date']} -> {s['last_date']})")
    print(f"Clock check:   {s['clock_evidence']}")
    print(f"Wrote {OUT_CSV.name}, {OUT_JSON.name}, {OUT_MD.name}")


if __name__ == "__main__":
    main()
