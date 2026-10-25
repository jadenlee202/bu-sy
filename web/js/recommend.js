// BU-sy planner engine: which campus places fit a free window?
//
// The single source of truth for recommendations. It uses transparent,
// deterministic rules (no ML, no randomness, no clock reads) and runs
// unchanged in API mode and static mode. It reads normalized data only:
//   campus     server/campus.py -> GET /api/campus or web/data/campus.json
//   histories  { facility_id: DayHistory } from /history or web/data/history/
//   request    a free window, below. Manual today; a calendar can supply the
//              same shape later (source: "calendar"). A calendar event is never
//              taken as proof of where the student is: `from` is always chosen.
//
// Request
//   activity            "study" | "eat" | "workout"
//   start               "HH:MM", the selected demo time
//   minutes             free minutes; the window ends at the next commitment
//   source              "manual" | "calendar"
//   from, to            location ids; `to` null = onward travel not counted.
//                       `from` empty = starting point unknown: places are only
//                       browsed ("unchecked"), never called a fit, because the
//                       walk there can't be counted. Unknown is not zero.
//   minActivity, buffer minutes; the buffer is kept free before the next commitment
//   preferQuiet, preferShortTravel   ranking preferences
//   needs               amenity ids a place must list (e.g. "outlets")
//   mode                "duration" (default: `minutes` as entered) or "until":
//                       `until` "HH:MM" is when the next class or commitment
//                       starts, and minutes = until - start (same day only).
//   date                "YYYY-MM-DD" the plan is for, used only to look up
//                       verified opening hours. The planner passes the
//                       simulated demo day, the same day the occupancy replays.
//
// Fit rule: minutes >= travel there + preparation + activity (>= minActivity)
// + cleanup + onward + buffer. Preparation/cleanup are editable allowances.
// The place must be open for the whole visit: verified BU hours when hours.json
// has them for `date` (meal service for eating at a dining hall, building hours
// otherwise), else the illustrative demo hours. Unknown hours are never "confirmed": they go to checkHours.
// Without a starting point the same rule runs with the walk there left out, so
// it can only rule places out (too little time even before walking, closed).
//
// Busyness: `busy` is the simulated count at the selected start (departure)
// time. With a known start, `visit` also profiles the simulated history minute
// by minute over the planned activity (arrive -> leave by); uncovered minutes
// are "unknown", never zero or quiet. Ranking uses the visit profile when it exists.

import { fmtShort, fmtTime, latestAt, toHHMM, toMin } from "./clock.js";
import { addDays, dateLabel, daySchedule, formatPeriod } from "./hours.js";

export const ALLOWANCES = {
  study: { preparation: 3, cleanup: 2 },
  eat: { preparation: 5, cleanup: 2 },
  workout: { preparation: 5, cleanup: 5 },
};
export const allowances = (req) => ({
  ...ALLOWANCES[req.activity],
  ...(req.preparation != null ? { preparation: req.preparation } : {}),
  ...(req.cleanup != null ? { cleanup: req.cleanup } : {}),
});
export const DAY_END = 24 * 60;
export const MAX_SHOWN = 3;
/** Ranking order for busyness. Unknown is never treated as quiet. */
export const LEVEL_RANK = { quiet: 0, moderate: 1, unknown: 2, busy: 3 };
const LEVEL_WORD = { quiet: "Quiet", moderate: "Moderate", busy: "Busy" };
const SHORTEN_FLOOR = 10; // never suggest an activity shorter than this

// ---------- input ----------
export function requestFromScenario(s) {
  return {
    activity: s.activity, start: s.start, minutes: s.minutes, source: s.source ?? "manual",
    from: s.start_location, to: s.next_location ?? null, minActivity: s.min_activity, buffer: s.buffer,
    ...ALLOWANCES[s.activity], access: s.access ?? {}, preferQuiet: s.prefer_quiet, preferShortTravel: s.prefer_short_travel, needs: [...s.needs],
  };
}

// ---------- free window: duration or next-commitment time ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_WINDOW = 5, MAX_WINDOW = 720;

/** Minutes from `start` to `until` on the same day; null when either time is missing or malformed. */
export function minutesUntil(start, until) {
  if (!HHMM.test(start ?? "") || !HHMM.test(until ?? "")) return null;
  return toMin(until) - toMin(start);
}

/** The request the engine evaluates. In "until" mode the free minutes are derived, never typed. */
export function normalizeRequest(req) {
  if (req.mode !== "until") return req;
  return { ...req, minutes: minutesUntil(req.start, req.until) ?? NaN };
}

