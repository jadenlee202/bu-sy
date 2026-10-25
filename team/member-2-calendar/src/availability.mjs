// Provider-neutral availability adapter (local calculations only).
//
// Nothing in this file talks to a network, reads credentials, or knows about
// any real person. It turns busy intervals + a planning window into candidate
// free windows. It never infers location, hunger, intent, or attendance.

import {
  MINUTE_MS,
  addDays,
  formatInstant,
  isValidTimeZone,
  parseCivilDate,
  parseInstant,
  parseLocalTime,
  wallClockAt,
  zonedWallTimeToInstant,
} from './time.mjs';

export const SCHEMA_VERSION = 'busy.availability/v1';
export const SOURCE_KINDS = Object.freeze(['manual', 'synthetic', 'calendar']);
export const MAX_HORIZON_DAYS = 14;

// ---------------------------------------------------------------------------
// 1. Core pure function
// ---------------------------------------------------------------------------

/**
 * Compute free gaps inside one planning window.
 *
 * @param {Array<{start:number,end:number}>} busy  epoch-ms intervals, half-open [start, end)
 * @param {{start:number,end:number}} window         epoch-ms planning window, half-open
 * @param {number} minDurationMinutes                gaps shorter than this are dropped
 * @returns {{ mergedBusy: Array<{start,end}>, free: Array<{start,end}> }}
 *
 * Steps: clip every interval to the window -> drop empty -> sort -> merge
 * overlapping AND adjacent intervals -> return the complement that is at
 * least `minDurationMinutes` long. Pure: no I/O, no clock, inputs untouched.
 */
export function computeFreeGaps(busy, window, minDurationMinutes) {
  if (!(Number.isFinite(window?.start) && Number.isFinite(window?.end)) || window.end <= window.start) {
    throw new RangeError('planning window must have finite start < end');
  }
  if (!(Number.isFinite(minDurationMinutes) && minDurationMinutes > 0)) {
    throw new RangeError('minDurationMinutes must be a positive number');
  }
  const minMs = minDurationMinutes * MINUTE_MS;

  const clipped = [];
  for (const iv of busy) {
    if (!(Number.isFinite(iv?.start) && Number.isFinite(iv?.end)) || iv.end < iv.start) {
      throw new RangeError('busy intervals must be validated before computeFreeGaps');
    }
    const start = Math.max(iv.start, window.start);
    const end = Math.min(iv.end, window.end);
    if (end > start) clipped.push({ start, end });
  }
  clipped.sort((a, b) => a.start - b.start || a.end - b.end);

  const mergedBusy = [];
  for (const iv of clipped) {
    const last = mergedBusy[mergedBusy.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end); // overlap or adjacent
    else mergedBusy.push({ ...iv });
  }

  const free = [];
  let cursor = window.start;
  for (const iv of mergedBusy) {
    if (iv.start - cursor >= minMs) free.push({ start: cursor, end: iv.start });
    cursor = Math.max(cursor, iv.end);
  }
  if (window.end - cursor >= minMs) free.push({ start: cursor, end: window.end });

  return { mergedBusy, free };
}

// ---------------------------------------------------------------------------
// 2. Planning window resolution (selected date + horizon + daily hours + tz)
// ---------------------------------------------------------------------------

/**
 * Resolve a planning request into concrete per-day windows.
 *
 * request = {
 *   selectedDate: "YYYY-MM-DD",           // first local day to plan
 *   horizonDays: 1..14,                   // number of local days
 *   timeZone: "America/New_York",         // IANA zone, required
 *   dailyStart: "08:00", dailyEnd: "22:00", // local hours; dailyEnd <= dailyStart
 *                                         // means the window ends the next day
 *   minDurationMinutes: 30
 * }
 */
