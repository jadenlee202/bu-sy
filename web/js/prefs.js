/**
 * prefs.js — User preference store for BU-sy.
 *
 * All state lives in one localStorage key: "busy.prefs.v1"
 * (a JSON object). The store helper from source.js is replicated
 * here so this module is self-contained and can be imported without
 * pulling in the full data layer.
 *
 * No calendar data, no location data, no server round-trips.
 * Falls back to in-memory defaults gracefully when storage is blocked.
 */

// ---------- defaults ----------
export const DEFAULTS = {
  // Interest toggles (affects which recommendation categories are surfaced)
  interests: {
    fitness: true,    // FitRec / weight rooms / courts
    dining:  true,    // Dining halls
    library: true,    // Mugar and other study spaces
  },

  // Minimum activity duration the user cares about (minutes)
  minDuration: 30,

  // Travel preferences
  travelBuffer: 10,         // minutes of buffer before an activity (walk + settle)
  maxTravelMin: 20,         // upper bound on travel time to suggest (minutes)

  // Trade-off: "quiet" = prefer the quietest place, "near" = prefer shorter travel
  tradeoff: "quiet",        // "quiet" | "near"

  // Notification demo preferences (no real push notifications)
  notifications: {
    enabled:    false,       // master toggle; off by default
    windowStart: "08:00",   // earliest time for demo reminders
    windowEnd:   "22:00",   // latest time for demo reminders
    dailyLimit:  3,          // max demo notifications shown per session
    snoozeMins:  30,         // minutes to suppress after Snooze
  },
};

// ---------- storage helper (mirrors source.js store, no import needed) ----------
const _mem = {};
const _store = {
  get(key) {
    try { return localStorage.getItem(key); }
    catch { return _mem[key] ?? null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); }
    catch { _mem[key] = value; }
  },
};

const KEY = "busy.prefs.v1";

// ---------- load / save ----------

/** Returns a deep copy of the stored prefs, merged over DEFAULTS. */
export function loadPrefs() {
  const raw = _store.get(KEY);
  if (!raw) return deepClone(DEFAULTS);
  try {
    const parsed = JSON.parse(raw);
    return merge(deepClone(DEFAULTS), parsed);
  } catch {
    return deepClone(DEFAULTS);
  }
}

/** Persists the given prefs object. */
export function savePrefs(prefs) {
  _store.set(KEY, JSON.stringify(prefs));
}

/** Resets preferences to DEFAULTS and persists. */
export function resetPrefs() {
  const fresh = deepClone(DEFAULTS);
  savePrefs(fresh);
  return fresh;
}

// ---------- notification session state ----------
// These are intentionally NOT persisted (session only).
let _notifShownToday = 0;
let _snoozeUntil = null;   // Date

export function notifSessionState() {
  return { shown: _notifShownToday, snoozeUntil: _snoozeUntil };
}

/**
 * Returns true if a notification demo is allowed right now given
 * the user's preferences.
 *
 * @param {object} prefs - current prefs object
 * @param {Date} [now] - injectable for tests
 */
export function canShowNotif(prefs, now = new Date()) {
  const n = prefs.notifications;
  if (!n.enabled) return false;
  if (_notifShownToday >= n.dailyLimit) return false;
  if (_snoozeUntil && now < _snoozeUntil) return false;

  // Check time window
  const hhmm = now.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
  if (hhmm < n.windowStart || hhmm >= n.windowEnd) return false;

  return true;
}

export function recordNotifShown() {
  _notifShownToday += 1;
}

export function applySnooze(prefs, now = new Date()) {
  const mins = prefs.notifications.snoozeMins;
  _snoozeUntil = new Date(now.getTime() + mins * 60_000);
}

// ---------- helpers ----------
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Shallow-merge top-level + one level deep (objects). */
function merge(base, override) {
  for (const [k, v] of Object.entries(override)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      base[k] = { ...base[k], ...v };
    } else if (k in base) {
      base[k] = v;
    }
  }
  return base;
}
