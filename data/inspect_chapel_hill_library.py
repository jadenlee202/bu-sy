"""Re-check the Chapel Hill Public Library Foot Traffic source (Town of Chapel Hill, ODbL).

BU-sy evaluated it as a library reference on 2026-10-25 and did not use it: every row's
`Datetime` was midnight UTC on a date in 1899-1901, so the time of day was lost, and
Children's Room occupancy exceeded Total Building occupancy. This script downloads the
table only when you run it, reports the same checks, and stores nothing.

Run:    python data/inspect_chapel_hill_library.py
Standard library only.
"""
import json
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

SERVICE = ("https://services2.arcgis.com/7KRXAKALbBGlCW77/ArcGIS/rest/services/"
           "Chapel_Hill_Public_Library_Foot_Traffic/FeatureServer/0/query")
METADATA = "https://www.arcgis.com/sharing/rest/content/items/c55d120fe0ee48ac85ce1a0cb58edf42?f=pjson"
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BUsy-inspect/1.0"}), timeout=60) as r:
        return json.load(r)


def main():
    meta = fetch(METADATA)
    rows, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "orderByFields": "OBJECTID",
                                    "resultOffset": offset, "resultRecordCount": 2000, "f": "json"})
        page = fetch(f"{SERVICE}?{q}")
        feats = page.get("features", [])
        rows += [f["attributes"] for f in feats]
        offset += len(feats)
        if not feats or not page.get("exceededTransferLimit"):
            break
    stamps = [EPOCH + timedelta(milliseconds=r["Datetime"]) for r in rows if r["Datetime"] is not None]
    years = Counter(t.year for t in stamps)
    times = Counter(t.strftime("%H:%M") for t in stamps)
    ordered = all(a <= b for a, b in zip(stamps, stamps[1:]))
    child_over = sum(1 for r in rows if None not in (r["Total_Occupancy"], r["Children_s_Room_Occupancy"])
                     and r["Children_s_Room_Occupancy"] > r["Total_Occupancy"])
    print(f"Title:        {meta.get('title')} (last modified {datetime.fromtimestamp(meta['modified'] / 1000, timezone.utc):%Y-%m-%d})")
    print(f"License link: {'odbl' in (meta.get('licenseInfo') or '').lower() and 'ODbL' or 'not found'}")
    print(f"Rows:         {len(rows):,}")
    print(f"Years:        {dict(sorted(years.items()))}")
    print(f"Times of day: {times.most_common(3)}")
    print(f"In time order by OBJECTID: {ordered}")
    print(f"Children's Room > Total Building: {child_over:,} rows")
    usable = min(years) >= 2018 and len(times) > 1
    print("Usable for a time-of-day simulation:", "maybe; review before using" if usable else "no")


if __name__ == "__main__":
    main()