/**
 * Switch the free-window input. A valid window carries over (60 min from 3 PM <-> until 4 PM);
 * otherwise the other mode keeps whatever it had, so switching back and forth loses nothing.
 */
export function switchWindowMode(req, mode) {
  if (mode === "until") {
    const end = HHMM.test(req.start ?? "") && Number.isInteger(req.minutes) && req.minutes > 0
      ? toMin(req.start) + req.minutes : null;
    return { ...req, mode, until: end != null && end < DAY_END ? toHHMM(end) : (req.until ?? "") };
  }
  const m = minutesUntil(req.start, req.until);
  return { ...req, mode: "duration", minutes: m != null && m >= MIN_WINDOW && m <= MAX_WINDOW ? m : req.minutes };
}

export function validateRequest(req, campus) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const isLocation = (id) => campus.locations.some((l) => l.id === id);

  if (!campus.activities.some((a) => a.id === req.activity)) add("activity", "Choose an activity.");
  const startOk = HHMM.test(req.start ?? "");
  if (!startOk) add("start", "Enter a start time.");
  if (req.mode === "until") {
    // The demo models one day, so an earlier clock time is an error, not "tomorrow".
    const m = minutesUntil(req.start, req.until);
    if (!HHMM.test(req.until ?? "")) add("until", "Enter when your next class or commitment starts.");
    else if (startOk && m === 0) add("until", "Your next commitment starts at your start time, so there's no free time.");
    else if (startOk && m < 0) {
      add("until", `Your next commitment must be after your start time (${fmtTime(toMin(req.start))}). The demo covers one day, so times after midnight aren't supported.`);
    } else if (startOk && m < MIN_WINDOW) add("until", `That leaves ${m} min. Free time should be at least ${MIN_WINDOW} minutes.`);
    else if (startOk && m > MAX_WINDOW) add("until", `That's ${m} min free. Free time should be ${MIN_WINDOW} to ${MAX_WINDOW} minutes.`);
  } else if (!int(req.minutes, MIN_WINDOW, MAX_WINDOW)) add("minutes", "Free time should be 5 to 720 minutes.");
  else if (startOk && toMin(req.start) + req.minutes > DAY_END) add("minutes", "This window runs past midnight. The demo covers one day.");
  if (req.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) add("date", "Planning date must be YYYY-MM-DD.");
  if (hasStart(req) && !isLocation(req.from)) add("from", "Choose a listed starting point, or none.");
  if (req.to != null && !isLocation(req.to)) add("to", "Choose a listed next stop, or none.");
  if (!int(req.minActivity, 5, 600)) add("minActivity", "Minimum time should be 5 to 600 minutes.");
  if (!int(req.buffer, 0, 120)) add("buffer", "Buffer should be 0 to 120 minutes.");
  for (const [field, value] of Object.entries(allowances(req))) {
    if (!int(value, 0, 120)) add(field, "Preparation and cleanup should be 0 to 120 minutes.");
  }
  for (const n of req.needs ?? []) if (!(n in campus.amenity_labels)) add("needs", `Unknown need: ${n}`);
  return errors;
}

/**
 * The simulated demo day the planner plans for: the recorded day of the campus places' histories
 * (all one sample Monday). null when they disagree or are missing, so no verified hours are used.
 */
export function demoDate(campus, histories) {
  const days = [...new Set(campus.places.map((p) => histories[p.facility_id]?.day ?? null))];
  return days.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(days[0] ?? "") ? days[0] : null;
}

/** A starting point was given (it may still be invalid; validateRequest says so). */
export const hasStart = (req) => req.from != null && req.from !== "";

// ---------- data lookups ----------
export const activityInfo = (campus, id) => campus.activities.find((a) => a.id === id);
export const locationName = (campus, id) => campus.locations.find((l) => l.id === id)?.name ?? id;

/** Sample walking minutes; 0 for the same location; null when the route is unknown. */
export function travelMinutes(campus, a, b) {
  if (a === b) return 0;
  const t = campus.travel.find((r) => (r.from_id === a && r.to_id === b) || (r.from_id === b && r.to_id === a));
  return t ? t.minutes : null;
}

/** Open intervals [start, end) in minutes. null = hours unknown. */
export function openSegments(place) {
  return place.hours ? place.hours.map(([a, b]) => [toMin(a), toMin(b)]) : null;
}

export const hoursText = (place) =>
  place.hours?.map(([a, b]) => `${fmtShort(toMin(a))}–${fmtShort(toMin(b))}`).join(", ") ?? null;

