import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { findOpportunities, freeWindows, matchFreeWindows, usableWindows, zonedInstant } from "../web/js/availability.js";
import { IcsError, parseIcs } from "../web/js/ics.js";
import {
  busyOf, clearSchedule, covers, eventsOf, importCalendarFile, ImportError, importWindow, loadSchedule, saveSchedule,
} from "../web/js/schedule.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/ics/${name}`, import.meta.url), "utf8");
const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));
const marciano = { ...hours.locations["marciano-dining-synthetic"], category: "dining" };
const fitrec = { ...hours.locations["fitrec-synthetic"], category: "fitness" };

const RANGE = { from: Date.parse("2026-09-01T00:00:00Z"), until: Date.parse("2027-06-01T00:00:00Z") };
const parse = (name) => parseIcs(fixture(name), RANGE);
const iso = (ms) => new Date(ms).toISOString().replace(".000", "");
/** Busy intervals overlapping a UTC day, as ISO strings. */
const busyOn = (result, day) => result.busy
  .filter(({ start, end }) => end > Date.parse(`${day}T00:00:00Z`) && start < Date.parse(`${day}T23:59:59Z`))
  .map(({ start, end }) => [iso(start), iso(end)]);
const at = (date, hhmm) => zonedInstant(date, hhmm, "America/New_York");

// ---------- parsing ----------

test("expands a weekly class across the DST change, keeping 9:30 AM local time", () => {
  const result = parse("weekly-class.ics");
  assert.deepEqual(busyOn(result, "2026-10-20"), [["2026-10-20T13:30:00Z", "2026-10-20T14:45:00Z"]]);   // EDT
  assert.deepEqual(busyOn(result, "2026-11-03"), [["2026-11-03T14:30:00Z", "2026-11-03T15:45:00Z"]]);   // EST
  assert.deepEqual(busyOn(result, "2026-12-10"), [["2026-12-10T14:30:00Z", "2026-12-10T15:45:00Z"]]);   // last, by UNTIL
  assert.deepEqual(busyOn(result, "2026-12-15"), []);
  assert.equal(result.events, 1);
  assert.equal(result.openEnded, false);
});

test("honours EXDATE, moved occurrences and cancelled occurrences", () => {
  const result = parse("weekly-class.ics");
  assert.deepEqual(busyOn(result, "2026-10-13"), [], "excluded by EXDATE");
  assert.deepEqual(busyOn(result, "2026-10-22"), [["2026-10-22T15:00:00Z", "2026-10-22T16:15:00Z"]], "moved to 11:00");
  assert.deepEqual(busyOn(result, "2026-10-27"), [], "cancelled occurrence");
  assert.equal(result.cancelled, 1);
});

test("reads UTC, IANA TZID, floating, prefixed TZID and DST-gap times correctly", () => {
  const result = parse("single-events.ics");
  assert.deepEqual(busyOn(result, "2026-10-20"), [
    ["2026-10-20T16:00:00Z", "2026-10-20T17:00:00Z"],   // 9 AM Pacific
    ["2026-10-20T17:00:00Z", "2026-10-20T18:00:00Z"],   // UTC stays UTC
  ]);
  assert.deepEqual(busyOn(result, "2026-10-21"), [
    ["2026-10-21T08:00:00Z", "2026-10-21T09:00:00Z"],   // 9 AM London (BST), not Boston
    ["2026-10-21T18:00:00Z", "2026-10-21T19:30:00Z"],   // floating 2 PM → Boston, with DURATION
  ]);
  assert.deepEqual(busyOn(result, "2026-10-22"), [["2026-10-22T14:00:00Z", "2026-10-22T15:00:00Z"]]);  // America/Chicago
  // 2:30 AM doesn't exist on 2027-03-14 in Boston: read with the pre-change offset, i.e. 3:30 AM EDT.
  assert.deepEqual(busyOn(result, "2027-03-14"), [["2027-03-14T07:30:00Z", "2027-03-14T08:00:00Z"]]);
  assert.equal(result.events, 6);
});

test("uses a Windows TZID's own VTIMEZONE, honours Outlook free status, and skips unknown zones", () => {
  const result = parse("outlook.ics");
  assert.deepEqual(busyOn(result, "2026-11-03"), [["2026-11-03T18:00:00Z", "2026-11-03T19:15:00Z"]]);
  assert.equal(result.free, 1);
  assert.deepEqual(result.skipped, { timezone: 1 });
});

