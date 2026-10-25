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
  return events.filter((e) => !e.free && !e.allDay && e.start >= t).sort((a, b) => a.start - b.start)[0] ?? null;
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

/** The request the shared engine evaluates, built from the sentence plus remembered defaults. */
export function buildRequest({ activity, minutes, from, to, access, patch = {} }, defaults, start, date) {
  return {
    ...defaults, activity, minutes, from: from || "", to: to || null, start, date,
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
