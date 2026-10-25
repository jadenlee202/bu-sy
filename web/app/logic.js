// Pure helpers for the minimal prototype: no DOM, no storage, so Node can test them.
// What fits is never decided here; the shared engine (../js/recommend.js) does that.

export const PRESETS = [30, 45, 60, 90, 120];
export const MAX_MINUTES = 720;              // the engine's upper limit
const MINUTE = 60_000;

/** The current minute rounded up to the next 5, so "now" plans don't start in the past. */
export const roundUp5 = (minute) => Math.min(24 * 60 - 1, Math.ceil(minute / 5) * 5);

/** "90 min" / "2 hr" / "1 hr 45 min" */
export function durationText(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** The usable free segment (from availability.daySegments) that contains `now`, or null. */
export function freeNow(segments, now) {
  return segments.find((s) => s.kind === "available" && s.start <= now && now < s.end) ?? null;
}

/** Usable free segments that start after `now`, in order. */
export const laterFree = (segments, now) => segments.filter((s) => s.kind === "available" && s.start > now);

/** Whole minutes from `from` to `to` (epoch ms), capped at the engine's limit. */
export const minutesBetween = (from, to) => Math.min(MAX_MINUTES, Math.floor((to - from) / MINUTE));

/** The next event starting at or after `t`, from a list of { start, end, title }. */
export function nextEvent(events, t) {
  return events.filter((e) => !e.allDay && e.start >= t).sort((a, b) => a.start - b.start)[0] ?? null;
}

/**
 * Busyness over the planned visit in plain words: one level ("quiet") or the order it
 * changes in ("quiet, then busy"). Falls back to the departure-time snapshot.
 */
export function visitWords(o) {
  const levels = o.visit?.segments?.map((s) => s.level) ?? [o.busy?.level ?? "unknown"];
  const ordered = levels.filter((l, i) => l !== levels[i - 1]);
  if (ordered.every((l) => l === "unknown")) return { level: "unknown", text: "no busyness data" };
  const known = ordered.filter((l) => l !== "unknown");
  return { level: known[0], text: known.length === 1 ? known[0] : known.join(", then "), peak: peakLevel(known) };
}

// ---------- busyness icon: three ascending bars, filled by level ----------
export const BARS = { quiet: 1, moderate: 2, busy: 3 };
/** The busiest known level in a list (the icon shows the worst part of a visit). */
export const peakLevel = (levels) => levels.reduce((a, l) => ((BARS[l] ?? 0) > (BARS[a] ?? 0) ? l : a), "unknown");

/**
 * A minimal meter: 1 bar quiet, 2 moderate, 3 busy, none for closed or no data. Never colour alone:
 * the caller always sets the word beside it, and the label names the level for screen readers.
 */
export function busyIcon(level, label = level) {
  const n = BARS[level] ?? 0;
  const bars = [0, 1, 2].map((i) => `<rect class="${i < n ? "on" : ""}" x="${i * 7}" y="${12 - (i + 1) * 4}" width="5" height="${(i + 1) * 4}" rx="1.5" style="--i:${i}"/>`).join("");
  return `<svg class="busy-icon" data-level="${level}" viewBox="0 0 19 12" width="19" height="12" role="img" aria-label="Busyness: ${label}">${bars}</svg>`;
}

// ---------- walking time from where you are (estimated on the device) ----------
export const HERE = "here";                 // the engine's location id for "your location"
export const WALK_M_PER_MIN = 84;           // ~5 km/h, the pace Google Maps assumes for walking
export const DETOUR = 1.2;                  // city streets: the walk is ~20 % longer than the straight line

/** Great-circle distance in metres between two { lat, lon } points. */
export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Estimated walking minutes for a straight-line distance: never zero, always whole minutes. */
export const walkMinutes = (metres) => Math.max(1, Math.ceil((metres * DETOUR) / WALK_M_PER_MIN));

/**
 * The campus as the engine sees it from your location: one extra location ("Your location") with an estimated
 * walk to every building that has verified coordinates. A building without them keeps no walk (unknown, never zero).
 */
export function campusFrom(campus, here, geo) {
  const travel = Object.entries(geo).map(([id, p]) => ({ from_id: HERE, to_id: id, minutes: walkMinutes(distanceM(here, p)) }));
  return { ...campus, locations: [...campus.locations, { id: HERE, name: "Your location" }], travel: [...campus.travel, ...travel],
    travel_basis: "Estimated walk", travel_note: "Straight-line distance from your location × 1.2 at 84 m/min; open directions for the real route." };
}

/**
 * The request the shared engine evaluates: free time is walk there + the activity, nothing else.
 * No next stop, no buffer, no setup or pack-up allowance.
 */
export function buildRequest({ activity, minutes, from, access, patch = {} }, defaults, start, date) {
  return {
    ...defaults, activity, minutes, from: from || "", to: null, start, date,
    buffer: 0, preparation: 0, cleanup: 0,
    mode: "duration", source: "manual", access: { ...access }, preferQuiet: true, ...patch,
  };
}

/** Applies an engine suggestion ({ label, patch }) to the sentence state. */
export function applySuggestion(state, patch) {
  const { minutes, activity, ...rest } = patch;
  return {
    ...state,
    minutes: minutes ?? state.minutes,
    activity: activity ?? state.activity,
    patch: activity && activity !== state.activity ? { ...rest } : { ...state.patch, ...rest },
  };
}

// ---------- place pages ----------
/** Walking directions in Google Maps, only to a field-level verified address (Maps uses your location as the start). */
export function directionsURL(place) {
  const a = place?.metadata?.address;
  return a?.status === "verified" && a.text ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a.text)}&travelmode=walking` : null;
}

/**
 * One bar per hour of the sample day: height is the share of the place's reference (capacity, or its usual high),
 * level is the history's own busyness word. Hours with no recording are left out, never drawn as zero.
 */
export function dayBars(hist, fromHour = 7, toHour = 23) {
  const ref = hist?.capacity ?? hist?.busyness_reference ?? null;
  const byHour = new Map((hist?.hourly ?? []).map((h) => [h.hour, h]));
  const bars = [];
  for (let hour = fromHour; hour < toHour; hour++) {
    const h = byHour.get(hour);
    bars.push(h && Number.isFinite(h.occupancy) && ref
      ? { hour, pct: Math.max(0.03, Math.min(1, h.occupancy / ref)), level: h.busyness ?? "unknown" }
      : { hour, pct: 0, level: "none" });
  }
  return bars;
}

/** A day's building hours in words, from hours.js daySchedule() output. */
export function hoursText(day, formatPeriod) {
  if (day.status === "scheduled") return day.periods.map(formatPeriod).join(", ") + (day.assumed ? " (assumed)" : "");
  return { closed: "Closed", unpublished: "Not published yet", not_applicable: "—" }[day.status] ?? "Unverified";
}

// ---------- the day map (Schedule) ----------
/** A suggestion fills a gap with one sensible session, not the whole gap: nobody eats for three hours. */
export const SESSION_CAP = { eat: 45, workout: 75, study: 120 };
/** Minutes to plan for a gap: the walk there plus at most one session, never more than the gap. */
export const gapPlanMinutes = (gapMinutes, walk, activity) => Math.min(gapMinutes, (walk ?? 0) + (SESSION_CAP[activity] ?? gapMinutes));
export const MEALS = [
  { label: "Breakfast", from: 8 * 60, to: 10 * 60 }, { label: "Lunch", from: 11 * 60, to: 14 * 60 }, { label: "Dinner", from: 17 * 60, to: 20 * 60 },
];   // campus minutes of the day
const WALK_ALLOWANCE = 30;                             // a slot holds the session plus up to a 30-minute walk
const MIN_SLOT = { eat: 30, study: 45 };              // shorter than this isn't worth suggesting
const MAX_CLUBS = 2;

/**
 * What fits in one free gap, in campus minutes of the day, without touching anything on the calendar:
 * club meetings (`meetings`: { start, end, meeting }) that start and end inside the gap, a meal where the gap
 * overlaps breakfast, lunch or dinner, then a study block in the longest time left. Each slot has its own
 * start and end inside the gap, and no two overlap. The engine then picks a place for each meal and study slot.
 */
export function fillGap(start, end, meetings = []) {
  let free = [[start, end]];
  const take = (a, b) => { free = free.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [[x, a], [b, y]].filter(([p, q]) => q > p))); };
  const slots = [];
  for (const m of [...meetings].sort((a, b) => a.start - b.start)) {
    if (slots.length >= MAX_CLUBS) break;
    if (free.some(([x, y]) => m.start >= x && m.end <= y)) { slots.push({ kind: "club", start: m.start, end: m.end, meeting: m.meeting }); take(m.start, m.end); }
  }
  for (const meal of MEALS) {
    const piece = free.find(([x, y]) => Math.min(y, meal.to) - Math.max(x, meal.from) >= MIN_SLOT.eat);
    if (!piece) continue;
    const from = Math.max(piece[0], meal.from), to = Math.min(piece[1], from + WALK_ALLOWANCE + SESSION_CAP.eat);
    slots.push({ kind: "eat", label: meal.label, start: from, end: to }); take(from, to);
  }
  const longest = free.reduce((a, p) => (!a || p[1] - p[0] > a[1] - a[0] ? p : a), null);
  if (longest && longest[1] - longest[0] >= MIN_SLOT.study) {
    slots.push({ kind: "study", start: longest[0], end: Math.min(longest[1], longest[0] + WALK_ALLOWANCE + SESSION_CAP.study) });
  }
  return slots.sort((a, b) => a.start - b.start);
}

/**
 * The day as blocks in time order, from availability.daySegments() plus the day's events:
 * busy blocks carry the titles of the events inside them (and whether any is a club meeting),
 * free ones say whether they're long enough to plan ("free"), too short ("short") or already over ("past").
 * Heights follow the length (1 px per minute) with a floor so short blocks stay readable.
 */
export function dayBlocks(segments, events, now, { pxPerMin = 1, floor = { busy: 48, free: 132, short: 30, past: 30 } } = {}) {
  return segments.map((s) => {
    const minutes = Math.round((s.end - s.start) / 60000);
    const over = s.end <= now;
    const kind = s.kind === "busy" ? "busy" : s.kind === "available" ? "free" : s.kind === "short" ? "short" : "past";
    const inside = kind === "busy" ? events.filter((e) => !e.allDay && e.start < s.end && e.end > s.start) : [];
    return {
      kind, start: s.start, end: s.end, minutes, over: over || kind === "past",
      titles: [...new Set(inside.map((e) => e.title))], club: inside.some((e) => e.source === "club"),
      height: Math.max(floor[kind] ?? 30, Math.round(minutes * pxPerMin)),
      nowAt: now >= s.start && now < s.end ? (now - s.start) / (s.end - s.start) : null,
    };
  });
}
