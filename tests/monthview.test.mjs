import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseIcs } from "../web/js/ics.js";
import { eventsByDay, monthCells, monthTitle, rangeText, shiftMonth, timeOnDay, weekdayNames } from "../web/js/monthview.js";

const TZ = "America/New_York";
const parse = (name) => parseIcs(readFileSync(new URL(`./fixtures/ics/${name}`, import.meta.url), "utf8"),
  { from: Date.parse("2026-09-01T00:00:00Z"), until: Date.parse("2027-06-01T00:00:00Z") }).items;
const titlesOn = (byDay, date) => (byDay.get(date) ?? []).map(({ event }) => event.title);

test("month grid is whole Sunday–Saturday weeks by default, marking adjacent-month days", () => {
  const cells = monthCells("2026-10");                       // Oct 1, 2026 is a Thursday
  assert.deepEqual(weekdayNames(), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.equal(cells.length % 7, 0);
  assert.equal(cells[0].date, "2026-09-27");                 // a Sunday
  assert.equal(cells.at(-1).date, "2026-10-31");             // a Saturday: no November days needed
  assert.deepEqual(cells.filter((c) => c.inMonth).map((c) => c.date).slice(0, 2), ["2026-10-01", "2026-10-02"]);
  assert.equal(cells.filter((c) => c.inMonth).length, 31);
  assert.equal(monthCells("2026-11").length, 35, "Nov 2026 starts on a Sunday");
  assert.equal(monthCells("2026-11")[0].date, "2026-11-01");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(monthTitle("2026-10"), "October 2026");
});

test("a Monday week start shifts the grid and the headings", () => {
  const cells = monthCells("2026-10", 1);
  assert.deepEqual(weekdayNames(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(cells[0].date, "2026-09-28");                 // a Monday
  assert.equal(cells.at(-1).date, "2026-11-01");             // a Sunday
  assert.equal(monthCells("2027-02", 1).length, 28, "Feb 2027 starts on a Monday and fills exactly 4 weeks");
  for (const weekStart of [0, 1]) {
    const days = monthCells("2026-10", weekStart).map((c) => new Date(`${c.date}T12:00:00Z`).getUTCDay());
    assert.ok(days.every((day, i) => day === (weekStart + i) % 7), `columns line up for weekStart ${weekStart}`);
  }
});

test("recurring classes land on their dates and times, honouring exceptions", () => {
  const byDay = eventsByDay(parse("weekly-class.ics"), "2026-10-01", "2026-11-30", TZ);
  assert.deepEqual(titlesOn(byDay, "2026-10-20"), ["CS 111 Lecture (sample)"]);
  assert.deepEqual(titlesOn(byDay, "2026-10-13"), [], "EXDATE");
  assert.deepEqual(titlesOn(byDay, "2026-10-27"), [], "cancelled");
  assert.deepEqual(titlesOn(byDay, "2026-10-22"), ["CS 111 Lecture (moved)"]);
  // 9:30 AM local on both sides of the DST change.
  assert.equal(timeOnDay(byDay.get("2026-10-20")[0], TZ), "9:30 AM");
  assert.equal(timeOnDay(byDay.get("2026-11-03")[0], TZ), "9:30 AM");
  assert.equal(rangeText(byDay.get("2026-10-22")[0].event, TZ), "Thu, Oct 22 · 11:00 AM – 12:15 PM EDT");
});

test("all-day, overnight and multi-day events appear on every date they cover", () => {
  const byDay = eventsByDay(parse("all-day-and-overnight.ics"), "2026-10-26", "2026-11-12", TZ);
  assert.deepEqual(titlesOn(byDay, "2026-10-28"), ["Field trip (busy all day)"]);
  assert.deepEqual(titlesOn(byDay, "2026-10-29"), ["Midterm week reminder"], "an all-day event ending at midnight stays on one date");
  const late = (date) => byDay.get(date).find(({ event }) => event.title === "Late lab");
  assert.equal(timeOnDay(late("2026-10-30"), TZ), "From 11:00 PM");
  assert.equal(timeOnDay(late("2026-10-31"), TZ), "Until 1:30 AM");
  const trip = ["2026-11-05", "2026-11-06", "2026-11-07"].map((d) => byDay.get(d).find(({ event }) => event.title === "Conference trip"));
  assert.deepEqual(trip.map((e) => timeOnDay(e, TZ)), ["From 6:00 PM", "All day (continues)", "Until 9:00 AM"]);
  assert.equal(rangeText(trip[0].event, TZ), "Thu, Nov 5, 6:00 PM – Sat, Nov 7, 9:00 AM EST");
  assert.equal(rangeText(byDay.get("2026-10-28")[0].event, TZ), "Wed, Oct 28 · All day");
  assert.deepEqual(titlesOn(byDay, "2026-11-10").sort(), ["Overlap A", "Overlap B"], "overlapping events are both listed");
});

test("dates follow the display timezone for timed events", () => {
  const items = parse("single-events.ics");
  const ny = eventsByDay(items, "2026-10-20", "2026-10-21", TZ);
  const tokyo = eventsByDay(items, "2026-10-20", "2026-10-22", "Asia/Tokyo");
  // The UTC event at 17:00Z is Oct 20 in Boston but Oct 21 (2 AM) in Tokyo.
  assert.ok(titlesOn(ny, "2026-10-20").includes("UTC event"));
  assert.ok(titlesOn(tokyo, "2026-10-21").includes("UTC event"));
});