export function resolvePlanningWindows(request) {
  const issues = [];
  const r = request ?? {};
  if (!isValidTimeZone(r.timeZone)) issues.push(issue('invalid_time_zone', `unknown IANA time zone: ${r.timeZone}`));
  const date = parseCivilDate(r.selectedDate);
  if (!date) issues.push(issue('invalid_selected_date', `selectedDate must be YYYY-MM-DD: ${r.selectedDate}`));
  const horizon = r.horizonDays ?? 1;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_DAYS) {
    issues.push(issue('invalid_horizon', `horizonDays must be an integer 1..${MAX_HORIZON_DAYS}`));
  }
  const startMin = parseLocalTime(r.dailyStart ?? '00:00');
  const endMin = parseLocalTime(r.dailyEnd ?? '24:00');
  if (startMin === null || startMin === 24 * 60) issues.push(issue('invalid_daily_start', 'dailyStart must be HH:MM'));
  if (endMin === null) issues.push(issue('invalid_daily_end', 'dailyEnd must be HH:MM or 24:00'));
  const minDur = r.minDurationMinutes ?? 30;
  if (!(Number.isFinite(minDur) && minDur > 0)) issues.push(issue('invalid_min_duration', 'minDurationMinutes must be > 0'));
  if (issues.length) return { ok: false, issues };

  const windows = [];
  for (let i = 0; i < horizon; i++) {
    const day = addDays(date, i);
    const crossesMidnight = endMin <= startMin;
    const endDay = crossesMidnight ? addDays(day, 1) : day;
    const s = zonedWallTimeToInstant(day, startMin, r.timeZone);
    const e = endMin === 24 * 60
      ? zonedWallTimeToInstant(addDays(day, 1), 0, r.timeZone)
      : zonedWallTimeToInstant(endDay, endMin, r.timeZone);
    for (const [edge, res] of [['start', s], ['end', e]]) {
      if (res.resolution !== 'exact') {
        issues.push(issue(`dst_${res.resolution}`, `${fmtDate(day)} daily ${edge} fell in a DST transition; ${res.resolution.replaceAll('_', ' ')}`, 'info'));
      }
    }
    if (e.ms > s.ms) windows.push({ localDate: fmtDate(day), start: s.ms, end: e.ms });
  }
  return { ok: true, windows, minDurationMinutes: minDur, timeZone: r.timeZone, issues };
}

// ---------------------------------------------------------------------------
// 3. Snapshot builder: the single shape the main app consumes
// ---------------------------------------------------------------------------

/**
 * Build an AvailabilitySnapshot from provider-neutral per-calendar results.
 *
 * input = {
 *   request,                                   // see resolvePlanningWindows
 *   source: { kind: "calendar"|"synthetic", provider: "google"|"fixture"|..., connection: "connected"|"disconnected"|"revoked"|"not_configured" },
 *   retrievedAt: RFC3339 string,               // supplied by caller; this module never reads the clock
 *   calendars: [ { ref, status: "ok"|"error", errorReason?, busy: [{start,end}] } ]
 * }
 */
export function buildSnapshot(input) {
  const { request, source, retrievedAt, calendars = [] } = input ?? {};
  const issues = [];

  if (!source || !SOURCE_KINDS.includes(source.kind) || source.kind === 'manual') {
    issues.push(issue('invalid_source', 'buildSnapshot handles kind "calendar" or "synthetic"; use fromManualWindows for manual input', 'error'));
  }
  const retrievedMs = parseInstant(retrievedAt);
  if (retrievedMs === null) issues.push(issue('invalid_retrieved_at', 'retrievedAt must be RFC 3339 with an offset', 'error'));

  const planning = resolvePlanningWindows(request);
  issues.push(...planning.issues);
  const base = baseSnapshot(request, source, retrievedAt);

  if (!planning.ok || issues.some((i) => i.severity === 'error')) {
    return { ...base, status: 'error', freeWindows: [], busyIntervals: [], calendars: [], issues };
  }

  if (source.connection && source.connection !== 'connected') {
    return {
      ...base,
      status: 'disconnected',
      freeWindows: [],
      busyIntervals: [],
      calendars: [],
      issues: [...issues, issue('source_disconnected', `calendar connection is "${source.connection}"; fall back to manual free windows`, 'warning')],
    };
  }

  // Validate busy intervals per calendar. Invalid ones are reported, never silently dropped.
  const okBusy = [];
  const calendarStatus = [];
  for (const cal of calendars) {
    if (cal.status !== 'ok') {
      calendarStatus.push({ ref: cal.ref, status: 'error', errorReason: cal.errorReason ?? 'unknown' });
      issues.push(issue('calendar_unavailable', `calendar ${cal.ref}: ${cal.errorReason ?? 'unknown'}`, 'warning'));
      continue;
    }
    let invalid = 0;
    for (const raw of cal.busy ?? []) {
      const start = parseInstant(raw?.start);
      const end = parseInstant(raw?.end);
      // Echo only start/end so stray provider fields (titles, locations) never reach logs.
      const shown = JSON.stringify({ start: raw?.start, end: raw?.end });
      if (start === null || end === null) {
        invalid++;
        issues.push(issue('invalid_interval', `calendar ${cal.ref}: unparseable interval ${shown}`, 'warning'));
      } else if (end < start) {
        invalid++;
        issues.push(issue('invalid_interval', `calendar ${cal.ref}: end before start ${shown}`, 'warning'));
      } else if (end > start) {
        okBusy.push({ start, end });
      } // zero-length intervals block nothing and are ignored
    }
    calendarStatus.push({ ref: cal.ref, status: invalid ? 'degraded' : 'ok', ...(invalid ? { invalidIntervals: invalid } : {}) });
  }

  const okCount = calendarStatus.filter((c) => c.status === 'ok').length;
  const anyUsable = calendarStatus.some((c) => c.status !== 'error');
  if (calendars.length === 0) {
    issues.push(issue('no_calendars', 'no calendars were queried', 'error'));
  }
  if (!anyUsable) {
    return { ...base, status: 'error', freeWindows: [], busyIntervals: [], calendars: calendarStatus, issues };
  }

  const freeWindows = [];
  const busyIntervals = [];
  for (const w of planning.windows) {
    const { mergedBusy, free } = computeFreeGaps(okBusy, w, planning.minDurationMinutes);
    busyIntervals.push(...mergedBusy.map((iv) => toWire(iv, planning.timeZone, w.localDate)));
    freeWindows.push(...free.map((iv) => toWire(iv, planning.timeZone, w.localDate)));
  }

  const complete = okCount === calendars.length;
  return {
    ...base,
    status: complete ? 'ok' : 'partial',
    // When partial, a free window may still conflict with an event on a calendar we could not read.
    requiresUserConfirmation: !complete,
    freeWindows,
    busyIntervals,
    calendars: calendarStatus,
    issues,
  };
}

