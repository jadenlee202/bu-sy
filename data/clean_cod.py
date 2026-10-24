"""Download COD and clean the Clemente room file.

Source: Liu et al., "COD: A Dataset of Commercial Building Occupancy Traces",
Zenodo, 2017. DOI 10.5281/zenodo.996587

Writes, next to this script:
    clean_cod_occupancy.csv   all valid Clemente records, chronological
    sample_10_records.csv     the first 10 of those (not a random sample)

Run:    python data/clean_cod.py
        python data/clean_cod.py --zip path/to/COD.zip   (skip the download)

Timestamps stay timezone-naive: the source does not say which timezone it uses.
Standard library only.
"""
import argparse
import csv
import io
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

URL = "https://zenodo.org/records/996587/files/COD.zip?download=1"
SOURCE_FILENAME = "processed_occupancy_FORK_Clemente.csv"
FACILITY_ID = "COD_Bosch_Office_1_Clemente"
OUTPUT_DIR = Path(__file__).resolve().parent
COLUMNS = ["facility_id", "timestamp", "occupancy_count"]


def read_archive(zip_path):
    if zip_path:
        return Path(zip_path).read_bytes()
    print("Downloading the COD archive from Zenodo...")
    request = urllib.request.Request(URL, headers={"User-Agent": "BUsy-COD-Cleaner/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def clean(archive_bytes):
    rows, skipped = [], {"header_or_malformed": 0, "negative": 0}
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        matches = [
            n for n in archive.namelist()
            if n.split("/")[-1] == SOURCE_FILENAME and "__MACOSX" not in n
        ]
        if not matches:
            raise FileNotFoundError(f"{SOURCE_FILENAME} not found in COD.zip")
        with archive.open(matches[0]) as raw:
            for record in csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig")):
                try:
                    dt = datetime.strptime(f"{record[0].strip()} {record[1].strip()}",
                                           "%m/%d/%y %H:%M:%S")
                    count = int(record[2].strip())
                except (ValueError, IndexError):
                    skipped["header_or_malformed"] += 1
                    continue
                if count < 0:
                    skipped["negative"] += 1
                    continue
                rows.append({"facility_id": FACILITY_ID,
                             "timestamp": dt.isoformat(sep="T"),
                             "occupancy_count": count})
    if not rows:
        raise ValueError("No valid records parsed; inspect the source format.")
    # Stable sort: events sharing a second keep their source order.
    rows.sort(key=lambda r: r["timestamp"])
    return rows, skipped


def write_csv(path, data):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", help="use a local COD.zip instead of downloading")
    args = parser.parse_args()

    rows, skipped = clean(read_archive(args.zip))
    write_csv(OUTPUT_DIR / "clean_cod_occupancy.csv", rows)
    write_csv(OUTPUT_DIR / "sample_10_records.csv", rows[:10])

    days = sorted({r["timestamp"][:10] for r in rows})
    counts = [r["occupancy_count"] for r in rows]
    print(f"Valid records:   {len(rows):,}")
    print(f"Skipped:         {skipped['header_or_malformed']} header/malformed, "
          f"{skipped['negative']} negative")
    print(f"Range:           {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")
    print(f"Days with data:  {len(days)}")
    print(f"Count range:     {min(counts)}-{max(counts)}")
    print("Wrote clean_cod_occupancy.csv and sample_10_records.csv")


if __name__ == "__main__":
    main()
