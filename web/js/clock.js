// Clock helpers shared by the screens and the planner engine (no DOM, so Node
// tests can import them). Times are read as text ("HH:MM" or the time part of
// an ISO timestamp), never through `new Date(...)`, so no viewer timezone is applied.

export const clockSec = (hms) => { const [h, m, s = 0] = hms.split(":").map(Number); return h * 3600 + m * 60 + s; };
export const toMin = (hhmm) => clockSec(hhmm) / 60;
export const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const fmtTime = (min) => { const h = Math.floor(min / 60) % 24; return `${h % 12 || 12}:${String(min % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
export const fmtHour = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "AM" : "PM"}`;
export const fmtHHMM = (t) => fmtTime(Math.floor(clockSec(t) / 60)); // "00:09:02" -> 12:09 AM
/** "6 AM", "4:30 PM", "12 AM" (midnight at the end of the day). */
export const fmtShort = (min) => (min % 60 ? fmtTime(min) : fmtHour(min / 60));

const obsSec = (o) => (o._sec ??= clockSec(o.observed_at.slice(11, 19)));
export const obsMinute = (o) => Math.floor(obsSec(o) / 60);

/**
 * Latest observation at or before `minute`; null before the first one, after coverage
 * ends, or when it is older than `maxHoldMin` (a gap in a sampled recording, see
 * server/analytics.py). Same rule as the server's latest_at.
 */
export function latestAt(observations, minute, coverageEnd, maxHoldMin = null) {
  const sec = minute * 60;
  if (sec > clockSec(coverageEnd)) return null;
  let lo = 0, hi = observations.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (obsSec(observations[mid]) <= sec) lo = mid + 1; else hi = mid;
  }
  const o = lo ? observations[lo - 1] : null;
  return o && maxHoldMin != null && sec - obsSec(o) > maxHoldMin * 60 ? null : o;
}

/**
 * Time-weighted mean count over [startMin, endMin), plus the covered seconds. Each count
 * holds until the next observation, the end of coverage, or `maxHoldMin` after it; time
 * with no coverage is left out, never counted as zero. Same rule as the server's
 * time_weighted_mean (server/analytics.py).
 */
export function meanOver(observations, startMin, endMin, coverageEnd, maxHoldMin = null) {
  const from = startMin * 60, to = endMin * 60, end = clockSec(coverageEnd);
  let weighted = 0, covered = 0;
  observations.forEach((o, i) => {
    const s = obsSec(o);
    let e = Math.min(i + 1 < observations.length ? obsSec(observations[i + 1]) : end, end);
    if (maxHoldMin != null) e = Math.min(e, s + maxHoldMin * 60);
    const lo = Math.max(s, from), hi = Math.min(e, to);
    if (hi > lo) { weighted += o.occupancy_count * (hi - lo); covered += hi - lo; }
  });
  return { mean: covered ? weighted / covered : null, covered };
}

/** Demo thresholds, same as the server's classify(): quiet < 40%, moderate < 75%, else busy. */
export const THRESHOLD_NOTE = "demo thresholds (quiet <40%, moderate <75%, busy >=75%), not validated limits";
export const classify = (ratio) => (ratio == null ? "unknown" : ratio < 0.4 ? "quiet" : ratio < 0.75 ? "moderate" : "busy");

/** The UTC offset written on an observation ("-08:00"), or null when the source gives none. */
export const obsOffset = (o) => o.observed_at.match(/[+-]\d\d:\d\d$/)?.[0] ?? null;
