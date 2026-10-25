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
//
// Fit rule: minutes >= travel there + preparation + activity (>= minActivity)
// + cleanup + onward + buffer. Preparation/cleanup are editable allowances.
// and the place is open (illustrative hours) for the whole activity. Unknown hours are never "confirmed": they go to checkHours.
// Without a starting point the same rule runs with the walk there left out, so
// it can only rule places out (too little time even before walking, closed).

import { fmtShort, fmtTime, latestAt, toMin } from "./clock.js";

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

export function validateRequest(req, campus) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const isLocation = (id) => campus.locations.some((l) => l.id === id);

  if (!campus.activities.some((a) => a.id === req.activity)) add("activity", "Choose an activity.");
  const startOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.start ?? "");
  if (!startOk) add("start", "Enter a start time.");
  if (!int(req.minutes, 5, 720)) add("minutes", "Free time should be 5 to 720 minutes.");
  else if (startOk && toMin(req.start) + req.minutes > DAY_END) add("minutes", "This window runs past midnight. The demo covers one day.");
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

/** Busyness at the selected demo minute: the latest observation at or before it, or unknown. */
export function busynessAt(place, histories, minute) {
  const hist = histories[place.facility_id];
  const o = hist ? latestAt(hist.observations, minute, hist.coverage_end, hist.max_hold_minutes) : null; // a value covers its slot only
  const period = periodAt(hist?.simulation, minute);
  if (!o) return { level: "unknown", count: null, capacity: null, observedAt: null, period };
  return { level: o.busyness, count: o.occupancy_count, capacity: hist.capacity, observedAt: o.observed_at.slice(11, 16), period };
}

// ---------- one place ----------
function evaluate(place, req, campus, histories) {
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

  const segs = openSegments(place);
  let visit = [arriveEarliest, leaveLatest];
  if (segs) {
    visit = segs.map(([a, b]) => [Math.max(a, arriveEarliest), Math.min(b, leaveLatest)])
      .find(([a, b]) => b - a >= req.minActivity + overhead);
    if (!visit) return out("closed", closedReason(place, segs, arriveEarliest, leaveLatest));
  }

  const [visitStart, visitEnd] = visit;
  const actStart = visitStart + preparation;
  const actEnd = visitEnd - cleanup;
  if (!known) {
    // Nothing about the trip is claimed: no leave/arrive times, and `activity` is
    // the most it could be before subtracting a walk we can't measure.
    return {
      status: segs ? "unchecked" : "check_hours", place, there: null, onward, activity: actEnd - actStart,
      upTo: true, opensAt: visitStart > start ? visitStart : null, windowEnd: end, busy: busynessAt(place, histories, start),
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
  };
}

function closedReason(place, segs, from, to) {
  const overlaps = segs.some(([a, b]) => a < to && b > from);
  return `${overlaps ? "Not open long enough during your window" : "Closed then"} (illustrative hours ${hoursText(place)})`;
}

// ---------- ranking ----------
// Lexicographic, smaller first. Primary key(s) follow the student's preference;
// then busyness level, total sample walking, more activity time, study amenities
// listed, and finally name and id so ties are always broken the same way.
// Busyness is compared by level, not exact %, because capacities are illustrative.
export function rankKeys(o, req) {
  const k = {
    busy: LEVEL_RANK[o.busy.level],
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
  travel: "Shorter sample walk than the other options",
  time: "More time for your activity than the other options",
  amenities: "Lists more study amenities than the other options",
};
const BEHIND_TOP = {
  busy: "Busier in the simulation at the selected time than the top option",
  travel: "Longer walk than the top option",
  time: "Less time than the top option",
  amenities: "Fewer study amenities listed",
};

/** One short reason an option ranks below the top one: the first rank key that separates them. */
export function rankReason(o, top) {
  if (!o.keys || !top?.keys || o === top) return null;
  const i = o.keys.values.findIndex((v, j) => v !== top.keys.values[j]);
  if (i < 0) return "Tied with the top option; listed by name";
  const key = o.keys.names[i];
  if (key === "time") return `${top.activity - o.activity} fewer minutes of activity than the top option`;
  if (key === "travel") return `${o.there + o.onward - top.there - top.onward} more minutes walking than the top option`;
  return BEHIND_TOP[key];
}

/** "Best match" only when evidence (not the alphabetical tie-break) separates #1 from #2. */
function feature(fits) {
  if (fits.length === 1) return { kind: "only", why: "The only place that fits" };
  if (fits.length < 2 || fits[0].busy.level === "unknown") return null;
  const [a, b] = fits;
  const i = a.keys.values.findIndex((v, j) => v !== b.keys.values[j]);
  if (i < 0) return null;
  const key = a.keys.names[i];
  const why = key === "time" ? `${a.activity - b.activity} more minutes of activity than the next option`
    : key === "travel" ? `${b.there + b.onward - a.there - a.onward} minutes less walking than the next option` : FEATURE_WHY[key];
  return { kind: "best", why };
}

// ---------- the whole request ----------
export function recommend(req, campus, histories, { suggest = true } = {}) {
  const errors = validateRequest(req, campus);
  if (errors.length) return { ok: false, errors };

  const evaluated = campus.places.map((p) => evaluate(p, req, campus, histories));
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
    if (travelKnown) result.suggestions = suggestions(req, campus, histories, excluded);
  }
  return result;
}

const REASON_TEXT = {
  access: "access requirements not met",
  time: "not enough time once walking, preparation, cleanup and buffer are counted",
  closed: "closed during the visit (illustrative hours)",
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
function suggestions(req, campus, histories, excluded) {
  const out = [];
  const fitsWith = (patch) => {
    const r = recommend({ ...req, ...patch }, campus, histories, { suggest: false });
    return r.ok ? r.options.length + r.more.length : 0;
  };
  const plural = (n) => `${n} option${n === 1 ? "" : "s"} would fit`;
  const act = activityInfo(campus, req.activity);

  const tight = excluded.filter((e) => e.code === "time");
  for (const extra of [...new Set(tight.map((e) => e.short))].sort((a, b) => a - b)) {
    const n = fitsWith({ minutes: req.minutes + extra });
    if (n) { out.push({ label: `Extend to ${req.minutes + extra} minutes`, detail: plural(n), patch: { minutes: req.minutes + extra } }); break; }
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
  if (o.busy.level !== "unknown") reasons.push(`${busynessText(o, req).label}.`);
  const extra = o.activity - req.minActivity;
  reasons.push(`${o.activity} min to ${act.verb}${extra ? `, ${extra} more than your minimum` : ", exactly your minimum"}.`);
  const there = o.there ? `${o.there}-min sample walk there` : "No walk there";
  const onward = req.to == null ? "onward travel not counted (no next stop)"
    : o.onward ? `${o.onward} min on to ${locationName(campus, req.to)}` : `already at ${locationName(campus, req.to)}`;
  reasons.push(`${there}; ${onward}.`);
  if (o.free) reasons.push(`Opens at ${fmtShort(o.arrive)}, so leave at ${fmtTime(o.depart)}.`);
  for (const n of req.needs) reasons.push(`Lists ${campus.amenity_labels[n].toLowerCase()} (sample metadata).`);
  return reasons;
}

export function hoursStatus(place) {
  if (!place.hours) return { known: false, text: "Hours unknown · check before going" };
  return {
    known: true,
    text: `Open ${hoursText(place)} · ${place.hours_basis === "verified" ? "verified hours" : "illustrative demo hours"}`,
  };
}