/** The simulation period covering `minute` (dataset-derived, modeled or unavailable), or null. */
export function periodAt(simulation, minute) {
  return simulation?.periods?.find((p) => toMin(p.start) <= minute && minute < toMin(p.end)) ?? null;
}

// ---------- opening hours used for a fit ----------
const mergeSegs = (segs) => segs.slice().sort((x, y) => x[0] - y[0]).reduce((acc, [a, b]) => {
  const last = acc[acc.length - 1];
  if (last && a <= last[1]) last[1] = Math.max(last[1], b); else acc.push([a, b]);
  return acc;
}, []);
// Overnight periods ("22:00"-"02:00") are cut at midnight: the planner models one day.
const periodSegs = (periods) => mergeSegs(periods.map((p) => {
  const a = toMin(p.start), b = toMin(p.end);
  return [a, b > a ? b : DAY_END];
}));
const intersectSegs = (xs, ys) => xs.flatMap(([a, b]) => ys.map(([c, d]) => [Math.max(a, c), Math.min(b, d)]))
  .filter(([a, b]) => b > a);
// Decided = verified for this exact date. daySchedule() marks days outside a schedule's published
// range as `assumed` (the weekly pattern projected forward); the planner never treats those as verified.
const isDecided = (s) => (s.status === "scheduled" || s.status === "closed") && !s.assumed;

/**
 * The hours that decide whether `place` is open for this request.
 *   basis "verified":     hours.json has a verified schedule covering req.date (special dates
 *                         included). Eating at a dining hall uses meal-service periods (within
 *                         verified building hours when both exist); anything else uses building hours.
 *   basis "illustrative": no verified schedule for that date, so the demo hours in campus data.
 *   basis "unknown":      neither. segs is null and the place is never called a confirmed fit.
 * `fallback` says why verified hours weren't used. Weekly hours alone never count as verified:
 * daySchedule() also requires status "verified" and an effective date range covering req.date.
 */
export function planningHours(place, req, hours) {
  const loc = hours?.locations?.[place.facility_id];
  const date = req.date ?? null;
  let fallback = null;
  if (loc && date) {
    const eat = req.activity === "eat";
    const building = daySchedule(loc, date, "building");
    const service = eat ? daySchedule(loc, date, "service") : { status: "not_applicable" };
    // Carry verified overnight building hours into the next day's plan. An explicit
    // special schedule controls the whole date, just as it does in openStatus().
    const previousBuilding = daySchedule(loc, addDays(date, -1), "building");
    const carry = !building.special && isDecided(previousBuilding)
      ? previousBuilding.periods.filter((p) => toMin(p.end) <= toMin(p.start) && toMin(p.end) > 0)
        .map((p) => ({ ...p, start: "00:00" }))
      : [];
    const buildingPeriods = [...carry, ...building.periods];
    const buildingSegs = building.status === "scheduled" ? periodSegs(buildingPeriods) : [];
    if (eat && isDecided(service)) {
      let segs = service.status === "scheduled" ? periodSegs(service.periods) : [];
      if (isDecided(building)) segs = intersectSegs(segs, buildingSegs);
      return { basis: "verified", kind: "service", date, segs, periods: service.periods, note: service.note ?? building.note ?? null };
    }
    if (isDecided(building)) {
      return {
        basis: "verified", kind: "building", date, segs: buildingSegs, periods: buildingPeriods, note: building.note ?? null,
        serviceNote: eat && service.status !== "not_applicable" ? "Meal-service hours aren't verified for this date" : null,
      };
    }
    fallback = building.assumed || service.assumed ? `${dateLabel(date)} is outside the published BU schedule`
      : building.status === "unpublished" ? `BU hours not published for ${dateLabel(date)}`
      : building.status === "unverified" ? "BU hours unverified" : "No BU hours for this place";
  } else if (!date) fallback = "No planning date, so verified hours weren't checked";
  else fallback = "No BU hours for this place";
  if (!place.hours) return { basis: "unknown", segs: null, date, fallback };
  return { basis: place.hours_basis === "verified" ? "verified" : "illustrative", kind: "demo", date, segs: openSegments(place), fallback };
}

const segsText = (segs) => segs.map(([a, b]) => `${fmtShort(a)}–${fmtShort(b)}`).join(", ");

