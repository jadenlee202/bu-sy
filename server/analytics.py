"""Shared busyness + history logic. Cards, details and playback all use this.

Series are lists of (datetime, count) sorted by time. Each count holds until
the next observation, and never past the end of the day's coverage window, so
a count is never carried overnight or across a gap we cannot justify.

`max_hold` (optional) caps how long one count may stand in for the time after
it. Event-based data (COD) leaves it None: a count is valid until the next
event. Sampled data (the campus gym, ~every 10 min) sets it, so a long gap in
the recording becomes "no data", never the last count stretched out or zero.
"""
from bisect import bisect_right
from collections import Counter
from datetime import datetime, timedelta
from typing import Optional

QUIET_BELOW = 0.40
BUSY_FROM = 0.75
THRESHOLD_NOTE = "demo thresholds (quiet <40%, moderate <75%, busy >=75%), not validated limits"

Series = list[tuple[datetime, int]]


def classify(ratio: Optional[float], tolerance: float = 1.0) -> str:
    if ratio is None:
        return "unknown"
    score = ratio / tolerance
    if score < QUIET_BELOW:
        return "quiet"
    if score < BUSY_FROM:
        return "moderate"
    return "busy"


def latest_at(series: Series, at: datetime, coverage_end: datetime,
              max_hold: Optional[timedelta] = None) -> Optional[tuple[datetime, int]]:
    """Latest observation at or before `at`. None before the first one, after coverage
    ends, or when the latest one is older than `max_hold` (a gap in the recording)."""
    if not series or at > coverage_end:
        return None
    i = bisect_right([t for t, _ in series], at)
    if not i:
        return None
    obs = series[i - 1]
    if max_hold is not None and at - obs[0] > max_hold:
        return None
    return obs


def _segments(series: Series, coverage_end: datetime, max_hold: Optional[timedelta] = None):
    """(start, end, count) intervals: each count holds until the next observation,
    the end of coverage, or `max_hold` after it, whichever comes first."""
    ends = [t for t, _ in series[1:]] + [coverage_end]
    for (start, count), end in zip(series, ends):
        end = min(end, coverage_end)
        if max_hold is not None:
            end = min(end, start + max_hold)
        if end > start:
            yield start, end, count


def hour_sums(series: Series, first_hour: int, last_hour: int, coverage_end: datetime,
              max_hold: Optional[timedelta] = None) -> list[tuple[float, float]]:
    """(count x seconds, covered seconds) for each clock hour in [first_hour, last_hour).

    Hours are on the series' own clock (its local midnight), so weekday/hour stay in
    the source's local time. Summing these across days gives a time-weighted typical
    value that counts every covered second once and never fills gaps with zero.
    """
    sums = [[0.0, 0.0] for _ in range(last_hour - first_hour)]
    if not series:
        return [tuple(s) for s in sums]
    day = series[0][0].replace(hour=0, minute=0, second=0, microsecond=0)
    for start, end, count in _segments(series, coverage_end, max_hold):
        t = start
        while t < end:
            h = int((t - day).total_seconds() // 3600)
            nxt = min(end, day + timedelta(hours=h + 1))
            if first_hour <= h < last_hour:
                secs = (nxt - t).total_seconds()
                sums[h - first_hour][0] += count * secs
                sums[h - first_hour][1] += secs
            t = nxt
    return [tuple(s) for s in sums]


def hourly_time_weighted(series: Series, first_hour: int, last_hour: int,
                         coverage_end: datetime, max_hold: Optional[timedelta] = None) -> list[Optional[float]]:
    """Time-weighted mean count for each clock hour in [first_hour, last_hour).

    An hour only partly covered is averaged over its covered part; an hour with
    no coverage at all is None (unavailable), never zero.
    """
    return [round(w / c, 2) if c else None
            for w, c in hour_sums(series, first_hour, last_hour, coverage_end, max_hold)]


def time_weighted_percentile(days: list[tuple[Series, datetime]], p: float,
                             max_hold: Optional[timedelta] = None) -> Optional[int]:
    """Smallest count c such that the place held <= c people for at least p of recorded time."""
    seconds = Counter()
    for series, coverage_end in days:
        for start, end, count in _segments(series, coverage_end, max_hold):
            seconds[count] += (end - start).total_seconds()
    total = sum(seconds.values())
    if not total:
        return None
    running = 0.0
    for count in sorted(seconds):
        running += seconds[count]
        if running >= p * total:
            return count
    return max(seconds)
