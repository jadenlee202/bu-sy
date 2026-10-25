// Playback lookup used by every screen (web/js/clock.js). Must match server/analytics.py latest_at.
// Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { latestAt, obsOffset } from "../web/js/clock.js";

// SYNTHETIC FIXTURE: readings about every 10 minutes with a gap, offsets as the gym source writes them.
const obs = (t, n) => ({ observed_at: `2016-02-01T${t}-08:00`, occupancy_count: n });
const day = [obs("09:00:00", 10), obs("09:10:00", 0), obs("09:20:00", 20), obs("11:00:00", 30)];
const at = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

test("before the first reading there is no data", () => {
  assert.equal(latestAt(day, at("08:59"), "11:30:00", 30), null);
});

test("zero is a reading, not missing", () => {
  assert.equal(latestAt(day, at("09:15"), "11:30:00", 30).occupancy_count, 0);
});

test("a reading stands for at most the hold time; a longer gap is no data", () => {
  assert.equal(latestAt(day, at("09:50"), "11:30:00", 30).occupancy_count, 20);
  assert.equal(latestAt(day, at("09:51"), "11:30:00", 30), null);
  assert.equal(latestAt(day, at("09:51"), "11:30:00").occupancy_count, 20); // no rule (COD): held
});

test("after the recording ends there is no data", () => {
  assert.equal(latestAt(day, at("11:30"), "11:30:00", 30).occupancy_count, 30);
  assert.equal(latestAt(day, at("11:31"), "11:30:00", 30), null);
});

test("the supplied UTC offset is read as written; none is invented", () => {
  assert.equal(obsOffset(day[0]), "-08:00");
  assert.equal(obsOffset({ observed_at: "2015-11-09T07:00:00" }), null);
});
