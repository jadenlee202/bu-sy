"""Shared busyness + history logic. Cards, details and playback all use this.

Series are lists of (datetime, count) sorted by time. Each count holds until
the next observation, and never past the end of the day's coverage window, so
a count is never carried overnight or across a gap we cannot justify.
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


def latest_at(series: Series, at: datetime, coverage_end: datetime) -> Optional[tuple[datetime, int]]:
    """Latest observation at or before `at`. None before the first one or after coverage ends."""
    if not series or at > coverage_end:
        return None
    i = bisect_right([t for t, _ in series], at)
    return series[i - 1] if i else None


def _segments(series: Series, coverage_end: datetime):
    """(start, end, count) intervals: each count holds until the next observation."""
    ends = [t for t, _ in series[1:]] + [coverage_end]
    for (start, count), end in zip(series, ends):
        if end > start:
            yield start, min(end, coverage_end), count


def hourly_time_weighted(series: Series, first_hour: int, last_hour: int,
                         coverage_end: datetime) -> list[Optional[float]]:
    """Time-weighted mean count for each clock hour in [first_hour, last_hour).

    An hour only partly covered is averaged over its covered part; an hour with
    no coverage at all is None (unavailable), never zero.
    """
    if not series:
        return [None] * (last_hour - first_hour)
    day = series[0][0].replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for h in range(first_hour, last_hour):
        lo, hi = day + timedelta(hours=h), day + timedelta(hours=h + 1)
        weighted = covered = 0.0
        for start, end, count in _segments(series, coverage_end):
            a, b = max(start, lo), min(end, hi)
            if b > a:
                secs = (b - a).total_seconds()
                weighted += count * secs
                covered += secs
        out.append(round(weighted / covered, 2) if covered else None)
    return out


def time_weighted_percentile(days: list[tuple[Series, datetime]], p: float) -> Optional[int]:
    """Smallest count c such that the room held <= c people for at least p of recorded time."""
    seconds = Counter()
    for series, coverage_end in days:
        for start, end, count in _segments(series, coverage_end):
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
