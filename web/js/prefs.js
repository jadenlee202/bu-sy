// Remembered planner preferences (this browser only, same storage as the rest
// of the app). Only values the student set by hand are kept; sample scenarios
// and defaults are never written. Activity and free time are not remembered:
// they belong to one free window. The next stop isn't either, because a stale
// one would silently add an onward walk to the next plan.
//
// A remembered starting point is shown as "Last selected". It is not the
// student's current location, which BU-sy never detects.
import { ALLOWANCES } from "./recommend.js";
import { store } from "./source.js";

export const PREFS_KEY = "busy.plan.prefs.v1";

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Only well-formed values survive, so a bad or old entry can't break the form. */
function clean(raw, campus) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  if (campus.locations.some((l) => l.id === raw.from)) out.from = raw.from;
  if (isInt(raw.buffer, 0, 120)) out.buffer = raw.buffer;
  if (typeof raw.preferQuiet === "boolean") out.preferQuiet = raw.preferQuiet;
  if (typeof raw.preferShortTravel === "boolean") out.preferShortTravel = raw.preferShortTravel;
  if (Array.isArray(raw.needs)) out.needs = raw.needs.filter((n) => n in campus.amenity_labels);
  if (raw.minByActivity && typeof raw.minByActivity === "object") {
    const mins = Object.entries(raw.minByActivity)
      .filter(([id, v]) => campus.activities.some((a) => a.id === id) && isInt(v, 5, 600));
    if (mins.length) out.minByActivity = Object.fromEntries(mins);
  }
  for (const field of ["preparation", "cleanup"]) {
    const key = `${field}ByActivity`;
    if (raw[key] && typeof raw[key] === "object") out[key] = Object.fromEntries(Object.entries(raw[key])
      .filter(([id, v]) => campus.activities.some(a => a.id === id) && isInt(v, 0, 120)));
  }
  return out;
}

export function loadPrefs(campus) {
  try {
    return clean(JSON.parse(store.get(PREFS_KEY) ?? "null"), campus);
  } catch {
    return {};
  }
}

export function savePrefs(patch, campus) {
  const old = loadPrefs(campus);
  // from: "" ("Not set") isn't a location, so clean() drops it and the remembered start is cleared.
  for (const key of ["preparationByActivity", "cleanupByActivity"]) {
    if (patch[key]) patch = { ...patch, [key]: { ...old[key], ...patch[key] } };
  }
  const next = clean({ ...old, ...patch, minByActivity: { ...old.minByActivity, ...patch.minByActivity } }, campus);
  store.set(PREFS_KEY, JSON.stringify(next));
  return next;
}

export const resetPrefs = () => store.set(PREFS_KEY, "{}");

/** Visible defaults for everything optional, with remembered values on top. */
export function defaults(campus, prefs, activity) {
  const act = campus.activities.find((a) => a.id === activity);
  return {
    preparation: prefs.preparationByActivity?.[activity] ?? ALLOWANCES[activity]?.preparation ?? 0,
    cleanup: prefs.cleanupByActivity?.[activity] ?? ALLOWANCES[activity]?.cleanup ?? 0,
    access: {},
    from: prefs.from ?? "",
    to: null,
    minActivity: (activity && prefs.minByActivity?.[activity]) ?? act?.default_min ?? NaN,
    buffer: prefs.buffer ?? campus.default_buffer,
    preferQuiet: prefs.preferQuiet ?? true,
    preferShortTravel: prefs.preferShortTravel ?? false,
    needs: prefs.needs ?? [],
  };
}
