// The Calendar tab's month grid and the selected day's event list. Pure helpers: they read event
// occurrences from the imported schedule (schedule.js eventsOf) and never store or change them.
import { DEFAULT_TZ } from "./schedule.js";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;

/** The calendar date ("YYYY-MM-DD") of an instant in a timezone. */
export const dayKey = (timestamp, zone) => new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(timestamp));

export const addDays = (isoDate, amount) => {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
};

/** "YYYY-MM" moved by `amount` months. */
export function shiftMonth(month, amount) {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + amount, 1));
  return date.toISOString().slice(0, 7);
}

export const monthTitle = (month) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })
  .format(new Date(`${month}-01T12:00:00Z`));

/** Every date shown for a month: whole Monday–Sunday weeks covering it (5 or 6 rows). */
export function monthCells(month) {
  const first = `${month}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;     // Monday = 0
  const start = addDays(first, -offset);
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const cells = [];
  for (let date = start; cells.length % 7 || date <= last; date = addDays(date, 1)) {
    cells.push({ date, inMonth: date.startsWith(month) });
  }
  return cells;
}

/**
 * Occurrences per date from `first` to `last` (inclusive), as Map(date → entries in start order).
 * A timed event appears on every date it overlaps in `zone`; an all-day event on its own dates
 * (stored as campus midnights). The end is exclusive, so an event ending at midnight doesn't
 * spill into the next day. Each entry is { event, index, starts, ends } where `starts`/`ends`
 * say whether the event begins/finishes on that date and `index` is its position in `events`.
 */
export function eventsByDay(events, first, last, zone) {
  const byDay = new Map();
  // Cheap prefilter with a day of slack either side for timezone offsets.
  const from = Date.parse(`${first}T00:00:00Z`) - 2 * DAY_MS;
  const until = Date.parse(`${last}T00:00:00Z`) + 3 * DAY_MS;
  events.forEach((event, index) => {
    if (event.end < from || event.start > until) return;
    const at = event.allDay ? DEFAULT_TZ : zone;
    const startDay = dayKey(event.start, at);
    const endDay = dayKey(event.end - 1, at);
    if (endDay < first || startDay > last) return;
    for (let date = startDay < first ? first : startDay; date <= endDay && date <= last; date = addDays(date, 1)) {
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date).push({ event, index, starts: date === startDay, ends: date === endDay });
    }
  });
  for (const entries of byDay.values()) {
    // All-day first, then by start time.
    entries.sort((a, b) => Number(b.event.allDay) - Number(a.event.allDay) || a.event.start - b.event.start);
  }
  return byDay;
}

const clock = (timestamp, zone) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, hour: "numeric", minute: "2-digit",
}).format(new Date(timestamp));
const shortDay = (timestamp, zone) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, weekday: "short", month: "short", day: "numeric",
}).format(new Date(timestamp));
const zoneName = (timestamp, zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
  .formatToParts(new Date(timestamp)).find((part) => part.type === "timeZoneName")?.value ?? "";

/** What the event looks like on one date of the grid: "9:00 AM", "From 11:00 PM", "Until 1:30 AM", "All day". */
export function timeOnDay(entry, zone) {
  const { event, starts, ends } = entry;
  if (event.allDay) return "All day";
  if (starts && ends) return clock(event.start, zone);
  if (starts) return `From ${clock(event.start, zone)}`;
  if (ends) return `Until ${clock(event.end, zone)}`;
  return "All day (continues)";
}

/** The event's full date and time range, for the day list. */
export function rangeText(event, zone) {
  if (event.allDay) {
    const startDay = dayKey(event.start, DEFAULT_TZ);
    const lastDay = dayKey(event.end - 1, DEFAULT_TZ);
    const label = (iso) => shortDay(Date.parse(`${iso}T12:00:00Z`), "UTC");
    return startDay === lastDay ? `${label(startDay)} · All day` : `${label(startDay)} – ${label(lastDay)} · All day`;
  }
  const sameDay = dayKey(event.start, zone) === dayKey(event.end - 1, zone);
  return sameDay
    ? `${shortDay(event.start, zone)} · ${clock(event.start, zone)} – ${clock(event.end, zone)} ${zoneName(event.end, zone)}`
    : `${shortDay(event.start, zone)}, ${clock(event.start, zone)} – ${shortDay(event.end, zone)}, ${clock(event.end, zone)} ${zoneName(event.end, zone)}`;
}
