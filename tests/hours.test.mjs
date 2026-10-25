import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildingHoursSummary, campusDateTime, daySchedule, selectedBuildingStatus, selectedStatusLabel,
  serviceAtTime, serviceStatusLabel, weekStart,
} from "../web/js/hours.js";

const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));

test("Places status follows the selected slider time, not the current time", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-25";
  const closed = selectedBuildingStatus(marciano, date, 9 * 60 + 30);
  const open = selectedBuildingStatus(marciano, date, 12 * 60);

  assert.equal(selectedStatusLabel(closed), "Closed now");
  assert.equal(selectedStatusLabel(open), "Open now");
  assert.equal(buildingHoursSummary(marciano, date), "10:00 AM–9:00 PM");
});

test("Places reports unpublished dates without claiming an open or closed status", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const status = selectedBuildingStatus(marciano, "2026-10-31", 12 * 60);

  assert.equal(status.status, "unpublished");
  assert.equal(buildingHoursSummary(marciano, "2026-10-31"), "Today's hours not published");
});

test("Places date calculation uses Boston time across the UTC date boundary", () => {
  const campus = campusDateTime(new Date("2026-10-25T02:30:00Z"));

  assert.equal(campus.date, "2026-10-24");
  assert.equal(campus.weekday, "saturday");
  assert.equal(campus.minute, 22 * 60 + 30);
});

test("weekly date navigation starts on Monday and spans the selected date", () => {
  assert.equal(weekStart("2026-10-24"), "2026-10-19");
  assert.equal(weekStart("2026-10-19"), "2026-10-19");
});

test("special closures override recurring opening hours", () => {
  const fitrec = hours.locations["fitrec-synthetic"];

  assert.equal(daySchedule(fitrec, "2026-11-26").status, "closed");
  assert.equal(selectedBuildingStatus(fitrec, "2026-11-26", 12 * 60).status, "closed");
});

test("dining service is determined by selected date and slider time", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-24";
  for (const [minute, expected] of [
    [10 * 60, "Serving Breakfast"],
    [12 * 60, "Serving Lunch"],
    [18 * 60, "Serving Dinner"],
  ]) {
    const service = serviceAtTime(marciano, date, minute);
    const building = selectedBuildingStatus(marciano, date, minute);
    assert.equal(serviceStatusLabel(service, building), expected);
  }

  const sunday = "2026-10-25";
  const brunch = serviceAtTime(marciano, sunday, 11 * 60);
  assert.equal(serviceStatusLabel(brunch, selectedBuildingStatus(marciano, sunday, 11 * 60)), "Serving Brunch");

  const closed = selectedBuildingStatus(marciano, sunday, 21 * 60 + 30);
  assert.equal(serviceStatusLabel(serviceAtTime(marciano, sunday, 21 * 60 + 30), closed), "No meal service — building closed");
});
