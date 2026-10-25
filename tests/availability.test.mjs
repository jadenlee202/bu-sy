import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  daySegments, findOpportunities, freeWindows, matchFreeWindows, normalizeBusy, placeAvailability, usableWindows,
  zonedInstant,
} from "../web/js/availability.js";

const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));
const marciano = { ...hours.locations["marciano-dining-synthetic"], category: "dining" };

test("normalizes overlapping and adjacent busy blocks without double-counting", () => {
  const start = Date.parse("2026-10-24T08:00:00-04:00");
  const end = Date.parse("2026-10-24T12:00:00-04:00");
  const busy = normalizeBusy([
    { start: "2026-10-24T09:00:00-04:00", end: "2026-10-24T10:00:00-04:00" },
    { start: "2026-10-24T09:30:00-04:00", end: "2026-10-24T10:30:00-04:00" },
    { start: "2026-10-24T10:30:00-04:00", end: "2026-10-24T11:00:00-04:00" },
  ], start, end);

  assert.equal(busy.length, 1);
  assert.deepEqual(freeWindows(busy, start, end).map(({ start: from, end: to }) => [from, to]), [
    [start, Date.parse("2026-10-24T09:00:00-04:00")],
    [Date.parse("2026-10-24T11:00:00-04:00"), end],
  ]);
});

test("clips events crossing midnight into the selected day's window", () => {
  const start = zonedInstant("2026-10-25", "08:00", "America/New_York");
  const end = zonedInstant("2026-10-25", "22:00", "America/New_York");
  const free = freeWindows([{
    start: "2026-10-24T23:30:00-04:00",
    end: "2026-10-25T09:00:00-04:00",
  }], start, end);

  assert.deepEqual(free, [
    { start: zonedInstant("2026-10-25", "09:00", "America/New_York"), end },
  ]);
});

test("empty calendar produces a free window bounded by preferred hours", () => {
  const start = zonedInstant("2026-10-24", "08:00", "America/New_York");
  const end = zonedInstant("2026-10-24", "22:00", "America/New_York");
  assert.deepEqual(freeWindows([], start, end), [{ start, end }]);
});

test("uses daylight-saving offsets to convert the selected local date", () => {
  assert.equal(
    new Date(zonedInstant("2026-03-08", "08:00", "America/New_York")).toISOString(),
    "2026-03-08T12:00:00.000Z",
  );
  assert.equal(
    new Date(zonedInstant("2026-11-01", "08:00", "America/New_York")).toISOString(),
    "2026-11-01T13:00:00.000Z",
  );
});

test("intersects free time with verified building and meal-service periods", () => {
  const lunch = {
    start: zonedInstant("2026-10-24", "12:00", "America/New_York"),
    end: zonedInstant("2026-10-24", "13:00", "America/New_York"),
  };

  assert.deepEqual(matchFreeWindows([lunch], marciano, "2026-10-24", 30).matches.map(({ label }) => [label]), [["Lunch"]]);
  assert.equal(matchFreeWindows([lunch], marciano, "2026-10-24", 75).matches.length, 0);
});

test("matches retail/free time to building hours and dining time to brunch periods", () => {
  const fitrec = { ...hours.locations["fitrec-synthetic"], category: "fitness" };
  const early = [{
    start: zonedInstant("2026-10-24", "07:00", "America/New_York"),
    end: zonedInstant("2026-10-24", "09:00", "America/New_York"),
  }];
  const sundayBrunch = [{
    start: zonedInstant("2026-10-25", "11:00", "America/New_York"),
    end: zonedInstant("2026-10-25", "12:00", "America/New_York"),
  }];

  assert.deepEqual(matchFreeWindows(early, fitrec, "2026-10-24", 30).matches.map(({ label }) => label), ["Open"]);
  assert.deepEqual(matchFreeWindows(sundayBrunch, marciano, "2026-10-25", 30).matches.map(({ label }) => label), ["Brunch"]);
});

