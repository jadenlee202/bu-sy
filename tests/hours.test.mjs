import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { placeAvailability } from "../web/js/availability.js";
import {
  buildingHoursSummary, campusDateTime, daySchedule, displaySchedule, nowServiceLabel, nowStatus, nowText,
  openStatus, selectedBuildingStatus, selectedStatusLabel, serviceAtTime, serviceStatusLabel, weekStart,
} from "../web/js/hours.js";

const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));

test("Places status utility follows the selected time and summarizes building hours", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-25";
  const closed = selectedBuildingStatus(marciano, date, 9 * 60 + 30);
  const open = selectedBuildingStatus(marciano, date, 12 * 60);

  assert.equal(selectedStatusLabel(closed), "Closed");
  assert.equal(selectedStatusLabel(open), "Open");
  assert.equal(buildingHoursSummary(marciano, date), "10:00 AM–9:00 PM");
});

test("Places status reflects the selected playback time", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];
  const date = "2026-10-25";
  const closed = selectedBuildingStatus(marciano, date, 9 * 60 + 30);
  const open = selectedBuildingStatus(marciano, date, 12 * 60);

  // A chosen time is never described as "now".
  assert.equal(selectedStatusLabel(closed), "Closed");
  assert.equal(selectedStatusLabel(open), "Open");
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
  // An assumed (projected) day is never a definitive Open/Closed, only the summary is shown.
  assert.equal(selectedBuildingStatus(marciano, "2026-11-07", 12 * 60).status, "unverified");
  assert.equal(selectedBuildingStatus(marciano, "2026-11-07", 12 * 60).assumed, true);
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

test("an overnight period from an ASSUMED (unverified) prior day never shows open", () => {
  // SYNTHETIC FIXTURE: a late venue open 18:00 -> 02:00, published only for one week.
  const lateVenue = (effectiveThrough) => ({
    category: "fitness",
    buildingHours: {
      status: "verified", effectiveFrom: "2026-10-19", effectiveThrough, repeatsWeekly: true,
      weeklyHours: Object.fromEntries(
        ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
          .map((d) => [d, [{ label: "Building hours", start: "18:00", end: "02:00" }]]),
      ),
      specialHours: [],
    },
    serviceHours: { status: "not_applicable", weeklyHours: null, specialHours: [] },
  });

  // 01:00 on Oct 24 is inside the previous day's overnight period.
  // (a) When the prior day is VERIFIED (date within range), the carryover is open.
  const verified = lateVenue("2026-10-31");
  assert.equal(selectedBuildingStatus(verified, "2026-10-24", 60).status, "open");
  assert.equal(openStatus(verified, at("2026-10-24T01:00:00-04:00")).status, "open");

  // (b) When the prior day is ASSUMED (date outside the published range), it must NOT be open.
  const assumed = lateVenue("2026-10-20");   // Oct 23 (the prior day) is past the range -> assumed
  assert.equal(selectedBuildingStatus(assumed, "2026-10-24", 60).status, "unverified");
  assert.notEqual(openStatus(assumed, at("2026-10-24T01:00:00-04:00")).status, "open");
  // nowStatus already guards the current day; this confirms the carryover path agrees.
  assert.notEqual(nowStatus(assumed, at("2026-10-24T01:00:00-04:00")).label, "Open now");
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

// ---------- the real current time (Open now, "Now" on Places, "Right now" on place pages) ----------
const at = (iso) => new Date(iso);   // instants in Boston time (EDT is UTC−4 in October 2026)

test("now status: open, closed until later, closed for the rest of the day", () => {
  const marciano = hours.locations["marciano-dining-synthetic"];         // Sun Oct 25: 10:00 AM–9:00 PM
  assert.equal(nowText(nowStatus(marciano, at("2026-10-25T09:30:00-04:00"))), "Closed now · opens at 10:00 AM");
  assert.equal(nowText(nowStatus(marciano, at("2026-10-25T12:00:00-04:00"))), "Open now · until 9:00 PM");
  assert.equal(nowText(nowStatus(marciano, at("2026-10-25T21:30:00-04:00"))), "Closed now · closed for the rest of the day");
});

test("now status: special closed days, unverified and assumed hours are never \"Open now\"", () => {
  const fitrec = hours.locations["fitrec-synthetic"];
  assert.equal(nowStatus(fitrec, at("2026-11-26T12:00:00-05:00")).label, "Closed today", "Thanksgiving special hours");
  const mugar = hours.locations["mugar-synthetic"];
  // Mugar's General Hours are published for Oct 25-31 only (repeatsWeekly: false).
  assert.equal(nowStatus(mugar, at("2026-11-02T12:00:00-05:00")).label, "Hours unverified");
  const marciano = hours.locations["marciano-dining-synthetic"];
  const assumed = nowStatus(marciano, at("2026-11-08T12:00:00-05:00"));  // past the published week
  assert.deepEqual([assumed.status, assumed.label], ["unverified", "Hours unverified"]);
  assert.equal(nowServiceLabel(marciano, at("2026-11-08T12:00:00-05:00")), "Meal hours unverified");
});

test("dining: building status and meal service are separate; between meals the hall stays open", () => {
  const verified = (weekly) => ({ status: "verified", effectiveFrom: "2026-10-19", effectiveThrough: "2026-10-31", weeklyHours: weekly });
  const day = (periods) => Object.fromEntries(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((d) => [d, periods]));
  const hall = {
    buildingHours: verified(day([{ label: "Building hours", start: "08:00", end: "20:00" }])),
    serviceHours: verified(day([{ label: "Lunch", start: "11:00", end: "14:00" }, { label: "Dinner", start: "17:00", end: "20:00" }])),
  };
  const between = at("2026-10-27T15:00:00-04:00");
  assert.equal(nowStatus(hall, between).label, "Open now");
  assert.equal(nowServiceLabel(hall, between), "No meal service currently scheduled");
  assert.equal(nowServiceLabel(hall, at("2026-10-27T12:00:00-04:00")), "Serving lunch");
  assert.equal(nowServiceLabel(hall, at("2026-10-27T21:00:00-04:00")), "No meal service — building closed");
  // Open now (Places filter) agrees with the status every screen shows.
  assert.equal(placeAvailability(hall, "dining", "open_now", { now: between.getTime() }).result, "match");
  assert.equal(placeAvailability(hall, "dining", "open_now", { now: at("2026-10-27T21:00:00-04:00").getTime() }).result, "no");
  const marciano = hours.locations["marciano-dining-synthetic"];
  assert.equal(placeAvailability(marciano, "dining", "open_now", { now: at("2026-11-08T12:00:00-05:00").getTime() }).result, "unchecked",
    "assumed hours are listed as unchecked, not open");
});

