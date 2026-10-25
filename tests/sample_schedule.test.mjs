import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLE_DATES, SAMPLE_EVENTS, SAMPLE_ZONE, sampleBusyForDay, sampleEventsForDay } from "../web/js/sample-schedule.js";
import { freeWindows, normalizeBusy, usableWindows, zonedInstant } from "../web/js/availability.js";

test("preview covers the supplied Sunday–Saturday week in Boston time", () => {
  assert.equal(SAMPLE_ZONE, "America/New_York");
  assert.equal(SAMPLE_DATES[0], "2026-10-25");
  assert.equal(SAMPLE_DATES[6], "2026-10-31");
  assert.equal(SAMPLE_DATES.length, 7);
  assert.ok(SAMPLE_DATES.every(date => sampleEventsForDay(date).length));
  assert.equal(sampleEventsForDay("2026-10-24").length, 0);
});

test("explicit screenshot times are retained and cropped ends are flagged estimates", () => {
  const lunch = sampleEventsForDay("2026-10-26").find(event => event.title === "Lunch");
  assert.deepEqual([lunch.start, lunch.end, lunch.estimatedEnd], ["13:30", "14:15", false]);
  const firstClass = sampleEventsForDay("2026-10-27").find(event => event.title === "CDSDS 109");
  assert.deepEqual([firstClass.start, firstClass.end], ["11:00", "12:15"]);
  assert.equal(firstClass.location, "665 Commonwealth Avenue · CDS 164");
  for (const event of SAMPLE_EVENTS.filter(event => event.estimatedEnd)) {
    const length = zonedInstant(event.date, event.end, SAMPLE_ZONE) - zonedInstant(event.date, event.start, SAMPLE_ZONE);
    assert.equal(length / 60000, event.title === "Code Review for 110" ? 15 : 50);
  }
});

test("sample busy intervals use screenshot GMT-04 and never include personal event fields", () => {
  const [event] = sampleBusyForDay("2026-10-25");
  assert.deepEqual(event, {start: "2026-10-25T15:00:00.000Z", end: "2026-10-25T18:00:00.000Z"});
  assert.deepEqual(Object.keys(event).sort(), ["end", "start"]);
  assert.deepEqual(sampleBusyForDay("2026-11-01"), []);
});

test("Monday's sample drives shared-engine free windows, independent of today's clock", () => {
  const date = "2026-10-26";
  const from = zonedInstant(date,"08:00",SAMPLE_ZONE), until = zonedInstant(date,"22:00",SAMPLE_ZONE);
  const free = usableWindows(freeWindows(sampleBusyForDay(date), from, until),30,-Infinity);
  assert.equal(free.reduce((sum,event) => sum+(event.end-event.start)/60000,0),535);
  assert.deepEqual(free.map(event => [event.start,event.end]), [
    [zonedInstant(date,"08:00",SAMPLE_ZONE),zonedInstant(date,"11:15",SAMPLE_ZONE)],
    [zonedInstant(date,"15:20",SAMPLE_ZONE),zonedInstant(date,"20:00",SAMPLE_ZONE)],
    [zonedInstant(date,"21:00",SAMPLE_ZONE),zonedInstant(date,"22:00",SAMPLE_ZONE)],
  ]);
});

test("Wednesday's overlapping evening commitments are merged without double counting", () => {
  const date="2026-10-28";
  const busy = normalizeBusy(sampleBusyForDay(date),zonedInstant(date,"18:00",SAMPLE_ZONE),zonedInstant(date,"22:00",SAMPLE_ZONE));
  assert.deepEqual(busy,[{start:zonedInstant(date,"18:30",SAMPLE_ZONE),end:zonedInstant(date,"21:30",SAMPLE_ZONE)}]);
});

test("Saturday holiday does not erase free time; estimated code review still blocks time", () => {
  const date="2026-10-31";
  assert.equal(sampleBusyForDay(date).length,1);
  assert.equal(sampleEventsForDay(date).find(event=>event.title==="Halloween").blocksTime,false);
  const free=freeWindows(sampleBusyForDay(date),zonedInstant(date,"08:00",SAMPLE_ZONE),zonedInstant(date,"22:00",SAMPLE_ZONE));
  assert.equal(free.reduce((n,event)=>n+(event.end-event.start)/60000,0),825);
});
