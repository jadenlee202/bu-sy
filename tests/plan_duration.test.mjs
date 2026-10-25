import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequest } from "../web/js/recommend.js";

globalThis.location ??= { search: "" };
const { toMinutes, fromMinutes } = await import("../web/js/plan.js");

test("custom free time in hours converts to whole minutes", () => {
  assert.equal(toMinutes(1.5, "hours"), 90);
  assert.equal(toMinutes(2, "hours"), 120);
  assert.equal(toMinutes(0.75, "hours"), 45);
  assert.equal(toMinutes(1.33, "hours"), 80);           // rounds to the nearest minute
  assert.equal(toMinutes(45, "minutes"), 45);
  assert.ok(Number.isNaN(toMinutes(NaN, "hours")));
});

test("switching units keeps the same duration", () => {
  assert.equal(fromMinutes(90, "hours"), 1.5);
  assert.equal(fromMinutes(55, "hours"), 0.92);
  assert.equal(toMinutes(fromMinutes(55, "hours"), "hours"), 55);
  assert.equal(fromMinutes(90, "minutes"), 90);
});

test("zero, negative, fractional-minute and over-12-hour values stay invalid", () => {
  const minutesError = (minutes) => {
    const errs = validateRequest({ activity: "study", start: "15:00", minutes, mode: "duration" }, { activities: [{ id: "study" }], locations: [] });
    return Array.isArray(errs) ? errs.find((e) => e.field === "minutes") : errs?.minutes;
  };
  for (const [value, unit] of [[0, "hours"], [-1, "hours"], [45.5, "minutes"], [13, "hours"], [0.05, "hours"]]) {
    assert.ok(minutesError(toMinutes(value, unit)), `${value} ${unit} should be rejected`);
  }
  assert.ok(!minutesError(toMinutes(1.5, "hours")), "1.5 hours is valid");
});