test("does not match a dining meal when the building is closed or hours are unpublished", () => {
  const closedLocation = structuredClone(marciano);
  closedLocation.buildingHours.weeklyHours.saturday = [];
  const free = [{
    start: zonedInstant("2026-10-24", "12:00", "America/New_York"),
    end: zonedInstant("2026-10-24", "13:00", "America/New_York"),
  }];

  assert.equal(matchFreeWindows(free, closedLocation, "2026-10-24", 15).matches.length, 0);
  assert.equal(matchFreeWindows(free, marciano, "2026-10-31", 15).status, "unpublished");
});

test("usable windows drop gaps under the minimum and time that has already passed", () => {
  const at = (hhmm) => zonedInstant("2026-10-24", hhmm, "America/New_York");
  const free = [{ start: at("09:00"), end: at("09:20") }, { start: at("10:00"), end: at("12:00") }];

  assert.deepEqual(usableWindows(free, 30), [{ start: at("10:00"), end: at("12:00") }]);
  assert.deepEqual(usableWindows(free, 30, at("11:00")), [{ start: at("11:00"), end: at("12:00") }]);
  assert.deepEqual(usableWindows(free, 30, at("11:45")), []);
});

test("day segments label busy, available, too-short and past time without overlap", () => {
  const at = (hhmm) => zonedInstant("2026-10-24", hhmm, "America/New_York");
  const busy = [
    { start: "2026-10-24T09:00:00-04:00", end: "2026-10-24T10:00:00-04:00" },
    { start: "2026-10-24T10:10:00-04:00", end: "2026-10-24T11:00:00-04:00" },
  ];
  const segments = daySegments(busy, at("08:00"), at("13:00"), 30, at("08:40"));

  assert.deepEqual(segments.map(({ kind }) => kind), ["past", "short", "busy", "short", "busy", "available"]);
  assert.equal(segments.reduce((sum, { start, end }) => sum + end - start, 0), at("13:00") - at("08:00"));
});

test("a closed date reports closed instead of an empty match", () => {
  const closedLocation = structuredClone(marciano);
  closedLocation.buildingHours.weeklyHours.saturday = [];
  const free = [{
    start: zonedInstant("2026-10-24", "12:00", "America/New_York"),
    end: zonedInstant("2026-10-24", "13:00", "America/New_York"),
  }];

  assert.equal(matchFreeWindows(free, closedLocation, "2026-10-24", 15).status, "closed");
});

test("building hours that run past midnight from the previous day still match", () => {
  const lateFitrec = { ...structuredClone(hours.locations["fitrec-synthetic"]), category: "fitness" };
  lateFitrec.buildingHours.weeklyHours.friday = [{ label: "Building hours", start: "20:00", end: "02:00" }];
  const free = [{
    start: zonedInstant("2026-10-24", "00:30", "America/New_York"),
    end: zonedInstant("2026-10-24", "01:30", "America/New_York"),
  }];

  assert.deepEqual(matchFreeWindows(free, lateFitrec, "2026-10-24", 30).matches, [{ ...free[0], label: "Open" }]);
});

test("free time in a timezone ahead of campus is matched against campus hours", () => {
  // 17:00–18:00 in London on Oct 24 is 13:00–14:00 on campus: lunch at Marciano.
  const free = [{
    start: zonedInstant("2026-10-24", "17:00", "Europe/London"),
    end: zonedInstant("2026-10-24", "18:00", "Europe/London"),
  }];

  assert.deepEqual(matchFreeWindows(free, marciano, "2026-10-24", 30).matches.map(({ label }) => label), ["Lunch"]);
});

const searchOptions = { timezone: "America/New_York", from: "08:00", until: "22:00", minimum: 30 };
// Busy all day on Friday Oct 23, then busy except 12:15-12:55 on Saturday Oct 24.
const weekBusy = [
  { start: "2026-10-23T08:00:00-04:00", end: "2026-10-23T22:00:00-04:00" },
  { start: "2026-10-24T08:00:00-04:00", end: "2026-10-24T12:15:00-04:00" },
  { start: "2026-10-24T12:55:00-04:00", end: "2026-10-24T22:00:00-04:00" },
];