/**
 * Convert manually entered free windows into the SAME snapshot shape, so manual
 * and calendar-derived availability flow through one recommendation workflow.
 *
 * entries: [{ date: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM" }] in request.timeZone.
 * An end <= start means the window continues past midnight.
 */
export function fromManualWindows({ request, entries = [], enteredAt }) {
  const issues = [];
  const planning = resolvePlanningWindows(request);
  issues.push(...planning.issues);
  if (parseInstant(enteredAt) === null) issues.push(issue('invalid_retrieved_at', 'enteredAt must be RFC 3339 with an offset', 'error'));
  const base = baseSnapshot(request, { kind: 'manual', provider: 'user_entry' }, enteredAt);
  if (!planning.ok || issues.some((i) => i.severity === 'error')) {
    return { ...base, status: 'error', freeWindows: [], busyIntervals: [], calendars: [], issues };
  }

  const freeWindows = [];
  for (const e of entries) {
    const d = parseCivilDate(e?.date);
    const s = parseLocalTime(e?.start);
    const en = parseLocalTime(e?.end);
    if (!d || s === null || en === null || s === 24 * 60) {
      issues.push(issue('invalid_interval', `manual entry rejected: ${JSON.stringify(e)}`, 'warning'));
      continue;
    }
    const startMs = zonedWallTimeToInstant(d, s, planning.timeZone).ms;
    const endMs = en === 24 * 60 || en <= s
      ? zonedWallTimeToInstant(addDays(d, 1), en === 24 * 60 ? 0 : en, planning.timeZone).ms
      : zonedWallTimeToInstant(d, en, planning.timeZone).ms;
    // Manual windows are also clipped to the planning horizon so both sources behave identically.
    for (const w of planning.windows) {
      const start = Math.max(startMs, w.start);
      const end = Math.min(endMs, w.end);
      if (end - start >= planning.minDurationMinutes * MINUTE_MS) freeWindows.push(toWire({ start, end }, planning.timeZone, w.localDate));
    }
  }
  freeWindows.sort((a, b) => parseInstant(a.start) - parseInstant(b.start));
  return { ...base, status: 'ok', requiresUserConfirmation: false, freeWindows, busyIntervals: [], calendars: [], issues };
}

/** True when a calendar-derived snapshot is older than maxAgeMinutes at `nowIso`. */
export function isStale(snapshot, nowIso, maxAgeMinutes = 15) {
  if (snapshot?.source?.kind === 'manual') return false;
  const now = parseInstant(nowIso);
  const at = parseInstant(snapshot?.retrievedAt);
  if (now === null || at === null) return true;
  return now - at > maxAgeMinutes * MINUTE_MS;
}

