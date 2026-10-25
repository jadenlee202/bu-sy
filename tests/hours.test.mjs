import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildingHoursSummary, campusDateTime, daySchedule, displaySchedule, selectedBuildingStatus, selectedStatusLabel,
  serviceAtTime, serviceStatusLabel, weekStart,
} from "../web/js/hours.js";

const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));

test("Places status utility follows the selected time and summarizes building hours", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-25";
  const closed = selectedBuildingStatus(marciano, date, 9 * 60 + 30);
  const open = selectedBuildingStatus(marciano, date, 12 * 60);

  assert.equal(selectedStatusLabel(closed), "Closed now");
  assert.equal(selectedStatusLabel(open), "Open now");
  assert.equal(buildingHoursSummary(marciano, date), "10:00 AM–9:00 PM");
});

test("Places status reflects the selected playback time", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-25";
  const closed = selectedBuildingStatus(marciano, date, 9 * 60 + 30);
  const open = selectedBuildingStatus(marciano, date, 12 * 60);

  assert.equal(selectedStatusLabel(closed), "Closed now");
  assert.equal(selectedStatusLabel(open), "Open now");
});

test("Places reports unpublished dates without claiming an open or closed status", () => {
  // Fenway's schedule says not to apply it beyond its published week.
  const fenway = hours.locations["fenway-dining-synthetic"];
  const status = selectedBuildingStatus(fenway, "2026-10-26", 12 * 60);

  assert.equal(status.status, "unpublished");
  assert.equal(buildingHoursSummary(fenway, "2026-10-26"), "Today's hours not published");
});

test("weekly hours repeat beyond the published dates and are marked assumed", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const published = daySchedule(marciano, "2026-10-24");
  const nextWeek = daySchedule(marciano, "2026-11-07");
  const weekBefore = daySchedule(marciano, "2026-10-17");

  assert.equal(published.assumed, undefined);
  assert.equal(nextWeek.status, "scheduled");
  assert.equal(nextWeek.assumed, true);
  assert.deepEqual(nextWeek.periods, published.periods);
  assert.deepEqual(weekBefore.periods, published.periods);
  assert.equal(buildingHoursSummary(marciano, "2026-11-07"), "9:00 AM–9:00 PM (assumed)");
  assert.equal(selectedBuildingStatus(marciano, "2026-11-07", 12 * 60).status, "open");
  assert.deepEqual(displaySchedule(marciano, "2026-11-07", "dining").periods.map(({ label }) => label),
    ["Breakfast", "Lunch", "Dinner"]);
});

test("special hours override assumed weekly hours, and in-range dates are not assumed", () => {
  const fitrec = hours.locations["fitrec-synthetic"];
  // Thanksgiving closure (special) wins inside the range; after Dec 10 the week repeats.
  assert.equal(daySchedule(fitrec, "2026-11-26").status, "closed");
  assert.equal(daySchedule(fitrec, "2026-11-26").assumed, undefined);
  const afterSemester = daySchedule(fitrec, "2026-12-14");
  assert.equal(afterSemester.assumed, true);
  assert.deepEqual(afterSemester.periods, daySchedule(fitrec, "2026-12-07").periods);

  const later = structuredClone(fitrec);
  later.buildingHours.specialHours.push({ date: "2026-12-14", status: "closed", note: "Winter break", periods: [] });
  assert.equal(daySchedule(later, "2026-12-14").status, "closed");
  assert.equal(daySchedule(later, "2026-12-14").assumed, undefined);
});

test("a schedule marked repeatsWeekly false stays unpublished outside its dates", () => {
  const fenway = hours.locations["fenway-dining-synthetic"];
  assert.equal(daySchedule(fenway, "2026-10-25").status, "scheduled");
  assert.equal(daySchedule(fenway, "2026-10-26").status, "unpublished");
  assert.equal(displaySchedule(fenway, "2026-10-26", "dining").status, "unpublished");
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
    [10 * 60, "Serving breakfast"],
    [12 * 60, "Serving lunch"],
    [18 * 60, "Serving dinner"],
  ]) {
    const service = serviceAtTime(marciano, date, minute);
    const building = selectedBuildingStatus(marciano, date, minute);
    assert.equal(serviceStatusLabel(service, building), expected);
  }

  const sunday = "2026-10-25";
  const brunch = serviceAtTime(marciano, sunday, 11 * 60);
  assert.equal(serviceStatusLabel(brunch, selectedBuildingStatus(marciano, sunday, 11 * 60)), "Serving brunch");

  const closed = selectedBuildingStatus(marciano, sunday, 21 * 60 + 30);
  assert.equal(serviceStatusLabel(serviceAtTime(marciano, sunday, 21 * 60 + 30), closed), "No meal service — building closed");
});

// Meal status against the official BU Dining "Upcoming Hours" (checked 2026-10-25 for Oct 25-31).
const mealAt = (location, date, hhmm) => {
  const minute = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  return serviceStatusLabel(serviceAtTime(location, date, minute), selectedBuildingStatus(location, date, minute));
};