test("next opportunity skips a fully busy day and finds the next meal window", () => {
  const { matches, outcomes } = findOpportunities(weekBusy, marciano, "2026-10-23", 2, searchOptions);

  assert.deepEqual(outcomes.map(({ reason }) => reason), ["no_free_time", "match"]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].date, "2026-10-24");
  assert.equal(matches[0].start, Date.parse("2026-10-24T12:15:00-04:00"));
  assert.equal(matches[0].end, Date.parse("2026-10-24T12:55:00-04:00"));
});

test("meal filter and minimum duration both apply to the search", () => {
  const dinner = findOpportunities(weekBusy, marciano, "2026-10-24", 1, { ...searchOptions, meal: "dinner" });
  assert.deepEqual(dinner.matches, []);
  assert.deepEqual(dinner.outcomes.map(({ reason }) => reason), ["meal_not_served"]);

  const long = findOpportunities(weekBusy, marciano, "2026-10-24", 1, { ...searchOptions, minimum: 45 });
  assert.deepEqual(long.outcomes.map(({ reason }) => reason), ["no_free_time"]);
});

test("search ignores time that has passed and reports unpublished dates", () => {
  const afterLunch = Date.parse("2026-10-24T13:00:00-04:00");
  const today = findOpportunities(weekBusy, marciano, "2026-10-24", 1, { ...searchOptions, now: afterLunch });
  assert.deepEqual(today.outcomes.map(({ reason }) => reason), ["no_free_time"]);

  const outside = findOpportunities([], marciano, "2026-10-31", 1, searchOptions);
  assert.deepEqual(outside.outcomes.map(({ reason }) => reason), ["unpublished"]);
  assert.deepEqual(outside.matches, []);
});

test("an empty calendar is matched only within the location's verified hours", () => {
  const fitrec = { ...hours.locations["fitrec-synthetic"], category: "fitness" };
  const { matches } = findOpportunities([], fitrec, "2026-10-24", 1, { ...searchOptions, from: "06:00", until: "23:30" });

  // Saturday building hours are 08:00-22:00, so free time outside them is never offered.
  assert.deepEqual(matches.map(({ start, end }) => [start, end]), [[
    Date.parse("2026-10-24T08:00:00-04:00"), Date.parse("2026-10-24T22:00:00-04:00"),
  ]]);
});

const mugar = hours.locations["mugar-synthetic"];
const filterContext = { ...searchOptions, date: "2026-10-24", busy: weekBusy };

test("open-now filter uses verified hours and flags unverified places instead of hiding them", () => {
  const noon = Date.parse("2026-10-24T12:00:00-04:00");
  const late = Date.parse("2026-10-24T21:30:00-04:00");

  assert.equal(placeAvailability(marciano, "dining", "open_now", { now: noon }).result, "match");
  assert.equal(placeAvailability(marciano, "dining", "open_now", { now: late }).result, "no");
  assert.equal(placeAvailability(mugar, "library", "open_now", { now: noon }).result, "unchecked");
});

test("free-time filters match building hours, meals, and only dining for meals", () => {
  const fitrec = hours.locations["fitrec-synthetic"];
  const open = placeAvailability(fitrec, "fitness", "free", filterContext);
  assert.equal(open.result, "match");
  assert.equal(open.match.start, Date.parse("2026-10-24T12:15:00-04:00"));

  assert.equal(placeAvailability(marciano, "dining", "lunch", filterContext).result, "match");
  assert.equal(placeAvailability(marciano, "dining", "dinner", filterContext).result, "no");
  assert.equal(placeAvailability(fitrec, "fitness", "lunch", filterContext).result, "no");
  assert.equal(placeAvailability(marciano, "dining", "free", { ...filterContext, minimum: 45 }).result, "no");
});

test("free-time filters report unverified or unpublished hours as unchecked", () => {
  assert.equal(placeAvailability(mugar, "library", "free", filterContext).result, "unchecked");
  assert.equal(placeAvailability(marciano, "dining", "lunch", { ...filterContext, date: "2026-10-31", busy: [] }).result, "unchecked");
});