/** Where an option's open/closed decision came from, in one line students can read. */
export function hoursBasisText(h) {
  if (h.basis === "unknown") return `Hours unknown · check before going${h.fallback ? ` (${h.fallback})` : ""}`;
  if (h.kind === "demo") return `Open ${segsText(h.segs)} · illustrative demo hours, not official${h.fallback ? ` (${h.fallback})` : ""}`;
  const what = h.kind === "service" ? "Meal service" : "Building hours";
  const when = h.segs.length
    ? h.periods.map((p) => `${h.kind === "service" ? `${p.label} ` : ""}${formatPeriod(p)}`).join(", ")
    : "closed";
  return `${what} ${dateLabel(h.date)}: ${when} · verified BU hours${h.note ? ` (${h.note})` : ""}${h.serviceNote ? `. ${h.serviceNote}` : ""}`;
}

// ---------- busyness ----------
/** Busyness at the selected demo minute: the latest observation at or before it, or unknown. */
export function busynessAt(place, histories, minute) {
  const hist = histories[place.facility_id];
  const o = hist ? latestAt(hist.observations, minute, hist.coverage_end, hist.max_hold_minutes) : null; // a value covers its slot only
  const period = periodAt(hist?.simulation, minute);
  if (!o) return { level: "unknown", count: null, capacity: null, observedAt: null, period };
  return { level: o.busyness, count: o.occupancy_count, capacity: hist.capacity, observedAt: o.observed_at.slice(11, 16), period };
}

/**
 * Simulated busyness over [from, to) minutes, minute by minute, with the same rule as
 * busynessAt (latest observation, coverage end, max hold). Minutes without a value are
 * "unknown": never zero, never quiet. `segments` keeps every change of level in order.
 * `score` is the time-weighted mean of LEVEL_RANK (unknown ranks between moderate and busy,
 * as everywhere else), rounded so ties are exact.
 */
export function visitProfile(place, histories, from, to) {
  const hist = histories[place.facility_id];
  const byLevel = { quiet: 0, moderate: 0, busy: 0, unknown: 0 };
  const segments = [];
  let peak = null;
  for (let m = from; m < to; m++) {
    const o = hist ? latestAt(hist.observations, m, hist.coverage_end, hist.max_hold_minutes) : null;
    const lvl = o && o.busyness in byLevel && o.busyness !== "unknown" ? o.busyness : "unknown";
    byLevel[lvl]++;
    if (lvl !== "unknown" && o.occupancy_count != null && (peak == null || o.occupancy_count > peak)) peak = o.occupancy_count;
    const last = segments[segments.length - 1];
    if (last && last.level === lvl) last.end = m + 1; else segments.push({ start: m, end: m + 1, level: lvl });
  }
  const minutes = to - from;
  const weighted = Object.entries(byLevel).reduce((s, [l, n]) => s + LEVEL_RANK[l] * n, 0);
  return {
    start: from, end: to, minutes, byLevel, segments, peakCount: peak, capacity: hist?.capacity ?? null,
    known: minutes - byLevel.unknown, changes: segments.length > 1,
    score: minutes > 0 ? Math.round((weighted / minutes) * 1000) / 1000 : LEVEL_RANK.unknown,
  };
}

/** Is there any busyness evidence to rank on? Visit profile when it exists, else the start-time snapshot. */
export const hasBusyData = (o) => (o.visit ? o.visit.known > 0 : o.busy.level !== "unknown");

