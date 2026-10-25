import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../web/app/logic.js";

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

test("the busyness icon fills one bar per level and none when closed or unknown", () => {
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

test("walking time is estimated on the device from the straight line", () => {
  const mugar = { lat: 42.351012, lon: -71.107992 }, warren = { lat: 42.349224, lon: -71.10312 };
  const d = L.distanceM(mugar, warren);
  assert.ok(d > 430 && d < 465, `Mugar to Warren is ~447 m, got ${d}`);
  assert.equal(L.walkMinutes(d), Math.ceil((d * 1.2) / 84));
  assert.equal(L.walkMinutes(0), 1);                          // never a zero-minute walk
});

test("the engine sees 'your location' with a walk to every building that has coordinates", () => {
  const campus = { locations: [{ id: "mugar", name: "Mugar" }, { id: "fenway", name: "Fenway" }], travel: [{ from_id: "mugar", to_id: "fenway", minutes: 20 }] };
  const c = L.campusFrom(campus, { lat: 42.351012, lon: -71.107992 }, { mugar: { lat: 42.351012, lon: -71.107992 } });
  assert.ok(c.locations.some((l) => l.id === L.HERE));
  assert.deepEqual(c.travel.filter((t) => t.from_id === L.HERE), [{ from_id: L.HERE, to_id: "mugar", minutes: 1 }]);   // Fenway: no coordinates, no walk
  assert.equal(campus.locations.length, 2);                   // the published campus is not changed
});

test("the engine request is walk + activity: no next stop, buffer, setup or pack-up", () => {
  const req = L.buildRequest({ activity: "study", minutes: 60, from: "mugar", access: { library: "yes" }, patch: { minActivity: 25 } },
    { buffer: 10, minActivity: 30, preparation: 3, cleanup: 2 }, "15:00", "2026-10-19");
  assert.equal(req.to, null);
  assert.equal(req.minActivity, 25);
  assert.equal(req.buffer, 0);
  assert.equal(req.preparation, 0);
  assert.equal(req.cleanup, 0);
  assert.equal(req.mode, "duration");
  assert.deepEqual(req.access, { library: "yes" });
});

test("suggestions change only what they name; a new activity drops old patches", () => {
  const s = { activity: "eat", minutes: 30, patch: { minActivity: 15 } };
  assert.deepEqual(L.applySuggestion(s, { minutes: 55 }), { activity: "eat", minutes: 55, patch: { minActivity: 15 } });
  assert.deepEqual(L.applySuggestion(s, { activity: "study", minActivity: 30, preparation: 3 }),
    { activity: "study", minutes: 30, patch: { minActivity: 30, preparation: 3 } });
});

test("the day chart draws recorded hours against the reference and leaves gaps empty", () => {
  const hist = { capacity: 200, hourly: [{ hour: 8, occupancy: 50, busyness: "quiet" }, { hour: 9, occupancy: 400, busyness: "busy" }] };
  const bars = L.dayBars(hist, 7, 11);
  assert.deepEqual(bars.map((b) => b.hour), [7, 8, 9, 10]);
  assert.deepEqual(bars[0], { hour: 7, pct: 0, level: "none" });            // no recording: no bar, never zero people
  assert.equal(bars[1].pct, 0.25);
  assert.equal(bars[2].pct, 1);                                             // capped at the reference
  assert.equal(L.dayBars(null).every((b) => b.level === "none"), true);
});

test("hours read in words, never guessed", () => {
  const fmt = (p) => `${p.start}-${p.end}`;
  assert.equal(L.hoursText({ status: "scheduled", periods: [{ start: "07:00", end: "02:00" }] }, fmt), "07:00-02:00");
  assert.equal(L.hoursText({ status: "scheduled", periods: [{ start: "07:00", end: "22:00" }], assumed: true }, fmt), "07:00-22:00 (assumed)");
  assert.equal(L.hoursText({ status: "closed", periods: [] }, fmt), "Closed");
  assert.equal(L.hoursText({ status: "unpublished", periods: [] }, fmt), "Not published yet");
  assert.equal(L.hoursText({ status: "unverified", periods: [] }, fmt), "Unverified");
});
