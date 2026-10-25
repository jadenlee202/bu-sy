// Browser-local persistence. One device, one browser profile: nothing here is shared or uploaded.
import { merge, restore } from "./session.js";

export const KEY = "busy.manualPilot.session";
export const PREVIOUS_KEY = "busy.manualPilot.previous";
export const UNREADABLE_KEY = "busy.manualPilot.unreadable";

/** localStorage when it works (it can throw in private mode or when blocked), else memory only. */
export function browserStorage() {
  try {
    const probe = "busy.manualPilot.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return { storage: localStorage, persistent: true };
  } catch {
    const mem = new Map();
    return {
      persistent: false,
      storage: {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      },
    };
  }
}

function read(storage, key) {
  const raw = storage.getItem(key);
  if (raw == null) return { session: null };
  try {
    const r = restore(JSON.parse(raw));
    return r.ok ? { session: r.session } : { session: null, error: r.error, raw };
  } catch {
    return { session: null, error: "Saved data could not be read.", raw };
  }
}

export function makeStore(storage) {
  return {
    /** Unreadable data is copied aside, never silently discarded. */
    load() {
      const r = read(storage, KEY);
      if (r.error) storage.setItem(UNREADABLE_KEY, r.raw);
      return r;
    },
    /** Merge with whatever another tab saved for the same session, write, and return the result. */
    save(session) {
      const { session: stored } = read(storage, KEY);
      const merged = stored ? merge(session, stored) : session;
      storage.setItem(KEY, JSON.stringify(merged));
      return merged;
    },
    /** Reset: keep one copy of the old session, then clear the current one. */
    archive(session) {
      storage.setItem(PREVIOUS_KEY, JSON.stringify(session));
      storage.removeItem(KEY);
    },
    previous: () => read(storage, PREVIOUS_KEY).session,
  };
}