test("dining meal status follows BU's published breakfast, lunch and dinner boundaries", () => {
  const warren = hours.locations["warren-dining-synthetic"];
  const monday = "2026-10-26";   // Breakfast 7-11, Lunch 11-5, Dinner 5-10
  for (const [time, expected] of [
    ["06:59", "No meal service — building closed"], ["07:00", "Serving breakfast"], ["10:59", "Serving breakfast"],
    ["11:00", "Serving lunch"], ["16:59", "Serving lunch"], ["17:00", "Serving dinner"], ["21:59", "Serving dinner"],
    ["22:00", "No meal service — building closed"],
  ]) assert.equal(mealAt(warren, monday, time), expected, `Warren ${monday} ${time}`);
  // Marciano's dinner ends an hour earlier than Warren's on weekdays.
  assert.equal(mealAt(hours.locations["marciano-dining-synthetic"], monday, "21:30"), "No meal service — building closed");
  assert.equal(mealAt(hours.locations["west-dining-synthetic"], monday, "21:30"), "Serving dinner");
});

test("brunch is named brunch, and Saturday and Halloween use their own published hours", () => {
  const warren = hours.locations["warren-dining-synthetic"];
  assert.equal(mealAt(warren, "2026-10-25", "10:00"), "Serving brunch");     // Sunday: Brunch 10-4, Dinner 4-9
  assert.equal(mealAt(warren, "2026-10-25", "15:59"), "Serving brunch");
  assert.equal(mealAt(warren, "2026-10-25", "16:00"), "Serving dinner");
  assert.equal(mealAt(warren, "2026-10-25", "09:30"), "No meal service — building closed");
  assert.equal(mealAt(warren, "2026-10-31", "08:30"), "No meal service — building closed");   // Saturday opens at 9
  assert.equal(mealAt(warren, "2026-10-31", "09:00"), "Serving breakfast");
  assert.equal(mealAt(warren, "2026-10-31", "17:00"), "Serving dinner");
});

test("Fenway's named services keep their own names", () => {
  const fenway = hours.locations["fenway-dining-synthetic"];
  assert.equal(mealAt(fenway, "2026-10-23", "10:30"), "Serving continental breakfast");
  assert.equal(mealAt(fenway, "2026-10-23", "14:00"), "Serving light lunch");
  assert.equal(mealAt(fenway, "2026-10-22", "21:00"), "Serving light dinner");
  assert.equal(mealAt(fenway, "2026-10-24", "12:00"), "Serving brunch");        // weekend: brunch, not lunch
});

test("no meal status without published meal hours for that date", () => {
  const warren = hours.locations["warren-dining-synthetic"];
  assert.equal(serviceAtTime(warren, "2026-11-02", 12 * 60).status, "unpublished");     // weekly pattern only assumed
  assert.doesNotMatch(mealAt(warren, "2026-11-02", "12:00"), /^Serving/);
  assert.doesNotMatch(mealAt(hours.locations["fenway-dining-synthetic"], "2026-10-26", "12:00"), /^Serving/);
  assert.equal(serviceAtTime(hours.locations["fitrec-synthetic"], "2026-10-26", 12 * 60).status, "not_applicable");
});

test("an open hall between meal periods says no meal service is scheduled", () => {
  const hall = {   // SYNTHETIC FIXTURE: open 7-22 with a gap between breakfast and lunch
    buildingHours: { status: "verified", effectiveFrom: "2026-10-26", effectiveThrough: "2026-10-26",
      weeklyHours: { monday: [{ label: "Building hours", start: "07:00", end: "22:00" }] } },
    serviceHours: { status: "verified", effectiveFrom: "2026-10-26", effectiveThrough: "2026-10-26",
      weeklyHours: { monday: [{ label: "Breakfast", start: "07:00", end: "10:00" }, { label: "Lunch", start: "12:00", end: "14:00" }] } },
  };
  assert.equal(mealAt(hall, "2026-10-26", "11:00"), "No meal service currently scheduled");
  assert.equal(mealAt(hall, "2026-10-26", "12:00"), "Serving lunch");
});

test("dining weekly display uses named service periods while non-dining keeps building hours", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const fitrec = hours.locations["fitrec-synthetic"];
  const saturdayMeals = displaySchedule(marciano, "2026-10-24", "dining");
  const sundayMeals = displaySchedule(marciano, "2026-10-25", "dining");
  const building = displaySchedule(fitrec, "2026-10-24", "fitness");

  assert.deepEqual(saturdayMeals.periods.map(({ label }) => label), ["Breakfast", "Lunch", "Dinner"]);
  assert.deepEqual(sundayMeals.periods.map(({ label }) => label), ["Brunch", "Dinner"]);
  assert.deepEqual(building.periods.map(({ label }) => label), ["Building hours"]);
  assert.equal(displaySchedule(hours.locations["fenway-dining-synthetic"], "2026-11-01", "dining").status, "unpublished");
});
