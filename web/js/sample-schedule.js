// User-provided screenshot, October 25–31, 2026, GMT-04 (Boston).
// Titles/locations belong only to this explicit preview, never the Google free/busy adapter.
import { zonedInstant } from "./availability.js";

export const SAMPLE_ZONE = "America/New_York";
export const SAMPLE_DATES = Array.from({ length: 7 }, (_, i) => `2026-10-${25 + i}`);
export const SAMPLE_NOTE = "Sample from the supplied weekly screenshot. Class blocks whose end times were cropped use an estimated 50-minute duration; Saturday code review uses an estimated 15 minutes. Cropped room numbers are omitted. Halloween is informational and does not block the day. This preview replays the whole day, regardless of today's date.";

const timed = (date, title, start, end, location = "", estimatedEnd = false) =>
  ({ date, title, start, end, location, estimatedEnd });
const events = [timed("2026-10-25", "Symphony + Lunch?", "11:00", "14:00")];
for (const day of [26, 28, 30]) {
  const date = `2026-10-${day}`;
  events.push(
    timed(date, "CASLK 116", "11:15", "12:05", "2 Silber Way", true),
    timed(date, "CDSDS 110", "12:20", "13:10", "871 Commonwealth Avenue", true),
    timed(date, "Lunch", "13:30", "14:15"),
    timed(date, "CDSDS 120", "14:30", "15:20", "2 Silber Way", true),
  );
}
events.push(timed("2026-10-26", "MNP", "20:00", "21:00"));
events.push(timed("2026-10-27", "CDSDS 109", "11:00", "12:15", "665 Commonwealth Avenue · CDS 164"));
events.push(timed("2026-10-29", "CDSDS 120", "11:15", "12:05", "665 Commonwealth Avenue", true));
for (const day of [27, 29]) {
  const date = `2026-10-${day}`;
  events.push(
    timed(date, "CASWR 120", "12:30", "13:45", "685–725 Commonwealth Avenue · CAS 315"),
    timed(date, "CFAMU 097", "18:30", "20:30", "855 Commonwealth Avenue · CFA 167"),
  );
}
events.push(
  timed("2026-10-28", "CDSDS 110", "15:35", "16:25", "665 Commonwealth Avenue", true),
  timed("2026-10-28", "Dinner", "17:00", "18:00"),
  timed("2026-10-28", "BUCG SL", "18:30", "20:00", "HAR 312"),
  timed("2026-10-28", "FG", "19:30", "21:30"),
  timed("2026-10-31", "Code Review for 110", "15:45", "16:00", "", true),
  { date: "2026-10-31", title: "Halloween", allDay: true, blocksTime: false },
);
export const SAMPLE_EVENTS = events.map(Object.freeze);
export const sampleEventsForDay = (date) => SAMPLE_EVENTS.filter(event => event.date === date)
  .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
export function sampleBusyForDay(date) {
  return sampleEventsForDay(date).filter(event => !event.allDay).map(event => ({
    start: new Date(zonedInstant(date, event.start, SAMPLE_ZONE)).toISOString(),
    end: new Date(zonedInstant(date, event.end, SAMPLE_ZONE)).toISOString(),
  }));
}