// ---------- one place ----------
function evaluate(place, req, campus, histories, hoursData) {
  const out = (code, reason, extra = {}) => ({ status: "excluded", place, code, reason, ...extra });
  if (place.data_mode !== "synthetic" && place.data_mode !== "live") {
    return out("not_campus", "Historical data demo, not a campus destination");
  }
  if (!place.activities.includes(req.activity)) return out("activity", "Doesn't support this activity");
  for (const need of req.needs) {
    if (place.amenities[need] !== true) {
      const label = campus.amenity_labels[need];
      return out("amenity", place.amenities[need] === false
        ? `No ${label.toLowerCase()} in sample metadata` : `${label} not listed in sample metadata`);
    }
  }
  const access = place.metadata?.access;
  const eligibility = access ? req.access?.[access.group] : "yes";
  if (eligibility === "no") return out("access", "You do not meet the listed access requirements");
  const { preparation, cleanup } = allowances(req);
  const overhead = preparation + cleanup;
  const known = hasStart(req);
  const there = known ? travelMinutes(campus, req.from, place.location_id) : null;
  if (known && there == null) return out("route", `No sample walking time from ${locationName(campus, req.from)}`);
  const onward = req.to == null ? 0 : travelMinutes(campus, place.location_id, req.to);
  if (onward == null) return out("route", `No sample walking time to ${locationName(campus, req.to)}`);

  const start = toMin(req.start);
  const end = start + req.minutes;            // the next commitment
  const arriveEarliest = start + (there ?? 0); // unknown start: an upper bound only
  const leaveLatest = end - req.buffer - onward;
  const room = leaveLatest - arriveEarliest - overhead;  // travel and buffer are subtracted once, here
  if (room < req.minActivity) {
    const walk = (there ?? 0) + onward;
    const spent = `${walk ? `${walk} min of walking and ` : ""}your ${req.buffer}-min buffer + ${preparation} min preparation + ${cleanup} min cleanup`
      + (known ? "" : ", before the walk there");
    return out("time", room > 0 ? `Only ${room} min left after ${spent}` : `No time left after ${spent}`,
      { short: req.minActivity - room, room: Math.max(room, 0) });
  }

  const hours = planningHours(place, req, hoursData);
  const segs = hours.segs;
  let visit = [arriveEarliest, leaveLatest];
  if (segs) {
    visit = segs.map(([a, b]) => [Math.max(a, arriveEarliest), Math.min(b, leaveLatest)])
      .find(([a, b]) => b - a >= req.minActivity + overhead);
    if (!visit) return out("closed", closedReason(hours, arriveEarliest, leaveLatest), { hours });
  }

  const [visitStart, visitEnd] = visit;
  const actStart = visitStart + preparation;
  const actEnd = visitEnd - cleanup;
  if (!known) {
    // Nothing about the trip is claimed: no leave/arrive times, no visit-time busyness, and
    // `activity` is the most it could be before subtracting a walk we can't measure.
    return {
      status: segs ? "unchecked" : "check_hours", place, there: null, onward, activity: actEnd - actStart,
      upTo: true, opensAt: visitStart > start ? visitStart : null, windowEnd: end, busy: busynessAt(place, histories, start),
      visit: null, hours,
    };
  }
  const depart = visitStart - there;   // leave now, or later if the place opens later
  const free = depart - start;
  const activity = actEnd - actStart;
  const spare = leaveLatest - visitEnd; // unused because the place closes early
  const budget = [
    free > 0 && { kind: "free", minutes: free },
    { kind: "there", minutes: there },
    preparation > 0 && { kind: "preparation", minutes: preparation },
    { kind: "activity", minutes: activity },
    cleanup > 0 && { kind: "cleanup", minutes: cleanup },
    spare > 0 && { kind: "spare", minutes: spare, until: visitEnd },
    req.to != null && { kind: "onward", minutes: onward },
    { kind: "buffer", minutes: req.buffer },
  ].filter(Boolean);

  return {
    status: !segs ? "check_hours" : eligibility !== "yes" ? "check_access" : "fit", place, there, onward, free, activity, spare, budget,
    depart, arrive: visitStart, preparation, cleanup, activityStart: actStart, activityEnd: actEnd,
    leaveBy: visitEnd, arriveNext: req.to == null ? null : visitEnd + onward,
    bufferStart: end - req.buffer, bufferEnd: end,
    windowStart: start, windowEnd: end, busy: busynessAt(place, histories, start),
    // Profiled over the planned activity itself (after preparation, before cleanup).
    visit: visitProfile(place, histories, actStart, actEnd), hours,
  };
}

function closedReason(h, from, to) {
  const overlaps = h.segs.some(([a, b]) => a < to && b > from);
  const why = !h.segs.length ? "Closed that day"
    : overlaps ? `Not open long enough during your window` : "Closed then";
  const basis = h.kind === "demo" ? `illustrative hours ${segsText(h.segs)}`
    : `verified BU ${h.kind === "service" ? "meal-service" : "building"} hours for ${dateLabel(h.date)}${h.segs.length ? `: ${segsText(h.segs)}` : ""}${h.note ? `; ${h.note}` : ""}`;
  return `${why} (${basis})`;
}