test("handles all-day, overnight, multi-day, overlapping and open-ended events", () => {
  const result = parse("all-day-and-overnight.ics");
  assert.deepEqual(busyOn(result, "2026-10-28"), [["2026-10-28T04:00:00Z", "2026-10-29T04:00:00Z"]], "all-day, Boston midnights");
  assert.equal(result.free, 1, "transparent all-day reminder isn't busy");
  assert.ok(result.busy.some(({ start, end }) => iso(start) === "2026-10-31T03:00:00Z" && iso(end) === "2026-10-31T05:30:00Z"), "crosses midnight");
  assert.ok(result.busy.some(({ start, end }) => iso(start) === "2026-11-05T23:00:00Z" && iso(end) === "2026-11-07T14:00:00Z"), "spans days");
  assert.equal(busyOn(result, "2026-11-10").length, 2, "overlaps are kept as read and merged later");
  assert.equal(result.openEnded, true);
  const weekly = result.busy.filter(({ start }) => new Date(start).getUTCDay() === 1 && new Date(start).getUTCHours() >= 20);
  assert.equal(iso(weekly.at(-1).start) < iso(RANGE.until), true, "open-ended rule stops at the requested range");
});

test("free-time windows clip events that cross midnight or span several days", () => {
  const result = parse("all-day-and-overnight.ics");
  assert.deepEqual(freeWindows(result.busy, at("2026-10-31", "00:00"), at("2026-10-31", "08:00")), [
    { start: at("2026-10-31", "01:30"), end: at("2026-10-31", "08:00") },
  ]);
  assert.deepEqual(freeWindows(result.busy, at("2026-11-06", "08:00"), at("2026-11-06", "22:00")), [], "all day inside a trip");
  assert.deepEqual(freeWindows(result.busy, at("2026-11-10", "08:00"), at("2026-11-10", "12:00")), [
    { start: at("2026-11-10", "08:00"), end: at("2026-11-10", "09:00") },
    { start: at("2026-11-10", "11:00"), end: at("2026-11-10", "12:00") },
  ], "overlapping 9–10 and 9:30–11 merge into one busy block");
});

test("skips events with no start, no end, a backwards range or a bad repeat rule, and ignores cancelled ones", () => {
  const result = parse("problems.ics");
  assert.equal(result.vevents, 6);
  assert.equal(result.events, 1);
  assert.equal(result.cancelled, 1);
  assert.deepEqual(result.skipped, { no_end: 1, bad_range: 1, recurrence: 1, no_start: 1 });
  assert.deepEqual(busyOn(result, "2026-10-20"), [["2026-10-20T16:00:00Z", "2026-10-20T17:00:00Z"]]);
});

test("rejects files that aren't usable calendars", () => {
  assert.throws(() => parseIcs("", RANGE), (error) => error instanceof IcsError && error.code === "empty");
  assert.throws(() => parse("not-a-calendar.ics"), (error) => error.code === "not_ics");
  assert.throws(() => parse("malformed.ics"), (error) => error.code === "malformed");
  assert.throws(() => parseIcs("BEGIN:VCALENDAR\u0000\u0001", RANGE), (error) => error.code === "not_ics");
  const empty = parse("empty-calendar.ics");
  assert.equal(empty.vevents, 0);
  assert.deepEqual(empty.busy, []);
});

test("keeps event titles for the calendar, never descriptions, locations or attendees", () => {
  const result = parse("weekly-class.ics");
  const text = JSON.stringify(result);
  assert.ok(text.includes("CS 111 Lecture (sample)"));
  for (const secret of ["Private note", "CAS 522", "student@example.edu"]) assert.ok(!text.includes(secret), secret);
});

test("lists each occurrence with its own title, all-day and free flags", () => {
  const weekly = parse("weekly-class.ics");
  const onDay = (result, day) => result.items.filter(({ start }) => iso(start).startsWith(day));
  assert.deepEqual(onDay(weekly, "2026-10-20").map(({ title, allDay, free }) => [title, allDay, free]), [["CS 111 Lecture (sample)", false, false]]);
  assert.deepEqual(onDay(weekly, "2026-10-22").map(({ title, start }) => [title, iso(start)]), [["CS 111 Lecture (moved)", "2026-10-22T15:00:00Z"]]);
  assert.deepEqual(onDay(weekly, "2026-10-27"), [], "cancelled occurrence isn't listed");
  assert.deepEqual(onDay(weekly, "2026-10-13"), [], "excluded occurrence isn't listed");
  assert.equal(weekly.items.length, weekly.busy.length, "every busy occurrence is listed");

  const mixed = parse("all-day-and-overnight.ics");
  const fieldTrip = mixed.items.find(({ title }) => title === "Field trip (busy all day)");
  assert.deepEqual([fieldTrip.allDay, fieldTrip.free, iso(fieldTrip.start), iso(fieldTrip.end)], [true, false, "2026-10-28T04:00:00Z", "2026-10-29T04:00:00Z"]);
  const reminder = mixed.items.find(({ title }) => title === "Midterm week reminder");
  assert.deepEqual([reminder.allDay, reminder.free], [true, true], "free events are listed but not busy");
  assert.ok(!mixed.busy.some(({ start }) => start === reminder.start));
  assert.equal(parse("outlook.ics").items.find(({ free }) => free).title, "Tentative hold shown as free");
});

