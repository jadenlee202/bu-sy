import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildingHoursSummary, daySchedule, openStatus, selectedBuildingStatus } from "../web/js/hours.js";
import { placeAvailability } from "../web/js/availability.js";
import { planningHours } from "../web/js/recommend.js";

const hours = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));
const mugar = hours.locations["mugar-synthetic"];
const place = { facility_id: "mugar-synthetic", hours: null };

test("Mugar stores the official October 25–31 General Hours, not desk hours", () => {
  assert.equal(mugar.lastVerified, "2026-10-25");
  assert.match(mugar.sourceUrl, /bu\.edu\/library\/visit-study\/hours/);
  const expected = [
    ["10:00", "02:00"], ["07:00", "02:00"], ["07:00", "02:00"],
    ["07:00", "02:00"], ["07:00", "02:00"], ["07:00", "23:00"], ["10:00", "23:00"],
  ];
  for (let i = 0; i < 7; i++) {
    const schedule = daySchedule(mugar, `2026-10-${25 + i}`);
    assert.equal(schedule.status, "scheduled");
    assert.deepEqual(schedule.periods.map(({ label, start, end }) => [label, start, end]),
      [["General Hours", ...expected[i]]]);
  }
  assert.match(buildingHoursSummary(mugar, "2026-10-26"), /2:00 AM \(next day\)/);
  for (const date of ["2026-10-24", "2026-11-01", "2026-11-26"]) {
    assert.equal(daySchedule(mugar, date).status, "unpublished");
    assert.equal(planningHours(place, { activity: "study", date }, hours).basis, "unknown");
  }
});

test("Mugar openings, overnight closings and Open Now agree in Boston local time", () => {
  for (const [date, clock, expected] of [
    ["2026-10-25", "09:59", "closed"], ["2026-10-25", "10:00", "open"],
    ["2026-10-25", "23:59", "open"], ["2026-10-26", "00:00", "open"],
    ["2026-10-26", "01:59", "open"], ["2026-10-26", "02:00", "closed"],
    ["2026-10-26", "06:59", "closed"], ["2026-10-26", "07:00", "open"],
    ["2026-10-30", "01:59", "open"], ["2026-10-30", "02:00", "closed"],
    ["2026-10-30", "22:59", "open"], ["2026-10-30", "23:00", "closed"],
    ["2026-10-31", "01:00", "closed"], ["2026-10-31", "09:59", "closed"],
    ["2026-10-31", "10:00", "open"], ["2026-10-31", "23:00", "closed"],
  ]) {
    const now = new Date(`${date}T${clock}:00-04:00`);
    const [h, m] = clock.split(":").map(Number);
    assert.equal(selectedBuildingStatus(mugar, date, h * 60 + m).status, expected, `${date} ${clock}`);
    assert.equal(openStatus(mugar, now).status === "open", expected === "open");
    assert.equal(placeAvailability(mugar, "library", "open_now", { now: now.getTime() }).result,
      expected === "open" ? "match" : "no");
    const planning = planningHours(place, { activity: "study", date }, hours);
    assert.equal(planning.basis, "verified");
    assert.equal(planning.segs.some(([start, end]) => h * 60 + m >= start && h * 60 + m < end), expected === "open");
  }
});

test("Mugar special schedules override weekly and overnight hours without inventing holidays", () => {
  // Fixtures exercise the existing exception format; these are not claimed as published BU dates.
  const fixture = structuredClone(hours);
  const location = fixture.locations["mugar-synthetic"];
  location.buildingHours.specialHours = [
    { date: "2026-10-26", status: "closed", periods: [] },
    { date: "2026-10-27", status: "open", periods: [{ label: "Test exception", start: "12:00", end: "16:00" }] },
  ];
  assert.equal(buildingHoursSummary(location, "2026-10-26"), "Closed today");
  for (const [date, clock, expected] of [
    ["2026-10-26", "01:00", "closed"], ["2026-10-26", "12:00", "closed"],
    ["2026-10-27", "07:00", "closed"], ["2026-10-27", "12:00", "open"],
    ["2026-10-27", "16:00", "closed"],
  ]) {
    const minute = Number(clock.slice(0, 2)) * 60;
    assert.equal(selectedBuildingStatus(location, date, minute).status, expected);
    assert.equal(openStatus(location, new Date(`${date}T${clock}:00-04:00`)).status === "open", expected === "open");
    const plan = planningHours(place, { activity: "study", date }, fixture);
    assert.equal(plan.segs.some(([start, end]) => minute >= start && minute < end), expected === "open");
  }
  assert.deepEqual(mugar.buildingHours.specialHours, []);
});
