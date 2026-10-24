// Clock helpers shared by the screens and the planner engine (no DOM, so Node
// tests can import them). Times are read as text ("HH:MM" or the time part of
// an ISO timestamp), never through `new Date(...)`, so no viewer timezone is applied.

export const clockSec = (hms) => { const [h, m, s = 0] = hms.split(":").map(Number); return h * 3600 + m * 60 + s; };
export const toMin = (hhmm) => clockSec(hhmm) / 60;
export const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const fmtTime = (min) => { const h = Math.floor(min / 60) % 24; return `${h % 12 || 12}:${String(min % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
export const fmtHour = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "AM" : "PM"}`;
export const fmtHHMM = (t) => fmtTime(clockSec(t) / 60);
/** "6 AM", "4:30 PM", "12 AM" (midnight at the end of the day). */
export const fmtShort = (min) => (min % 60 ? fmtTime(min) : fmtHour(min / 60));

const obsSec = (o) => (o._sec ??= clockSec(o.observed_at.slice(11, 19)));
export const obsMinute = (o) => Math.floor(obsSec(o) / 60);

/** Latest observation at or before `minute`; null before the first one or after coverage ends. */
export function latestAt(observations, minute, coverageEnd) {
  const sec = minute * 60;
  if (sec > clockSec(coverageEnd)) return null;
  let lo = 0, hi = observations.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (obsSec(observations[mid]) <= sec) lo = mid + 1; else hi = mid;
  }
  return lo ? observations[lo - 1] : null;
}