// ---------- matching free time to campus hours ----------

test("matches the example Tuesday to Marciano's meal periods, never past a meal's end", () => {
  const busy = parse("tuesday.ics").busy;
  const usable = usableWindows(freeWindows(busy, at("2026-10-27", "08:00"), at("2026-10-27", "22:00")), 30);
  const { status, matches } = matchFreeWindows(usable, marciano, "2026-10-27", 30);
  assert.equal(status, "scheduled");
  const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(ms);
  assert.deepEqual(matches.map(({ start, end, label }) => `${label} ${fmt(start)}–${fmt(end)}`), [
    "Breakfast 8:00 AM–9:00 AM",
    "Breakfast 10:15 AM–11:00 AM",
    "Lunch 11:00 AM–11:30 AM",
    "Lunch 1:00 PM–2:30 PM",
    "Lunch 4:00 PM–5:00 PM",
    "Dinner 5:00 PM–9:00 PM",   // free until 10 PM, but dinner and the building end at 9
  ]);
});

test("minimum duration drops windows that are too short after clipping to a meal", () => {
  const busy = parse("tuesday.ics").busy;
  const usable = usableWindows(freeWindows(busy, at("2026-10-27", "08:00"), at("2026-10-27", "22:00")), 45);
  const labels = matchFreeWindows(usable, marciano, "2026-10-27", 45).matches.map(({ label }) => label);
  assert.deepEqual(labels, ["Breakfast", "Breakfast", "Lunch", "Lunch", "Dinner"], "11:00–11:30 lunch (30 min) is gone");
});

test("non-dining places match building hours", () => {
  const busy = parse("tuesday.ics").busy;
  const usable = usableWindows(freeWindows(busy, at("2026-10-27", "08:00"), at("2026-10-27", "23:30")), 30);
  const { matches } = matchFreeWindows(usable, fitrec, "2026-10-27", 30);
  assert.deepEqual(matches.map(({ start, end }) => [start, end]).at(-1), [at("2026-10-27", "16:00"), at("2026-10-27", "23:00")], "FitRec closes at 11 PM");
  assert.ok(matches.every(({ label }) => label === "Open"));
});

test("finds the next lunch and reports days outside the imported calendar", () => {
  const busy = parse("tuesday.ics").busy;
  const options = { timezone: "America/New_York", from: "08:00", until: "22:00", minimum: 30, meal: "lunch" };
  const { matches } = findOpportunities(busy, marciano, "2026-10-27", 1, options);
  assert.equal(matches[0].start, at("2026-10-27", "11:00"));
  const coverage = { start: at("2026-10-26", "00:00"), end: at("2026-10-28", "00:00") };
  const { outcomes } = findOpportunities(busy, marciano, "2026-10-27", 3, { ...options, coverage });
  assert.deepEqual(outcomes.map(({ reason }) => reason), ["match", "not_covered", "not_covered"]);
});

// ---------- importing, replacing and removing ----------

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.get(key) ?? null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
  get size() { return this.#items.size; }
}
const setStorage = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const NOW = Date.parse("2026-10-25T16:00:00Z");
const file = (name, text = fixture(name), type = "text/calendar") => new File([text], name, { type });

beforeEach(() => {
  setStorage("localStorage", new MemoryStorage());
  setStorage("sessionStorage", new MemoryStorage());
  clearSchedule();
});

test("imports into this tab by default, or this device when remembered, storing titles and times only", async () => {
  const imported = await importCalendarFile(file("weekly-class.ics"), { now: NOW });
  assert.equal(imported.storedIn, "session");
  assert.equal(localStorage.size, 0);
  const raw = sessionStorage.getItem("busy.schedule.v1");
  assert.equal(raw.split("CS 111 Lecture (sample)").length, 2, "a repeated title is stored once");
  for (const secret of ["Private note", "CAS 522", "student@example.edu", "VEVENT"]) assert.ok(!raw.includes(secret), secret);
  const events = eventsOf(loadSchedule());
  assert.equal(events.length, loadSchedule().busy.length);
  assert.deepEqual(Object.keys(events[0]).sort(), ["allDay", "end", "free", "start", "title"]);
  const loaded = loadSchedule();
  assert.equal(loaded.fileName, "weekly-class.ics");
  assert.equal(loaded.stats.events, 1);
  assert.deepEqual(loaded.coverage, importWindow(NOW));
  assert.ok(covers(loaded, at("2026-10-27", "08:00"), at("2026-10-27", "22:00")));
  assert.ok(!covers(loaded, at("2028-01-04", "08:00"), at("2028-01-04", "22:00")));
  assert.deepEqual(busyOf(loaded)[0], { start: loaded.busy[0][0], end: loaded.busy[0][1] });

  const remembered = await importCalendarFile(file("tuesday.ics"), { remember: true, now: NOW });
  assert.equal(remembered.storedIn, "local");
  assert.equal(sessionStorage.size, 0, "replacing removes the old copy");
  assert.equal(loadSchedule().fileName, "tuesday.ics");
  assert.deepEqual(eventsOf(loadSchedule()).map(({ title }) => title), ["Class A", "Class B", "Class C"], "replaced, not merged");
});

