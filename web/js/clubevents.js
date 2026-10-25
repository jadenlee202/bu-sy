// Club meetings the student adds to their BU-sy calendar from the Clubs tab. They're kept apart
// from the imported .ics schedule (their own storage key), so uploading, replacing or clearing
// that file never touches them, and removing one meeting removes only that one. Each has a stable
// id (club id + date), so adding it twice is a no-op. Only what the calendar needs is stored:
// club, date, times, place and a short note. Nothing here leaves the browser.
import { zonedInstant } from "./availability.js";
import { formatClock } from "./hours.js";

export const CAMPUS_TZ = "America/New_York";   // club meeting times are campus times
const KEY = "busy.clubEvents.v1";
const WEEKS_AHEAD = 4;                          // regular meetings offered: the next four weeks
const WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (isoDate, amount) => {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
};
const weekdayOf = (isoDate) => WEEK[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
const campusToday = (now) => new Intl.DateTimeFormat("en-CA", {
  timeZone: CAMPUS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(now));
/** The club's meeting place as shown on the Clubs tab ("" when not given). */
export const placeOf = (club) => [...new Set([club.location_name, club.location_text].filter(Boolean))].join(" · ");
export const eventId = (clubId, date) => `${clubId}@${date}`;

const valid = (e) => typeof e?.id === "string" && typeof e.clubId === "string" && typeof e.clubName === "string"
  && DATE.test(e.date ?? "") && HHMM.test(e.start ?? "") && HHMM.test(e.end ?? "") && e.end > e.start
  && typeof e.location === "string" && typeof e.note === "string" && e.id === eventId(e.clubId, e.date);
const stored = ({ id, clubId, clubName, date, start, end, location, note }) => ({ id, clubId, clubName, date, start, end, location, note });

/**
 * The meetings a club offers to add, from its own data only. `regular`: the next WEEKS_AHEAD
 * meetings of its weekly schedule (needs a day, start and end), skipping any that already ended.
 * `extra`: its dated extra meetings, which have no time, so they can't become calendar entries.
 */
export function clubMeetings(club, now = Date.now()) {
  const regular = [];
  if (WEEK.includes(club.meeting_day) && HHMM.test(club.meeting_start ?? "") && HHMM.test(club.meeting_end ?? "")
    && club.meeting_end > club.meeting_start) {
    const today = campusToday(now);
    const first = addDays(today, (WEEK.indexOf(club.meeting_day) - WEEK.indexOf(weekdayOf(today)) + 7) % 7);
    for (let week = 0; week <= WEEKS_AHEAD && regular.length < WEEKS_AHEAD; week += 1) {
      const date = addDays(first, 7 * week);
      if (zonedInstant(date, club.meeting_end, CAMPUS_TZ) <= now) continue;   // today's meeting is over
      regular.push({
        id: eventId(club.id, date), clubId: club.id, clubName: club.name, date,
        start: club.meeting_start, end: club.meeting_end, location: placeOf(club),
        note: "Regular weekly meeting (from the club's schedule)",
      });
    }
  }
  const extra = (club.upcoming ?? []).filter((m) => DATE.test(m.date ?? "")).map((m) => ({ date: m.date, note: m.note ?? "" }));
  return { regular, extra };
}

// ---------- storage ----------
/** Saved meetings, valid ones only, in date order. Unreadable or blocked storage reads as none. */
export function loadClubEvents() {
  try {
    const raw = JSON.parse(globalThis.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)) : [];
  } catch {
    return [];
  }
}

/** Throws when the browser won't store it, so the screen never says "added" when it wasn't. */
function write(list) {
  globalThis.localStorage.setItem(KEY, JSON.stringify(list.map(stored)));
}

/** Adds a meeting unless it's already saved. Returns the saved list. */
export function addClubEvent(event) {
  if (!valid(event)) throw new Error("This meeting is missing its date or times, so it can't be added.");
  const list = loadClubEvents();
  if (list.some((saved) => saved.id === event.id)) return list;
  const next = [...list, stored(event)];
  write(next);
  return loadClubEvents();
}

/** Removes one meeting; nothing else. Returns the saved list. */
export function removeClubEvent(id) {
  write(loadClubEvents().filter((saved) => saved.id !== id));
  return loadClubEvents();
}

// ---------- for the calendar and free-time calculations ----------
/** Saved meetings as calendar occurrences (epoch ms), marked as club events. */
export function clubEventItems(list) {
  return list.flatMap((e) => {
    try {
      return [{
        start: zonedInstant(e.date, e.start, CAMPUS_TZ), end: zonedInstant(e.date, e.end, CAMPUS_TZ),
        title: `${e.clubName} meeting`, allDay: false, free: false, source: "club",
        id: e.id, clubId: e.clubId, clubName: e.clubName, location: e.location, note: e.note, issue: e.issue ?? "",
      }];
    } catch {
      return [];   // a time skipped by a DST change can't be placed
    }
  });
}

/** Busy intervals for free-time calculations: every saved meeting blocks its time. */
export const clubBusy = (list = loadClubEvents()) => clubEventItems(list).map(({ start, end }) => ({ start, end }));

/**
 * Checks saved meetings against the clubs' current data, by stable id (club + date). A changed
 * meeting time or place is updated and saved, with a note saying so; a meeting the club no longer
 * has, or a club that's gone, is flagged rather than silently kept as if nothing changed.
 */
export function reconcile(list, clubs) {
  const byId = new Map(clubs.map((club) => [club.id, club]));
  let updated = false;
  const checked = list.map((e) => {
    const club = byId.get(e.clubId);
    if (!club) return { ...e, issue: "This club is no longer listed." };
    if (club.meeting_day !== weekdayOf(e.date) || !club.meeting_start || !club.meeting_end) {
      return { ...e, issue: "The club no longer meets on this day." };
    }
    const timeChanged = club.meeting_start !== e.start || club.meeting_end !== e.end;
    if (!timeChanged && placeOf(club) === e.location && club.name === e.clubName) return e;
    updated = true;
    return {
      ...e, start: club.meeting_start, end: club.meeting_end, location: placeOf(club), clubName: club.name,
      issue: timeChanged ? `Time updated to match the club's schedule (was ${formatClock(e.start)}–${formatClock(e.end)}).` : "",
    };
  });
  if (updated) {
    try { write(checked); } catch { /* storage blocked: still shown corrected this time */ }
  }
  return checked;
}
