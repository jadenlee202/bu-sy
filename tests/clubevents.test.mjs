import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { freeWindows, matchFreeWindows, usableWindows, zonedInstant } from "../web/js/availability.js";
import {
  addClubEvent, clubBusy, clubEventItems, clubMeetings, eventId, loadClubEvents, reconcile, removeClubEvent,
} from "../web/js/clubevents.js";
import { eventsByDay, timeOnDay } from "../web/js/monthview.js";
import { busyOf, clearSchedule, importCalendarFile, loadSchedule } from "../web/js/schedule.js";

const TZ = "America/New_York";
const at = (date, hhmm) => zonedInstant(date, hhmm, TZ);
const NOON_SUNDAY = Date.parse("2026-10-25T12:00:00-04:00");
const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));
const marciano = { ...hours.locations["marciano-dining-synthetic"], category: "dining" };

// A club as the Clubs tab sees it (source.js / server/clubs.py public shape).
const club = (over = {}) => ({
  id: "example-2", name: "Charles River Run Club", meeting_day: "Tuesday", meeting_start: "18:00", meeting_end: "19:00",
  location_name: "FitRec", location_text: "Meet at the FitRec main entrance", upcoming: [], ...over,
});

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.get(key) ?? null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}
const setStorage = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
beforeEach(() => {
  setStorage("localStorage", new MemoryStorage());
  setStorage("sessionStorage", new MemoryStorage());
  clearSchedule();
});

// ---------- which meetings can be added ----------

test("offers the next four regular meetings from the club's own schedule, nothing invented", () => {
  const { regular, extra } = clubMeetings(club(), NOON_SUNDAY);
  assert.deepEqual(regular.map((m) => m.date), ["2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"]);
  assert.deepEqual(regular[0], {
    id: "example-2@2026-10-27", clubId: "example-2", clubName: "Charles River Run Club", date: "2026-10-27",
    start: "18:00", end: "19:00", location: "FitRec · Meet at the FitRec main entrance",
    note: "Regular weekly meeting (from the club's schedule)",
  });
  assert.deepEqual(extra, []);
  assert.deepEqual(clubMeetings(club({ meeting_day: null, meeting_start: null, meeting_end: null }), NOON_SUNDAY).regular, [], "no schedule, nothing to add");
  assert.deepEqual(clubMeetings(club({ meeting_start: null, meeting_end: null }), NOON_SUNDAY).regular, [], "a day without times isn't enough");
});

test("skips today's meeting once it's over, keeps it before then", () => {
  const sundayClub = club({ meeting_day: "Sunday", meeting_start: "12:00", meeting_end: "13:30" });
  assert.equal(clubMeetings(sundayClub, NOON_SUNDAY).regular[0].date, "2026-10-25", "in progress: still offered");
  assert.equal(clubMeetings(sundayClub, Date.parse("2026-10-25T14:00:00-04:00")).regular[0].date, "2026-11-01");
});

test("extra meetings have no time, so they're listed but never become calendar entries", () => {
  const { regular, extra } = clubMeetings(club({ upcoming: [{ date: "2026-11-05", note: "Trail run" }] }), NOON_SUNDAY);
  assert.deepEqual(extra, [{ date: "2026-11-05", note: "Trail run" }]);
  assert.ok(!regular.some((m) => m.date === "2026-11-05"));
});

// ---------- saving, duplicates, removing ----------

test("adding twice saves one copy; removing takes out only that meeting", () => {
  const [first, second] = clubMeetings(club(), NOON_SUNDAY).regular;
  addClubEvent(first);
  addClubEvent(first);
  addClubEvent(second);
  assert.deepEqual(loadClubEvents().map((e) => e.id), [first.id, second.id]);
  removeClubEvent(first.id);
  assert.deepEqual(loadClubEvents().map((e) => e.id), [second.id]);
});

test("a save the browser refuses throws, so the screen never shows \"added\"", () => {
  setStorage("localStorage", { getItem: () => null, setItem() { throw new DOMException("blocked", "SecurityError"); }, removeItem() {} });
  assert.throws(() => addClubEvent(clubMeetings(club(), NOON_SUNDAY).regular[0]), DOMException);
});

test("incomplete or damaged event data never becomes a calendar entry", () => {
  const meeting = clubMeetings(club(), NOON_SUNDAY).regular[0];
  assert.throws(() => addClubEvent({ ...meeting, start: undefined }), /missing its date or times/);
  assert.throws(() => addClubEvent({ ...meeting, end: "17:00" }), /missing its date or times/, "ends before it starts");
  assert.throws(() => addClubEvent({ ...meeting, id: "something-else" }), /missing/, "id must be club + date");
  assert.deepEqual(loadClubEvents(), []);
  localStorage.setItem("busy.clubEvents.v1", JSON.stringify([{ id: "x" }, meeting, "junk"]));
  assert.deepEqual(loadClubEvents().map((e) => e.id), [meeting.id], "bad saved entries are ignored");
  localStorage.setItem("busy.clubEvents.v1", "{not json");
  assert.deepEqual(loadClubEvents(), []);
});

