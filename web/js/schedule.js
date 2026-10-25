// The student's imported class schedule: merged busy intervals for free-time calculations, and
// each event occurrence's title, start, end and all-day/free flags for the calendar view. Never
// the file, descriptions, locations or attendees. It stays in this tab (sessionStorage) unless
// the student chooses to remember it on this device (localStorage); removing it clears both.
// Nothing here is sent to a server.
import { normalizeBusy, zonedInstant } from "./availability.js";

export const DEFAULT_TZ = "America/New_York";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEY = "busy.schedule.v1";
const PAST_DAYS = 31;      // recurring events are expanded this far back…
const FUTURE_DAYS = 366;   // …and this far ahead of the import date, and no further
const CALENDAR_FILE = /\.(ics|ical|icalendar|ifb)$/i;

let memory = null;         // used only when browser storage is blocked

/** Why ics.js left an event out, by its `skipped` code. Reads as "2 with …". */
export const SKIP_REASONS = {
  no_start: "no start time",
  no_end: "no end time or duration",
  bad_range: "an end before its start",
  timezone: "an unknown timezone",
  recurrence: "an unsupported repeat rule",
  unreadable: "details that couldn't be read",
};

/** A file BU-sy didn't import. The previous schedule, if any, is left as it was. */
export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const storage = (kind) => {
  try {
    return kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
};
const read = (kind) => {
  try { return storage(kind)?.getItem(KEY) ?? null; } catch { return null; }
};
const remove = (kind) => {
  try { storage(kind)?.removeItem(KEY); } catch { /* storage blocked: nothing stored there */ }
};

const ALL_DAY = 1;
const FREE = 2;

function valid(schedule) {
  const instant = (value) => Number.isFinite(value);
  const events = schedule?.events;
  // `events` is absent on schedules imported before the calendar view; those still work for free time.
  const validEvents = events == null || (Array.isArray(events.titles) && events.titles.every((t) => typeof t === "string")
    && Array.isArray(events.items) && events.items.every((item) => Array.isArray(item) && item.length === 4
      && instant(item[0]) && instant(item[1]) && item[0] < item[1]
      && Number.isInteger(item[2]) && item[2] >= 0 && item[2] < events.titles.length && Number.isInteger(item[3])));
  return schedule?.v === 1 && typeof schedule.fileName === "string" && instant(schedule.importedAt)
    && instant(schedule.coverage?.start) && instant(schedule.coverage?.end)
    && Array.isArray(schedule.busy) && schedule.busy.every((range) =>
      Array.isArray(range) && range.length === 2 && instant(range[0]) && instant(range[1]) && range[0] < range[1])
    && validEvents;
}

/** The saved schedule plus where it lives ("local", "session" or "memory"), or null. */
export function loadSchedule() {
  for (const kind of ["local", "session"]) {
    const raw = read(kind);
    if (!raw) continue;
    try {
      const schedule = JSON.parse(raw);
      if (valid(schedule)) return { ...schedule, storedIn: kind };
    } catch { /* unreadable: treated as no schedule */ }
    remove(kind);
  }
  return memory && { ...memory, storedIn: "memory" };
}

/** Replaces any saved schedule. Returns where it was kept. */
export function saveSchedule(schedule, remember) {
  const { storedIn, ...data } = schedule;
  clearSchedule();
  const raw = JSON.stringify(data);
  for (const kind of remember ? ["local", "session"] : ["session"]) {
    try {
      storage(kind).setItem(KEY, raw);
      return kind;
    } catch { /* blocked or full: try the next place */ }
  }
  memory = data;
  return "memory";
}

/** Deletes the schedule from every place it could be kept. */
export function clearSchedule() {
  remove("local");
  remove("session");
  memory = null;
}

export const busyOf = (schedule) => schedule.busy.map(([start, end]) => ({ start, end }));
/** The imported event occurrences in start order, or null for a schedule saved without them. */
export const eventsOf = (schedule) => schedule.events?.items.map(([start, end, title, flags]) => ({
  start, end, title: schedule.events.titles[title], allDay: !!(flags & ALL_DAY), free: !!(flags & FREE),
})) ?? null;
export const covers = (schedule, start, end) => start >= schedule.coverage.start && end <= schedule.coverage.end;

/** Campus dates from PAST_DAYS before `now` to FUTURE_DAYS after it, as epoch ms. */
export function importWindow(now = Date.now()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
  const shift = (days) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return zonedInstant(date.toISOString().slice(0, 10), "00:00", DEFAULT_TZ);
  };
  return { start: shift(-PAST_DAYS), end: shift(FUTURE_DAYS) };
}

