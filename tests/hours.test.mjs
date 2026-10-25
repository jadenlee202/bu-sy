import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildingHoursSummary, campusDateTime, selectedBuildingStatus, selectedStatusLabel,
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
