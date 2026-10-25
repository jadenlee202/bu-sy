import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { freeWindows, matchFreeWindows, normalizeBusy, zonedInstant } from "../web/js/availability.js";

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