// ---------------------------------------------------------------------------
// 3b. Bridge to the main app's planner request (web/js/recommend.js on
//     feature/what-fits-now): { start: "HH:MM", minutes: 5..720, source }.
//     Only the time fields are produced. activity, from, to, buffer, and
//     preferences stay user-chosen: availability never implies a location.
// ---------------------------------------------------------------------------

export const PLANNER_MIN_MINUTES = 5;
export const PLANNER_MAX_MINUTES = 720;

/**
 * Convert snapshot free windows into planner time fields, one per window.
 * Returns { usable, requiresUserConfirmation, windows, notes }.
 * The planner covers one local day, so windows are cut at local midnight.
 */
export function toPlannerWindows(snapshot) {
  const notes = [];
  if (!snapshot || (snapshot.status !== 'ok' && snapshot.status !== 'partial')) {
    return { usable: false, requiresUserConfirmation: false, windows: [], notes: [`snapshot status "${snapshot?.status}": use manual entry`] };
  }
  const tz = snapshot.planning.timeZone;
  const windows = [];
  for (const w of snapshot.freeWindows) {
    const startMs = parseInstant(w.start);
    let endMs = parseInstant(w.end);
    const s = wallClockAt(startMs, tz);
    const nextMidnight = zonedWallTimeToInstant(addDays(s, 1), 0, tz).ms;
    if (endMs > nextMidnight) {
      endMs = nextMidnight;
      notes.push(`${w.start}: cut at local midnight (planner covers one day)`);
    }
    let minutes = Math.round((endMs - startMs) / MINUTE_MS);
    if (minutes > PLANNER_MAX_MINUTES) {
      minutes = PLANNER_MAX_MINUTES;
      notes.push(`${w.start}: free for longer; capped at ${PLANNER_MAX_MINUTES} minutes`);
    }
    if (minutes < PLANNER_MIN_MINUTES) continue;
    const startHHMM = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
    windows.push({ date: fmtDate(s), start: startHHMM, minutes, source: snapshot.source.kind });
  }
  return { usable: true, requiresUserConfirmation: snapshot.requiresUserConfirmation === true, windows, notes };
}

// ---------------------------------------------------------------------------
// 4. Google free/busy response normalizer (offline; never called against a live API)
// ---------------------------------------------------------------------------

/**
 * Translate a Google Calendar `freebusy.query` response body into the
 * provider-neutral `calendars` array accepted by buildSnapshot.
 * Shape per the public reference: { calendars: { <id>: { busy: [{start,end}], errors: [{domain,reason}] } } }.
 * Calendar IDs are replaced by opaque refs so no email address leaves the adapter.
 */
export function normalizeGoogleFreeBusy(body, requestedRefs) {
  const out = [];
  const map = body?.calendars ?? {};
  const ids = requestedRefs ? Object.keys(requestedRefs) : Object.keys(map);
  ids.forEach((id, i) => {
    const ref = requestedRefs?.[id] ?? `calendar-${i + 1}`;
    const entry = map[id];
    if (!entry) {
      out.push({ ref, status: 'error', errorReason: 'missing_from_response', busy: [] });
    } else if (Array.isArray(entry.errors) && entry.errors.length > 0) {
      out.push({ ref, status: 'error', errorReason: entry.errors.map((e) => e.reason).join(','), busy: [] });
    } else {
      out.push({ ref, status: 'ok', busy: (entry.busy ?? []).map(({ start, end }) => ({ start, end })) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseSnapshot(request, source, retrievedAt) {
  return {
    schema: SCHEMA_VERSION,
    source: source
      ? { kind: source.kind, provider: source.provider ?? null, ...(source.connection ? { connection: source.connection } : {}) }
      : null,
    retrievedAt: retrievedAt ?? null,
    planning: {
      selectedDate: request?.selectedDate ?? null,
      horizonDays: request?.horizonDays ?? 1,
      timeZone: request?.timeZone ?? null,
      dailyStart: request?.dailyStart ?? '00:00',
      dailyEnd: request?.dailyEnd ?? '24:00',
      minDurationMinutes: request?.minDurationMinutes ?? 30,
    },
  };
}

// Output intervals carry ONLY time data. No titles, locations, attendees, or inferred intent.
function toWire({ start, end }, timeZone, localDate) {
  return {
    start: formatInstant(start, timeZone),
    end: formatInstant(end, timeZone),
    timeZone,
    planningDate: localDate,
    durationMinutes: Math.round((end - start) / MINUTE_MS),
  };
}

function issue(code, message, severity = 'error') {
  return { code, severity, message };
}

function fmtDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