/**
 * What gets stored from a parsed calendar: merged busy ranges, the event occurrences (each title
 * kept once; occurrences as [start, end, title index, flags]) and counts, nothing else.
 */
export function buildSchedule(parsed, fileName, coverage, now = Date.now()) {
  const busy = normalizeBusy(parsed.busy, coverage.start, coverage.end);
  return {
    v: 1,
    fileName: String(fileName).slice(0, 200),
    importedAt: now,
    coverage,
    busy: busy.map(({ start, end }) => [start, end]),
    events: compactEvents(parsed.items),
    lastBusyEnd: busy.length ? busy[busy.length - 1].end : null,
    openEnded: parsed.openEnded,
    stats: {
      events: parsed.events, occurrences: parsed.occurrences, cancelled: parsed.cancelled,
      free: parsed.free, skipped: parsed.skipped, truncated: parsed.truncated,
    },
  };
}

function compactEvents(items) {
  const titles = [];
  const index = new Map();
  const titleIndex = (title) => {
    if (!index.has(title)) { index.set(title, titles.length); titles.push(title); }
    return index.get(title);
  };
  return {
    titles,
    items: items.map(({ start, end, title, allDay, free }) =>
      [start, end, titleIndex(title), (allDay ? ALL_DAY : 0) | (free ? FREE : 0)]),
  };
}

/**
 * Reads, checks and saves an uploaded calendar file. Throws ImportError (and keeps the
 * previous schedule) when the file can't be used or holds no events.
 */
export async function importCalendarFile(file, { remember = false, now = Date.now() } = {}) {
  if (!CALENDAR_FILE.test(file.name ?? "") && file.type !== "text/calendar") {
    throw new ImportError("not_ics", "Choose an iCalendar file ending in .ics.");
  }
  if (!file.size) throw new ImportError("empty", "The file is empty.");
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError("too_large", `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Export just your class calendar, or a shorter date range.`);
  }
  const text = await file.text();
  const { parseIcs, IcsError } = await import("./ics.js");
  const coverage = importWindow(now);
  let parsed;
  try {
    parsed = parseIcs(text, { from: coverage.start, until: coverage.end, defaultZone: DEFAULT_TZ });
  } catch (error) {
    if (error instanceof IcsError) throw new ImportError(error.code, error.message);
    throw new ImportError("malformed", "The calendar file couldn't be read.");
  }
  if (!parsed.vevents) {
    throw new ImportError("no_events", "This is a valid calendar file, but it has no events, so there was nothing to import.");
  }
  if (!parsed.events && !parsed.cancelled && !parsed.free) {
    throw new ImportError("no_usable", `None of the ${parsed.vevents} events could be used: ${skippedText(parsed.skipped)}.`);
  }
  const schedule = buildSchedule(parsed, file.name || "calendar.ics", coverage, now);
  return { ...schedule, storedIn: saveSchedule(schedule, remember) };
}

/** "2 with no end time or duration, 1 with an unknown timezone" */
export function skippedText(skipped) {
  return Object.entries(skipped).map(([code, count]) => `${count} with ${SKIP_REASONS[code] ?? "a problem"}`).join(", ");
}
