// Events the student adds on the Schedule map: their own ("Gym with Sam") or a suggestion they kept
// ("Lunch at Warren Towers Dining"). Kept apart from the imported .ics file (their own storage key), so
// replacing or clearing that file never touches them. Only a title, date and times are stored, in this
// browser; nothing here is sent to a server.
import { zonedInstant } from "./availability.js";

export const CAMPUS_TZ = "America/New_York";   // times are campus times
export const MAX_TITLE = 80;
const KEY = "busy.myEvents.v1";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const valid = (e) => typeof e?.id === "string" && typeof e.title === "string" && e.title.trim() !== ""
  && e.title.length <= MAX_TITLE && DATE.test(e.date ?? "") && HHMM.test(e.start ?? "") && HHMM.test(e.end ?? "") && e.end > e.start;
const stored = ({ id, title, date, start, end }) => ({ id, title, date, start, end });

/** Why an event can't be saved, or "" when it can. */
export function eventProblem({ title, date, start, end }) {
  if (!String(title ?? "").trim()) return "Give the event a name.";
  if (String(title).trim().length > MAX_TITLE) return `Keep the name under ${MAX_TITLE} characters.`;
  if (!DATE.test(date ?? "") || !HHMM.test(start ?? "") || !HHMM.test(end ?? "")) return "Choose a start and end time.";
  if (end <= start) return "The event has to end after it starts.";
  return "";
}

/** Saved events, valid ones only, in date order. Unreadable or blocked storage reads as none. */
export function loadMyEvents() {
  try {
    const raw = JSON.parse(globalThis.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)) : [];
  } catch {
    return [];
  }
}

/** Saves a new event. Throws with a reason when it can't be saved, so the screen never says "added" when it wasn't. */
export function addMyEvent(event, makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {
  const problem = eventProblem(event);
  if (problem) throw new Error(problem);
  const next = [...loadMyEvents(), stored({ ...event, title: event.title.trim(), id: makeId() })];
  globalThis.localStorage.setItem(KEY, JSON.stringify(next));
  return loadMyEvents();
}

/** Removes one event; nothing else. */
export function removeMyEvent(id) {
  globalThis.localStorage.setItem(KEY, JSON.stringify(loadMyEvents().filter((e) => e.id !== id)));
  return loadMyEvents();
}

/** Saved events as calendar occurrences (epoch ms), marked as added here. */
export function myEventItems(list) {
  return list.flatMap((e) => {
    try {
      return [{ start: zonedInstant(e.date, e.start, CAMPUS_TZ), end: zonedInstant(e.date, e.end, CAMPUS_TZ),
        title: e.title, allDay: false, free: false, source: "mine", id: e.id }];
    } catch {
      return [];   // a time skipped by a DST change can't be placed
    }
  });
}
