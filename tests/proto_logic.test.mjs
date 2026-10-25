import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../web/proto/logic.js";

// Pure helpers only: no DOM, storage, clock or network.
const H = 3_600_000;

test("durations read naturally", () => {
  assert.equal(L.durationText(45), "45 min");
  assert.equal(L.durationText(60), "1 hr");
  assert.equal(L.durationText(105), "1 hr 45 min");
});

test("now is rounded up to the next five minutes, never past midnight", () => {
  assert.equal(L.roundUp5(900), 900);
  assert.equal(L.roundUp5(901), 905);
  assert.equal(L.roundUp5(1439), 1439);
});

test("free now is the usable segment containing the current time", () => {
  const segs = [
    { start: 0, end: H, kind: "past" },
    { start: H, end: 2 * H, kind: "busy" },
    { start: 2 * H, end: 3 * H, kind: "available" },
    { start: 4 * H, end: 6 * H, kind: "available" },
  ];
  assert.deepEqual(L.freeNow(segs, 2.5 * H), segs[2]);
  assert.equal(L.freeNow(segs, 1.5 * H), null);
  assert.deepEqual(L.laterFree(segs, 2.5 * H), [segs[3]]);
  assert.equal(L.minutesBetween(2.5 * H, 3 * H), 30);
  assert.equal(L.minutesBetween(0, 20 * H), L.MAX_MINUTES);
});

test("the next event skips free and all-day entries", () => {
  const events = [
    { start: 5, end: 9, title: "All day", allDay: true },
    { start: 6, end: 7, title: "Free", free: true },
    { start: 8, end: 9, title: "Class" },
  ];
  assert.equal(L.nextEvent(events, 4).title, "Class");
  assert.equal(L.nextEvent(events, 9), null);
});

test("visit busyness reads as one level or the order it changes in; the icon takes the peak", () => {
  assert.deepEqual(L.visitWords({ visit: { segments: [{ level: "quiet" }] } }), { level: "quiet", text: "quiet", peak: "quiet" });
  assert.deepEqual(L.visitWords({ visit: { segments: [{ level: "quiet" }, { level: "unknown" }, { level: "busy" }] } }),
    { level: "quiet", text: "quiet, then busy", peak: "busy" });
  assert.deepEqual(L.visitWords({ visit: null, busy: { level: "unknown" } }), { level: "unknown", text: "no busyness data" });
});

test("the busyness icon fills one person per level and none when closed or unknown", () => {
  const filled = (svg) => (svg.match(/class="on"/g) ?? []).length;
  assert.equal(filled(L.busyIcon("quiet")), 1);
  assert.equal(filled(L.busyIcon("moderate")), 2);
  assert.equal(filled(L.busyIcon("busy")), 3);
  assert.equal(filled(L.busyIcon("closed")), 0);
  assert.equal(filled(L.busyIcon("unknown")), 0);
  assert.match(L.busyIcon("busy", "busy, simulated"), /role="img" aria-label="Busyness: busy, simulated"/);
  assert.equal(L.peakLevel(["quiet", "moderate", "quiet"]), "moderate");
  assert.equal(L.peakLevel([]), "unknown");
});

test("the busyness badge says the level in words and how full it is, never colour alone", () => {
  assert.equal(L.percentFull(280, 600), 47);
  assert.equal(L.percentFull(900, 870), 100);
  assert.equal(L.percentFull(null, 600), null);
  assert.equal(L.percentFull(10, 0), null);
  const busy = L.busyBadge("busy", { pct: 82, label: "busy, simulated" });
  assert.match(busy, /data-level="busy"/);
  assert.match(busy, />Busy<\/span>/);
  assert.match(busy, /82% full/);
  assert.match(busy, /aria-label="Busyness: busy, simulated"/);
  // No crowd figure without a level: closed and unknown never show a percentage.
  assert.doesNotMatch(L.busyBadge("closed", { pct: 40 }), /% full/);
  assert.match(L.busyBadge("unknown"), />No data<\/span>/);
  assert.match(L.busyBadge("quiet", { text: "quiet, then busy" }), />Quiet, then busy<\/span>/);
});

test("the quietest time is the lowest level still open today, then the emptiest", () => {
  const slots = [
    { minute: 600, open: true, level: "quiet", pct: 10 },
    { minute: 660, open: true, level: "busy", pct: 90 },
    { minute: 720, open: true, level: "moderate", pct: 50 },
    { minute: 780, open: true, level: "quiet", pct: 30 },
    { minute: 840, open: false, level: "closed", pct: null },
    { minute: 900, open: true, level: "quiet", pct: 20 },
  ];
  assert.equal(L.quietestFrom(slots, 0).minute, 600);
  assert.equal(L.quietestFrom(slots, 640).minute, 600);         // 10:40 is still inside the 10 AM hour
  assert.equal(L.quietestFrom(slots, 700).minute, 900);         // later: the emptiest quiet hour
  assert.equal(L.quietestFrom(slots.slice(1, 3), 0).minute, 720);
  assert.equal(L.quietestFrom(slots, 2000), null);              // nothing open is left today
  assert.equal(L.quietestFrom([{ minute: 600, open: true, level: "unknown", pct: null }], 0), null);
});

test("the engine request keeps defaults, then the sentence, then suggestion patches", () => {
  const req = L.buildRequest({ activity: "study", minutes: 60, from: "mugar", to: "", access: { library: "yes" }, patch: { minActivity: 25 } },
    { buffer: 10, minActivity: 30, preparation: 3 }, "15:00", "2026-10-19");
  assert.equal(req.to, null);
  assert.equal(req.minActivity, 25);
  assert.equal(req.buffer, 10);
  assert.equal(req.mode, "duration");
  assert.deepEqual(req.access, { library: "yes" });
});

test("suggestions change only what they name; a new activity drops old patches", () => {
  const s = { activity: "eat", minutes: 30, patch: { minActivity: 15 } };
  assert.deepEqual(L.applySuggestion(s, { minutes: 55 }), { activity: "eat", minutes: 55, patch: { minActivity: 15 } });
  assert.deepEqual(L.applySuggestion(s, { activity: "study", minActivity: 30, preparation: 3 }),
    { activity: "study", minutes: 30, patch: { minActivity: 30, preparation: 3 } });
});
