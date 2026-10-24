// Time helpers: strict RFC 3339 parsing, IANA time-zone offsets, and
// wall-clock -> instant conversion with explicit DST handling.
// Uses only the built-in Intl API (no dependencies).

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse an RFC 3339 timestamp that carries an explicit offset ("Z" or ±HH:MM).
 * Timestamps without an offset are rejected: they are ambiguous.
 * Returns epoch milliseconds, or null when the value is invalid.
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', frac = '', off] = m;
  const year = +y, month = +mo, day = +d, hour = +h, minute = +mi, second = +s;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const oh = +off.slice(1, 3), om = +off.slice(4, 6);
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const ms = frac ? Math.floor(Number(`0${frac}`) * 1000) : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * MINUTE_MS;
}

/** Parse "YYYY-MM-DD" into { year, month, day } or null. */
export function parseCivilDate(value) {
  if (typeof value !== 'string') return null;
  const m = CIVIL_DATE.exec(value);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Parse "HH:MM" (00:00-23:59, plus "24:00" meaning end of day) into minutes. */
export function parseLocalTime(value) {
  if (typeof value !== 'string') return null;
  const m = LOCAL_TIME.exec(value);
  if (!m) return null;
  const hour = +m[1], minute = +m[2];
  if (hour === 24 && minute === 0) return 24 * 60;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Add whole days to a civil date. */
export function addDays({ year, month, day }, days) {
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map();
function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields for an instant in a time zone. */
export function wallClockAt(ms, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

/** UTC offset in minutes for an instant in a time zone (e.g. -240 for EDT). */
export function offsetMinutesAt(ms, timeZone) {
  const w = wallClockAt(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(ms / 1000) * 1000;
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

/**
 * Convert a local wall-clock time in `timeZone` to an instant.
 *
 * DST handling matches the "compatible" policy used by Temporal / RFC 5545:
 *  - ambiguous time (fall-back repeated hour): the EARLIER instant is used.
 *  - nonexistent time (spring-forward gap): shifted FORWARD by the gap length.
 *
 * Returns { ms, resolution } where resolution is
 * "exact" | "ambiguous_used_earlier" | "nonexistent_shifted_forward".
 */
export function zonedWallTimeToInstant(date, minutesOfDay, timeZone) {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minutesOfDay * MINUTE_MS;
  const offsetBefore = offsetMinutesAt(naive - DAY_MS, timeZone);
  const offsetAfter = offsetMinutesAt(naive + DAY_MS, timeZone);
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((off) => naive - off * MINUTE_MS)
    .filter((t) => t + offsetMinutesAt(t, timeZone) * MINUTE_MS === naive)
    .sort((a, b) => a - b);

  if (candidates.length === 1) return { ms: candidates[0], resolution: 'exact' };
  if (candidates.length > 1) return { ms: candidates[0], resolution: 'ambiguous_used_earlier' };
  return { ms: naive - offsetBefore * MINUTE_MS, resolution: 'nonexistent_shifted_forward' };
}

function pad(n, width = 2) {
  return String(Math.abs(n)).padStart(width, '0');
}

/** Format an instant as RFC 3339 with the offset of `timeZone` (e.g. 2026-10-26T09:00:00-04:00). */
export function formatInstant(ms, timeZone) {
  const w = wallClockAt(ms, timeZone);
  const off = offsetMinutesAt(ms, timeZone);
  const sign = off < 0 ? '-' : '+';
  return (
    `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}` +
    `${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

export { MINUTE_MS };