test("merges overlapping busy times before storing them", async () => {
  await importCalendarFile(file("all-day-and-overnight.ics"), { now: NOW });
  const { busy } = loadSchedule();
  const overlap = busy.filter(([start]) => start >= at("2026-11-10", "00:00") && start < at("2026-11-11", "00:00"));
  assert.deepEqual(overlap, [[at("2026-11-10", "09:00"), at("2026-11-10", "11:00")]]);
});

test("a failed or empty upload keeps the previous schedule", async () => {
  await importCalendarFile(file("weekly-class.ics"), { now: NOW });
  const before = loadSchedule();
  const rejects = async (upload, code) => assert.rejects(upload, (error) => error instanceof ImportError && error.code === code);
  await rejects(importCalendarFile(file("not-a-calendar.ics"), { now: NOW }), "not_ics");
  await rejects(importCalendarFile(file("malformed.ics"), { now: NOW }), "malformed");
  await rejects(importCalendarFile(file("empty-calendar.ics"), { now: NOW }), "no_events");
  await rejects(importCalendarFile(file("all-invalid.ics"), { now: NOW }), "no_usable");
  await rejects(importCalendarFile(file("notes.txt", fixture("weekly-class.ics"), "text/plain"), { now: NOW }), "not_ics");
  await rejects(importCalendarFile(file("blank.ics", ""), { now: NOW }), "empty");
  await rejects(importCalendarFile(file("huge.ics", "x".repeat(2 * 1024 * 1024 + 1)), { now: NOW }), "too_large");
  assert.deepEqual(loadSchedule(), before);
});

test("reports skipped entries on import", async () => {
  const imported = await importCalendarFile(file("problems.ics"), { now: NOW });
  assert.equal(imported.stats.events, 1);
  assert.deepEqual(imported.stats.skipped, { no_end: 1, bad_range: 1, recurrence: 1, no_start: 1 });
});

test("removing the schedule clears every place it could be stored", async () => {
  await importCalendarFile(file("weekly-class.ics"), { remember: true, now: NOW });
  sessionStorage.setItem("busy.schedule.v1", localStorage.getItem("busy.schedule.v1"));
  clearSchedule();
  assert.equal(localStorage.size, 0);
  assert.equal(sessionStorage.size, 0);
  assert.equal(loadSchedule(), null, "events and busy times are both gone, so a reload restores nothing");
});

test("falls back to memory when storage is blocked, and still clears it", async () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  setStorage("localStorage", blocked);
  setStorage("sessionStorage", blocked);
  const imported = await importCalendarFile(file("tuesday.ics"), { remember: true, now: NOW });
  assert.equal(imported.storedIn, "memory");
  assert.equal(loadSchedule().fileName, "tuesday.ics");
  clearSchedule();
  assert.equal(loadSchedule(), null);
});

test("ignores a corrupted stored schedule and deletes it", () => {
  localStorage.setItem("busy.schedule.v1", "{not json");
  assert.equal(loadSchedule(), null);
  assert.equal(localStorage.size, 0);
  saveSchedule({ v: 1, fileName: "x.ics", importedAt: NOW, coverage: { start: 0, end: 1 }, busy: [[5, 3]] }, true);
  assert.equal(loadSchedule(), null, "a backwards busy range fails validation");
  saveSchedule({ v: 1, fileName: "x.ics", importedAt: NOW, coverage: { start: 0, end: 9 }, busy: [], events: { titles: [], items: [[1, 2, 0, 0]] } }, true);
  assert.equal(loadSchedule(), null, "an event pointing at a missing title fails validation");
});

test("a schedule saved before event details still loads, with no events", () => {
  saveSchedule({ v: 1, fileName: "old.ics", importedAt: NOW, coverage: { start: 0, end: 9 }, busy: [[1, 2]] }, true);
  assert.equal(loadSchedule().fileName, "old.ics");
  assert.equal(eventsOf(loadSchedule()), null);
});