// ---------- ranking ----------
// Lexicographic, smaller first. Primary key(s) follow the student's preference;
// then busyness level, total sample walking, more activity time, study amenities
// listed, and finally name and id so ties are always broken the same way.
// Busyness is compared by level, not exact %, because capacities are illustrative.
// With a known start, "busy" is the simulated profile over the planned visit (time-weighted
// level rank); without one, it falls back to the start-time snapshot and claims nothing more.
export function rankKeys(o, req) {
  const k = {
    busy: o.visit ? o.visit.score : LEVEL_RANK[o.busy.level],
    travel: o.there == null ? 0 : o.there + o.onward, // unknown start: walks aren't compared
    time: -o.activity,
    amenities: req.activity === "study" ? -Object.values(o.place.amenities).filter(Boolean).length : 0,
  };
  const primary = [...(req.preferQuiet ? ["busy"] : []), ...(req.preferShortTravel ? ["travel"] : [])];
  if (!primary.length) primary.push("time");
  const names = [...primary, "busy", "travel", "time", "amenities"];
  return { names, values: names.map((n) => k[n]) };
}

function compare(a, b) {
  for (let i = 0; i < a.keys.values.length; i++) {
    if (a.keys.values[i] !== b.keys.values[i]) return a.keys.values[i] - b.keys.values[i];
  }
  const by = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return by(a.place.name, b.place.name) || by(a.place.place_id, b.place.place_id);
}

const FEATURE_WHY = {
  busy: "Quieter in the simulation at the selected time",
  visit: "Quieter than the other options in the simulated data for your planned visit",
  travel: "Shorter sample walk than the other options",
  time: "More time for your activity than the other options",
  amenities: "Lists more study amenities than the other options",
};
const BEHIND_TOP = {
  busy: "Busier in the simulation at the selected time than the top option",
  visit: "Busier than the top option during the planned visit (simulated)",
  travel: "Longer walk than the top option",
  time: "Less time than the top option",
  amenities: "Fewer study amenities listed",
};
const whyKey = (name, o) => (name === "busy" && o.visit ? "visit" : name);

/** One short reason an option ranks below the top one: the first rank key that separates them. */
export function rankReason(o, top) {
  if (!o.keys || !top?.keys || o === top) return null;
  const i = o.keys.values.findIndex((v, j) => v !== top.keys.values[j]);
  if (i < 0) return "Tied with the top option; listed by name";
  const key = o.keys.names[i];
  if (key === "time") return `${top.activity - o.activity} fewer minutes of activity than the top option`;
  if (key === "travel") return `${o.there + o.onward - top.there - top.onward} more minutes walking than the top option`;
  return BEHIND_TOP[whyKey(key, o)];
}

/** "Best match" only when evidence (not the alphabetical tie-break) separates #1 from #2. */
function feature(fits) {
  if (fits.length === 1) return { kind: "only", why: "The only place that fits" };
  if (fits.length < 2 || !hasBusyData(fits[0])) return null;
  const [a, b] = fits;
  const i = a.keys.values.findIndex((v, j) => v !== b.keys.values[j]);
  if (i < 0) return null;
  const key = a.keys.names[i];
  const why = key === "time" ? `${a.activity - b.activity} more minutes of activity than the next option`
    : key === "travel" ? `${b.there + b.onward - a.there - a.onward} minutes less walking than the next option` : FEATURE_WHY[whyKey(key, a)];
  return { kind: "best", why };
}

// ---------- the whole request ----------
// `hours` is web/data/hours.json (the same file in static and API mode). Without it, or without
// req.date, every place uses its illustrative demo hours, exactly as before.
export function recommend(req0, campus, histories, { suggest = true, hours = null } = {}) {
  const req = normalizeRequest(req0);
  const errors = validateRequest(req, campus);
  if (errors.length) return { ok: false, errors };

  const evaluated = campus.places.map((p) => evaluate(p, req, campus, histories, hours));
  const ranked = (status) => evaluated.filter((o) => o.status === status)
    .map((o) => ({ ...o, keys: rankKeys(o, req) })).sort(compare);
  const fits = ranked("fit");
  const browse = ranked("unchecked");  // only when the starting point is unknown
  const checkHours = ranked("check_hours");
  const excluded = evaluated.filter((o) => o.status === "excluded" && o.code !== "activity")
    .sort((a, b) => (a.place.name < b.place.name ? -1 : a.place.name > b.place.name ? 1 : 0));
  const start = toMin(req.start);

  const travelKnown = hasStart(req);
  const result = {
    ok: true, request: req, travelKnown,
    window: { start, end: start + req.minutes, minutes: req.minutes },
    options: fits.slice(0, MAX_SHOWN), more: fits.slice(MAX_SHOWN), browse, checkHours, checkAccess: ranked("check_access"), excluded,
    featured: feature(fits), reasons: [], suggestions: [],
  };
  if (!fits.length && !browse.length && suggest) {
    result.reasons = summarize(excluded);
    // "N options would fit" needs a known walk, so no fixes are offered without a start.
    if (travelKnown) result.suggestions = suggestions(req, campus, histories, excluded, hours);
  }
  return result;
}