// ---------- in the calendar and free-time calculations ----------

test("a saved meeting appears on its date at its campus time, across the DST change", () => {
  for (const m of clubMeetings(club(), NOON_SUNDAY).regular.slice(0, 2)) addClubEvent(m);
  const items = clubEventItems(loadClubEvents());
  assert.equal(new Date(items[0].start).toISOString(), "2026-10-27T22:00:00.000Z");   // 6 PM EDT
  assert.equal(new Date(items[1].start).toISOString(), "2026-11-03T23:00:00.000Z");   // 6 PM EST
  const byDay = eventsByDay(items, "2026-10-26", "2026-11-08", TZ);
  const entry = byDay.get("2026-10-27")[0];
  assert.equal(entry.event.title, "Charles River Run Club meeting");
  assert.equal(entry.event.source, "club");
  assert.equal(timeOnDay(entry, TZ), "6:00 PM");
});

test("club meetings are busy: free time and dining matches avoid them, merged with the .ics schedule", async () => {
  addClubEvent({ ...clubMeetings(club({ meeting_start: "12:00", meeting_end: "13:00" }), NOON_SUNDAY).regular[0] });  // Tue Oct 27, noon
  const file = readFileSync(new URL("./fixtures/ics/tuesday.ics", import.meta.url), "utf8");   // 9–10:15, 11:30–1, 2:30–4
  await importCalendarFile(new File([file], "tuesday.ics", { type: "text/calendar" }), { now: NOON_SUNDAY });
  const busy = [...busyOf(loadSchedule()), ...clubBusy()];
  const free = freeWindows(busy, at("2026-10-27", "08:00"), at("2026-10-27", "22:00"));
  assert.deepEqual(free.map(({ start, end }) => [start, end]), [
    [at("2026-10-27", "08:00"), at("2026-10-27", "09:00")],
    [at("2026-10-27", "10:15"), at("2026-10-27", "11:30")],
    [at("2026-10-27", "13:00"), at("2026-10-27", "14:30")],   // the noon club meeting overlaps class B: merged
    [at("2026-10-27", "16:00"), at("2026-10-27", "22:00")],
  ]);
  // Without the .ics file, the club meeting alone still blocks lunch at noon.
  clearSchedule();
  const usable = usableWindows(freeWindows(clubBusy(), at("2026-10-27", "08:00"), at("2026-10-27", "22:00")), 30);
  const lunch = matchFreeWindows(usable, marciano, "2026-10-27", 30).matches.filter((m) => m.label === "Lunch");
  assert.ok(lunch.every(({ start, end }) => end <= at("2026-10-27", "12:00") || start >= at("2026-10-27", "13:00")));
  assert.ok(lunch.some(({ start }) => start === at("2026-10-27", "13:00")));
});

// ---------- kept apart from the imported .ics schedule ----------

test("uploading, replacing and clearing the .ics schedule never touch club events", async () => {
  const meeting = clubMeetings(club(), NOON_SUNDAY).regular[0];
  addClubEvent(meeting);
  const upload = (name) => importCalendarFile(new File([readFileSync(new URL(`./fixtures/ics/${name}`, import.meta.url), "utf8")], name, { type: "text/calendar" }), { now: NOON_SUNDAY });
  await upload("weekly-class.ics");
  await upload("tuesday.ics");
  clearSchedule();
  assert.equal(loadSchedule(), null);
  assert.deepEqual(loadClubEvents().map((e) => e.id), [meeting.id]);
});

// ---------- when the club's data changes ----------

test("saved meetings follow the club by stable id: new times update, dropped meetings are flagged", () => {
  const meeting = clubMeetings(club(), NOON_SUNDAY).regular[0];
  addClubEvent(meeting);
  const moved = reconcile(loadClubEvents(), [club({ meeting_start: "19:00", meeting_end: "20:30" })]);
  assert.deepEqual([moved[0].start, moved[0].end], ["19:00", "20:30"]);
  assert.match(moved[0].issue, /Time updated.*6:00 PM–7:00 PM/);
  assert.deepEqual([loadClubEvents()[0].start, loadClubEvents()[0].end], ["19:00", "20:30"], "the update is saved");
  assert.match(reconcile(loadClubEvents(), [club({ meeting_day: "Wednesday" })])[0].issue, /no longer meets on this day/);
  assert.match(reconcile(loadClubEvents(), [])[0].issue, /no longer listed/);
  assert.equal(reconcile(loadClubEvents(), [club({ meeting_start: "19:00", meeting_end: "20:30" })])[0].issue ?? "", "");
  assert.equal(eventId("example-2", "2026-10-27"), meeting.id);
});