const REASON_TEXT = {
  access: "access requirements not met",
  time: "not enough time once walking, preparation, cleanup and buffer are counted",
  closed: "closed during the visit",
  route: "no sample walking time for the route",
  amenity: "missing a study need you picked",
  not_campus: "not a campus destination",
};

function summarize(excluded) {
  const counts = new Map();
  for (const e of excluded) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  return Object.keys(REASON_TEXT).filter((c) => counts.has(c))
    .map((code) => ({ code, count: counts.get(code), text: REASON_TEXT[code] }));
}

/** Concrete changes that the engine itself confirms would produce a fit. */
function suggestions(req, campus, histories, excluded, hours) {
  const out = [];
  const fitsWith = (patch) => {
    const r = recommend({ ...req, ...patch }, campus, histories, { suggest: false, hours });
    return r.ok ? r.options.length + r.more.length : 0;
  };
  const plural = (n) => `${n} option${n === 1 ? "" : "s"} would fit`;
  const act = activityInfo(campus, req.activity);

  const tight = excluded.filter((e) => e.code === "time");
  for (const extra of [...new Set(tight.map((e) => e.short))].sort((a, b) => a - b)) {
    const minutes = req.minutes + extra;
    // In "until" mode the window is set by the next commitment, so the fix moves that time.
    const end = toMin(req.start) + minutes;
    if (req.mode === "until" && end >= DAY_END) break;
    const patch = req.mode === "until" ? { until: toHHMM(end) } : { minutes };
    const n = fitsWith(patch);
    if (n) {
      out.push({ label: req.mode === "until" ? `Free until ${fmtTime(end)} (${minutes} min)` : `Extend to ${minutes} minutes`, detail: plural(n), patch });
      break;
    }
  }
  const room = Math.max(0, ...tight.map((e) => e.room));
  if (room >= SHORTEN_FLOOR) {
    const n = fitsWith({ minActivity: room });
    if (n) out.push({ label: `Plan a ${room}-minute ${act.noun}`, detail: plural(n), patch: { minActivity: room } });
  }
  if (req.needs.length) {
    const n = fitsWith({ needs: [] });
    const names = req.needs.map((k) => campus.amenity_labels[k].toLowerCase()).join(" or ");
    if (n) out.push({ label: `Don't require ${names}`, detail: plural(n), patch: { needs: [] } });
  }
  for (const a of campus.activities) {
    if (a.id === req.activity) continue;
    const patch = { ...ALLOWANCES[a.id], activity: a.id, minActivity: a.default_min, needs: a.id === "study" ? req.needs : [] };
    const n = fitsWith(patch);
    if (n) out.push({ label: `${a.label} instead`, detail: `${plural(n)} (${a.default_min}-minute minimum)`, patch });
  }
  return out;
}

// ---------- wording (kept here so tests cover what students read) ----------
const LEVEL_LOWER = { quiet: "quiet", moderate: "moderate", busy: "busy", unknown: "no simulated data" };
const span = (a, b) => `${fmtTime(a)}–${fmtTime(b)}`;

/**
 * The simulated profile during the planned visit, worded without claiming more than the data:
 * the visit interval is an estimate from sample walks, the counts are simulated, and minutes
 * the history doesn't cover are reported as no data. null when no visit was estimated.
 */
export function visitText(o) {
  const v = o.visit;
  if (!v) return null;
  const demo = o.place.data_mode === "synthetic";
  // Every change is kept, in order (quiet -> busy -> quiet is not "quiet, then busy").
  const order = v.segments.map((s) => s.level);
  const most = Object.entries(v.byLevel).filter(([l]) => l !== "unknown").sort((x, y) => y[1] - x[1])[0][0];
  let label;
  if (!v.known) label = "No simulated data for your visit";
  else if (!v.changes) label = `${LEVEL_WORD[v.segments[0].level]} for your whole visit`;
  else if (order.length <= 3) label = `${order.map((l) => LEVEL_LOWER[l]).join(", then ").replace(/^./, (c) => c.toUpperCase())} during your visit`;
  else label = `Changes ${order.length - 1} times during your visit, mostly ${LEVEL_LOWER[most]}`;
  const parts = ["quiet", "moderate", "busy", "unknown"].filter((l) => v.byLevel[l])
    .map((l) => `${v.byLevel[l]} min ${l === "unknown" ? "with no simulated data (not counted as quiet)" : l}`);
  const timeline = v.changes ? ` Order: ${v.segments.map((s) => `${LEVEL_LOWER[s.level]} ${span(s.start, s.end)}`).join("; ")}.` : "";
  return {
    label: `${label}${demo ? " (simulated)" : ""}`,
    basis: `Estimated visit ${span(v.start, v.end)}, from the sample walk: ${parts.join(", ")}.${timeline}`
      + (v.peakCount != null ? ` Highest ${demo ? "simulated " : ""}count ${v.peakCount.toLocaleString("en-US")}${v.capacity ? ` of ${v.capacity.toLocaleString("en-US")}${demo ? " (illustrative capacity)" : ""}` : ""}.` : "")
      + ` ${demo ? "Simulated BU-named data, " : ""}not live occupancy or a forecast.`,
  };
}

export function busynessText(o, req) {
  const at = fmtTime(toMin(req.start));
  const b = o.busy;
  if (b.level === "unknown") {
    const why = b.period?.basis === "unavailable" ? ` ${b.period.label}.` : "";
    return { label: "No busyness data", basis: `No count at ${at}, so this option is ranked with less occupancy information.${why}` };
  }
  const demo = o.place.data_mode === "synthetic";
  return {
    label: `${LEVEL_WORD[b.level]} at ${at}`,
    basis: `${demo ? "Simulated count" : "Count"} ${b.count.toLocaleString("en-US")} of ${b.capacity?.toLocaleString("en-US") ?? "?"}`
      + `${demo ? " (illustrative capacity)" : ""} at ${at}${b.period ? ` (${b.period.label})` : ""}. Not a forecast for when you arrive.`,
  };
}

export function budgetSentence(o, req, campus) {
  const act = activityInfo(campus, req.activity);
  if (o.upTo) {
    return `Up to ${o.activity} min for a ${act.noun} before the walk there. Travel not checked: choose a starting point.`;
  }
  const text = {
    free: (m) => `${m} min free first`,
    there: (m) => (m ? `${m} min there` : "0 min there (same place)"),
    preparation: (m) => `${m} min preparation (allowance)`,
    cleanup: (m) => `${m} min cleanup (allowance)`,
    activity: (m) => `${m}-minute ${act.noun}`,
    spare: (m, b) => `${m} min unused (closes ${fmtShort(b.until)})`,
    onward: (m) => `${m} min onward`,
    buffer: (m) => `${m}-minute buffer`,
  };
  return `Fits your ${req.minutes}-minute window: ${o.budget.map((b) => text[b.kind](b.minutes, b)).join(" + ")}.`;
}

export function whyItFits(o, req, campus, featured) {
  const act = activityInfo(campus, req.activity);
  const reasons = [];
  if (featured) reasons.push(`${featured.why}.`);
  if (o.busy.level !== "unknown") reasons.push(`${busynessText(o, req).label} (when you leave, simulated).`);
  const visit = visitText(o);
  if (visit) reasons.push(`${visit.label}: ${span(o.visit.start, o.visit.end)}.`);
  const extra = o.activity - req.minActivity;
  reasons.push(`${o.activity} min to ${act.verb}${extra ? `, ${extra} more than your minimum` : ", exactly your minimum"}.`);
  const there = o.there ? `${o.there}-min sample walk there` : "No walk there";
  const onward = req.to == null ? "onward travel not counted (no next stop)"
    : o.onward ? `${o.onward} min on to ${locationName(campus, req.to)}` : `already at ${locationName(campus, req.to)}`;
  reasons.push(`${there}; ${onward}.`);
  if (o.free) reasons.push(`Opens at ${fmtShort(o.arrive)}, so leave at ${fmtTime(o.depart)}.`);
  for (const n of req.needs) reasons.push(`Lists ${campus.amenity_labels[n].toLowerCase()} (sample metadata).`);
  if (o.hours && o.hours.basis !== "unknown") {
    reasons.push(o.hours.kind === "demo"
      ? "Open check uses illustrative demo hours, not official BU hours."
      : `Open check uses verified BU ${o.hours.kind === "service" ? "meal-service" : "building"} hours for ${dateLabel(o.hours.date)}.`);
  }
  return reasons;
}

export function hoursStatus(place) {
  if (!place.hours) return { known: false, text: "Hours unknown · check before going" };
  return {
    known: true,
    text: `Open ${hoursText(place)} · ${place.hours_basis === "verified" ? "verified hours" : "illustrative demo hours"}`,
  };
}
