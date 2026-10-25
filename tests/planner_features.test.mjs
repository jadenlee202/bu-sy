// Planner features: next-class time input, visit-time busyness, verified opening hours.
// Run: node --test "tests/*.test.mjs". Deterministic fixtures; the real hours.json and the
// exported demo data (what static mode serves) are read where a test says so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  budgetSentence, demoDate, hasBusyData, hoursBasisText, minutesUntil, normalizeRequest, planningHours,
  rankReason, recommend, requestFromScenario, switchWindowMode, visitProfile, visitText, whyItFits,
} from "../web/js/recommend.js";

// ---------- fixtures ----------
const ACTIVITIES = [
  { id: "study", label: "Study", verb: "study", noun: "study session", default_min: 30 },
  { id: "eat", label: "Eat", verb: "eat", noun: "meal", default_min: 20 },
  { id: "workout", label: "Work out", verb: "work out", noun: "workout", default_min: 35 },
];
const place = (id, over = {}) => ({
  place_id: id, name: id, facility_id: id, facility_name: id, location_id: "b",
  activities: ["workout"], data_mode: "synthetic", hours: [["06:00", "24:00"]], hours_basis: "illustrative",
  amenities: {}, amenities_basis: "illustrative", ...over,
});
const makeCampus = (places) => ({
  label: "Demo", default_buffer: 10, activities: ACTIVITIES,
  amenity_labels: { outlets: "Outlets" },
  locations: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
  travel: [{ from_id: "a", to_id: "b", minutes: 10 }, { from_id: "b", to_id: "c", minutes: 15 }],
  travel_basis: "Sample walking time", places, scenarios: [],
});
const req = (over = {}) => ({
  activity: "workout", start: "15:00", minutes: 70, source: "manual", from: "a", to: "c",
  minActivity: 35, buffer: 10, preferQuiet: true, preferShortTravel: false, needs: [],
  // Preparation/cleanup allowances (added on main) are zeroed here so the window arithmetic in these
  // tests stays the plain walk + activity + buffer; tests/actionable_plans covers the allowances.
  preparation: 0, cleanup: 0, ...over,
});
const sum = (o) => o.budget.reduce((s, b) => s + b.minutes, 0);
const pad = (n) => String(n).padStart(2, "0");
const at = (min) => `2026-10-19T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
/** A 15-minute simulated series from `from` to `to` (minutes); level(minute) picks each value's level. */
const series = (level, { from = 8 * 60, to = 23 * 60, hold = 15, count = (m) => 10 } = {}) => {
  const observations = [];
  for (let m = from; m < to; m += 15) observations.push({ observed_at: at(m), occupancy_count: count(m), busyness: level(m) });
  return { day: "2026-10-19", coverage_start: at(from).slice(11), coverage_end: at(to).slice(11), capacity: 100, max_hold_minutes: hold, observations };
};
const quiet = () => "quiet";

// ================= Task 1: next-class time input =================
test("until mode: free minutes are next commitment minus start", () => {
  assert.equal(minutesUntil("15:00", "16:10"), 70);
  assert.equal(minutesUntil("09:45", "10:00"), 15);
  assert.equal(minutesUntil("15:00", ""), null);
  assert.equal(minutesUntil("bad", "16:00"), null);
  const n = normalizeRequest(req({ mode: "until", until: "16:10", minutes: 999 }));
  assert.equal(n.minutes, 70, "typed minutes are ignored in until mode");
});

test("until mode feeds the same engine: identical options to the equivalent duration", () => {
  const campus = makeCampus([place("gym")]);
  const h = { gym: series(quiet) };
  const a = recommend(req({ minutes: 70 }), campus, h);
  const b = recommend(req({ mode: "until", until: "16:10" }), campus, h);
  assert.deepEqual(b.window, a.window);
  assert.deepEqual(b.options, a.options);
  assert.equal(b.request.minutes, 70);
});

test("until mode keeps travel and the buffer counted once", () => {
  const campus = makeCampus([place("gym")]);
  const r = recommend(req({ mode: "until", until: "16:10" }), campus, { gym: series(quiet) });
  const o = r.options[0];
  assert.deepEqual([o.there, o.activity, o.onward], [10, 35, 15]);
  assert.equal(sum(o), 70);
  assert.equal(o.budget.filter((b) => b.kind === "buffer").length, 1);
  assert.equal(o.arriveNext, 16 * 60, "arrive at the next stop one buffer before the next commitment");
  assert.equal(o.windowEnd, 16 * 60 + 10);
  assert.equal(budgetSentence(o, r.request, campus),
    "Fits your 70-minute window: 10 min there + 35-minute workout + 15 min onward + 10-minute buffer.");
});

test("until mode rejects missing, zero, negative, too short, too long and past-midnight windows", () => {
  const campus = makeCampus([place("gym")]);
  const err = (over) => {
    const r = recommend(req({ mode: "until", ...over }), campus, {});
    assert.equal(r.ok, false, JSON.stringify(over));
    return r.errors.find((e) => e.field === "until")?.message;
  };
  assert.match(err({ until: "" }), /Enter when your next class/);
  assert.match(err({ until: "15:00" }), /no free time/);
  assert.match(err({ until: "14:30" }), /must be after your start time/);
  // 11 PM -> 12:30 AM would be tomorrow: never wrapped, because the engine models one day.
  assert.match(err({ start: "23:00", until: "00:30" }), /times after midnight aren't supported/);
  assert.match(err({ until: "15:03" }), /at least 5 minutes/);
  assert.match(err({ start: "08:00", until: "21:00" }), /780 min free.*5 to 720/);
  assert.equal(recommend(req({ mode: "until", until: "15:05" }), campus, {}).ok, true);
});

test("switching modes carries a valid window and loses nothing otherwise", () => {
  const base = req({ start: "15:00", minutes: 45, until: "" });
  const toUntil = switchWindowMode(base, "until");
  assert.equal(toUntil.mode, "until");
  assert.equal(toUntil.until, "15:45");
  const back = switchWindowMode({ ...toUntil, until: "16:30" }, "duration");
  assert.equal(back.mode, "duration");
  assert.equal(back.minutes, 90);
  // Invalid until (earlier than start): switching back keeps the duration as it was.
  assert.equal(switchWindowMode({ ...base, mode: "until", until: "14:00" }, "duration").minutes, 45);
  // No valid duration: switching to until keeps a time already entered.
  assert.equal(switchWindowMode({ ...base, minutes: NaN, until: "17:00" }, "until").until, "17:00");
  // A duration that ends at midnight can't become a same-day time: the old value is kept.
  assert.equal(switchWindowMode(req({ start: "23:00", minutes: 60, until: "23:30" }), "until").until, "23:30");
});

test("manual-duration workflow is unchanged: no mode, explicit duration mode, same result", () => {
  const campus = makeCampus([place("gym")]);
  const h = { gym: series(quiet) };
  const plain = recommend(req(), campus, h);
  const explicit = recommend(req({ mode: "duration", until: "18:00" }), campus, h);
  assert.deepEqual(explicit.options, plain.options);
  assert.equal(plain.window.minutes, 70);
  assert.equal(recommend(req({ minutes: 4 }), campus, h).errors[0].field, "minutes");
});

test("until mode: 'more time' suggestions move the next-commitment time, and really fit", () => {
  const campus = makeCampus([place("gym")]);
  const h = { gym: series(quiet) };
  const tight = req({ mode: "until", until: "16:05" });           // 65 min, 5 short
  const r = recommend(tight, campus, h);
  assert.equal(r.options.length, 0);
  const s = r.suggestions[0];
  assert.deepEqual(s.patch, { until: "16:10" });
  assert.match(s.label, /Free until 4:10 PM \(70 min\)/);
  assert.equal(recommend({ ...tight, ...s.patch }, campus, h).options.length, 1);
});

// ================= Task 2: busyness during the visit =================
test("visit profile: consistently quiet over the planned activity interval", () => {
  const campus = makeCampus([place("gym")]);
  const o = recommend(req(), campus, { gym: series(quiet) }).options[0];
  assert.deepEqual([o.visit.start, o.visit.end], [o.arrive, o.leaveBy], "the visit is arrive -> leave by");
  assert.equal(o.visit.minutes, 35);
  assert.deepEqual(o.visit.byLevel, { quiet: 35, moderate: 0, busy: 0, unknown: 0 });
  assert.equal(o.visit.changes, false);
  assert.equal(visitText(o).label, "Quiet for your whole visit (simulated)");
  assert.match(visitText(o).basis, /Estimated visit 3:10 PM–3:45 PM.*35 min quiet.*not live occupancy or a forecast/);
});

test("visit profile keeps a change from quiet to busier instead of one category", () => {
  const campus = makeCampus([place("gym")]);
  const h = { gym: series((m) => (m < 15 * 60 + 30 ? "quiet" : "busy")) };
  const o = recommend(req(), campus, h).options[0];
  assert.equal(o.busy.level, "quiet", "the departure snapshot alone would say quiet");
  assert.deepEqual(o.visit.byLevel, { quiet: 20, moderate: 0, busy: 15, unknown: 0 });
  assert.deepEqual(o.visit.segments.map((s) => s.level), ["quiet", "busy"]);
  assert.equal(visitText(o).label, "Quiet, then busy during your visit (simulated)");
  assert.match(visitText(o).basis, /quiet 3:10 PM–3:30 PM; busy 3:30 PM–3:45 PM/);
  assert.ok(whyItFits(o, req(), campus, null).some((t) => t.startsWith("Quiet, then busy during your visit")));
  // A return to the first level is kept, not collapsed into "quiet, then busy".
  const back = { gym: series((m) => (m >= 15 * 60 + 15 && m < 15 * 60 + 30 ? "busy" : "quiet")) };
  const b = recommend(req(), campus, back).options[0];
  assert.deepEqual(b.visit.segments.map((s) => s.level), ["quiet", "busy", "quiet"]);
  assert.equal(visitText(b).label, "Quiet, then busy, then quiet during your visit (simulated)");
  // Many changes are summarized without dropping the fact that they happened.
  const flip = { gym: series((m) => (Math.floor(m / 15) % 2 ? "busy" : "quiet")) };
  const long = recommend(req({ minutes: 150, to: null }), campus, flip).options[0];
  assert.ok(long.visit.segments.length > 3);
  assert.match(visitText(long).label, /^Changes \d+ times during your visit, mostly (quiet|busy)/);
});

test("partial history: uncovered minutes are unknown, never zero or quiet", () => {
  const campus = makeCampus([place("gym")]);
  // Recording ends at 15:30 (inclusive, the same rule as latestAt), in the middle of the 15:10-15:45 visit.
  const o = recommend(req(), campus, { gym: series(quiet, { to: 15 * 60 + 30 }) }).options[0];
  assert.equal(o.visit.byLevel.quiet, 21);
  assert.equal(o.visit.byLevel.unknown, 14);
  assert.ok(o.visit.score > 0, "unknown minutes raise the score; they are not quiet");
  assert.match(visitText(o).basis, /14 min with no simulated data \(not counted as quiet\)/);
  // A gap longer than max hold is unknown too (same rule as busynessAt).
  const gap = series(quiet);
  gap.observations = gap.observations.filter((x) => !x.observed_at.includes("T15:00") && !x.observed_at.includes("T15:15"));
  const g = recommend(req(), campus, { gym: gap }).options[0];
  assert.ok(g.visit.byLevel.unknown > 0);
});

test("no history at all: the visit has no data, is ranked as unknown and never 'best match'", () => {
  const campus = makeCampus([place("a1"), place("b1")]);
  const r = recommend(req(), campus, {});
  for (const o of r.options) {
    assert.equal(o.visit.known, 0);
    assert.equal(hasBusyData(o), false);
    assert.equal(visitText(o).label, "No simulated data for your visit (simulated)");
  }
  assert.equal(r.featured, null);
});

test("unknown arrival: no starting point or no route means no visit-time claim", () => {
  const campus = makeCampus([place("gym")]);
  const h = { gym: series(quiet) };
  const browse = recommend(req({ from: "" }), campus, h);
  assert.equal(browse.options.length, 0);
  assert.equal(browse.browse[0].visit, null);
  assert.equal(visitText(browse.browse[0]), null);
  const noRoute = recommend(req({ from: "c", to: null }), makeCampus([place("gym", { location_id: "a" })]), h);
  assert.equal(noRoute.excluded[0].code, "route");
  assert.equal(noRoute.excluded[0].visit, undefined);
});

test("quieter-first ranks on the visit profile, not only the departure snapshot", () => {
  // "early": quiet when you leave but busy for the visit. "late": busy when you leave, quiet during the visit.
  const campus = makeCampus([place("early"), place("late")]);
  const h = {
    early: series((m) => (m < 15 * 60 + 5 ? "quiet" : "busy")),
    late: series((m) => (m < 15 * 60 + 5 ? "busy" : "quiet")),
  };
  const r = recommend(req(), campus, h);
  assert.deepEqual(r.options.map((o) => o.place.place_id), ["late", "early"]);
  assert.equal(r.options[1].busy.level, "quiet", "the snapshot alone would have put 'early' first");
  assert.equal(r.featured.why, "Quieter than the other options in the simulated data for your planned visit");
  assert.equal(rankReason(r.options[1], r.options[0]), "Busier than the top option during the planned visit (simulated)");
  // Shorter-walk-first keeps walking as the primary key; the visit profile only breaks ties after it.
  const far = makeCampus([place("early"), place("late", { location_id: "c" })]);
  const byWalk = recommend(req({ preferQuiet: false, preferShortTravel: true, minutes: 120, to: null }), far, h);
  assert.equal(byWalk.options[0].place.place_id, "early");
});

test("historical references stay out; only simulated places are labelled simulated", () => {
  const campus = makeCampus([place("sim"), place("live", { data_mode: "live" }), place("rec", { data_mode: "historical_playback" })]);
  const h = { sim: series(quiet), live: series(quiet), rec: series(quiet) };
  const r = recommend(req(), campus, h);
  assert.ok(![...r.options, ...r.more].some((o) => o.place.place_id === "rec"));
  const byId = Object.fromEntries(r.options.map((o) => [o.place.place_id, visitText(o)]));
  assert.match(byId.sim.label, /\(simulated\)$/);
  assert.doesNotMatch(byId.live.label, /simulated/);
});

test("static and API inputs that are equal by value give identical results", () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../web/data/${p}`, import.meta.url)));
  const campus = read("campus.json");
  const hours = read("hours.json");
  const ids = [...new Set(campus.places.map((p) => p.facility_id))];
  const staticH = Object.fromEntries(ids.map((id) => [id, read(`history/${id}.json`)]));
  // An API response is the same JSON (server/export_static.py writes it; pytest checks equality),
  // fetched separately: model that as an independent deep copy.
  const apiH = JSON.parse(JSON.stringify(staticH));
  const date = demoDate(campus, staticH);
  for (const s of campus.scenarios) {
    const q = { ...requestFromScenario(s), date };
    const a = recommend(q, structuredClone(campus), staticH, { hours });
    const b = recommend(q, structuredClone(campus), apiH, { hours: structuredClone(hours) });
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), s.id);
  }
});

test("exported demo data: every fit keeps the time budget and a visit inside the window", () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../web/data/${p}`, import.meta.url)));
  const campus = read("campus.json");
  const hours = read("hours.json");
  const h = Object.fromEntries([...new Set(campus.places.map((p) => p.facility_id))].map((id) => [id, read(`history/${id}.json`)]));
  const date = demoDate(campus, h);
  assert.equal(date, "2026-10-19");
  for (const a of campus.activities) {
    for (const start of ["07:30", "12:00", "17:30", "21:30"]) {
      const r = recommend(req({ activity: a.id, minActivity: a.default_min, from: "mugar", to: "warren", start, minutes: 90, date }), campus, h, { hours });
      for (const o of [...r.options, ...r.more]) {
        assert.equal(sum(o), 90);
        assert.ok(o.visit.start >= o.arrive && o.visit.end <= o.leaveBy);
        assert.equal(Object.values(o.visit.byLevel).reduce((x, y) => x + y, 0), o.visit.minutes);
      }
    }
  }
});

// ================= Task 3: verified opening hours =================
const HOURS = JSON.parse(readFileSync(new URL("../web/data/hours.json", import.meta.url), "utf8"));
const fitrec = place("fitrec-synthetic", { activities: ["workout"], hours: [["06:00", "24:00"]] });

test("a visit fully inside verified building hours is a fit and says so", () => {
  const r = recommend(req({ date: "2026-10-19" }), makeCampus([fitrec]), {}, { hours: HOURS });
  const o = r.options[0];
  assert.equal(o.hours.basis, "verified");
  assert.equal(o.hours.kind, "building");
  assert.match(hoursBasisText(o.hours), /Building hours Monday, Oct 19: 6:00 AM–11:00 PM · verified BU hours/);
  assert.ok(whyItFits(o, r.request, makeCampus([]), null).includes("Open check uses verified BU building hours for Monday, Oct 19."));
});

test("a visit overlapping verified closing time is cut short, or excluded if too short", () => {
  const campus = makeCampus([fitrec]);
  // Illustrative hours say midnight; verified Monday hours close at 11 PM.
  const tight = recommend(req({ start: "22:20", minutes: 70, to: null, date: "2026-10-19" }), campus, {}, { hours: HOURS });
  assert.equal(tight.options.length, 0);
  assert.equal(tight.excluded[0].code, "closed");
  assert.match(tight.excluded[0].reason, /verified BU building hours for Monday, Oct 19: 6 AM–11 PM/);
  const shortened = recommend(req({ start: "22:00", minutes: 90, to: null, minActivity: 30, date: "2026-10-19" }), campus, {}, { hours: HOURS });
  const o = shortened.options[0];
  assert.equal(o.leaveBy, 23 * 60);
  // 90-min window: 10 min walk, 50 min until the 11 PM close, 20 min unused, 10-min buffer.
  assert.deepEqual([o.there, o.activity, o.spare], [10, 50, 20]);
  assert.equal(sum(o), 90);
  // Without verified hours (no date), the same request uses the illustrative midnight close.
  assert.equal(recommend(req({ start: "22:20", minutes: 70, to: null }), campus, {}, { hours: HOURS }).options.length, 1);
});

test("special closure and special opening hours override the weekly schedule", () => {
  const campus = makeCampus([fitrec]);
  const closed = recommend(req({ date: "2026-11-26" }), campus, {}, { hours: HOURS });
  assert.equal(closed.excluded[0].code, "closed");
  assert.match(closed.excluded[0].reason, /^Closed that day \(verified BU building hours for Thursday, Nov 26; Thanksgiving closure\.\)/);
  // Oct 12: adjusted 8 AM-10 PM. A 7 AM start waits for opening instead of counting it as activity.
  const adjusted = recommend(req({ start: "07:00", minutes: 120, to: null, date: "2026-10-12" }), campus, {}, { hours: HOURS });
  assert.equal(adjusted.options[0].arrive, 8 * 60);
  assert.equal(adjusted.options[0].hours.basis, "verified");
});

test("outside the effective date range, verified hours are not used: illustrative fallback", () => {
  const warren = place("warren-dining-synthetic", { activities: ["eat"], hours: [["07:00", "23:00"]] });
  const h = planningHours(warren, { activity: "eat", date: "2026-10-19" }, HOURS); // published only Oct 24-30
  assert.equal(h.basis, "illustrative");
  assert.match(hoursBasisText(h), /illustrative demo hours, not official \((BU hours not published for Monday, Oct 19|Monday, Oct 19 is outside the published BU schedule)\)/);
  const inRange = planningHours(warren, { activity: "eat", date: "2026-10-26" }, HOURS);
  assert.equal(inRange.basis, "verified");
  // FitRec's weekly pattern is projected past Dec 10 for display ("assumed"); the planner still falls back.
  const projected = planningHours(fitrec, { activity: "workout", date: "2026-12-20" }, HOURS);
  assert.equal(projected.basis, "illustrative");
  assert.match(projected.fallback, /outside the published BU schedule/);
  // Same rule on a synthetic schedule, both for "repeatsWeekly: false" (unpublished) and the default (assumed).
  const sched = (extra) => ({ locations: { x: { buildingHours: { status: "verified", effectiveFrom: "2026-10-19", effectiveThrough: "2026-10-25",
    weeklyHours: { monday: [{ label: "Building hours", start: "06:00", end: "22:00" }] }, ...extra }, serviceHours: { status: "not_applicable" } } } });
  const x = place("x", { hours: null, hours_basis: "unknown" });
  assert.equal(planningHours(x, { activity: "workout", date: "2026-10-19" }, sched({})).basis, "verified");
  assert.equal(planningHours(x, { activity: "workout", date: "2026-10-26" }, sched({})).basis, "unknown");
  assert.equal(planningHours(x, { activity: "workout", date: "2026-10-26" }, sched({ repeatsWeekly: false })).basis, "unknown");
});

test("unknown or unverified hours are never confirmed", () => {
  // Fenway has no demo hours; outside its verified week nothing confirms it: listed under check hours.
  const fenway = place("fenway-dining-synthetic", { activities: ["eat"], hours: null, hours_basis: "unknown" });
  const q = req({ activity: "eat", minActivity: 20, start: "12:00", minutes: 60 });
  const outside = recommend({ ...q, date: "2026-10-26" }, makeCampus([fenway]), {}, { hours: HOURS });
  assert.equal(outside.options.length, 0);
  assert.equal(outside.checkHours[0].hours.basis, "unknown");
  assert.match(hoursBasisText(outside.checkHours[0].hours), /^Hours unknown · check before going \(BU hours not published/);
  // Inside its verified week the meal-service hours confirm it.
  assert.equal(recommend({ ...q, date: "2026-10-19" }, makeCampus([fenway]), {}, { hours: HOURS }).options.length, 1);
  // Mugar's entry is unverified: its weekly hours (if any) are ignored and the demo hours are used.
  const mugar = place("mugar-synthetic", { activities: ["study"], hours: [["08:00", "24:00"]] });
  assert.equal(planningHours(mugar, { activity: "study", date: "2026-10-19" }, HOURS).basis, "illustrative");
  // Weekly hours present but status not "verified": not treated as verified.
  const fake = { locations: { x: { buildingHours: { status: "unverified", weeklyHours: { monday: [{ label: "B", start: "00:00", end: "23:00" }] } }, serviceHours: { status: "not_applicable" } } } };
  assert.equal(planningHours(place("x", { hours: null }), { activity: "workout", date: "2026-10-19" }, fake).basis, "unknown");
});

test("eating uses meal-service periods; studying at the same hall uses building hours", () => {
  const loc = {
    buildingHours: { status: "verified", effectiveFrom: "2026-10-19", effectiveThrough: "2026-10-25",
      weeklyHours: { monday: [{ label: "Building hours", start: "07:00", end: "22:00" }] } },
    serviceHours: { status: "verified", effectiveFrom: "2026-10-19", effectiveThrough: "2026-10-25",
      weeklyHours: { monday: [{ label: "Breakfast", start: "07:00", end: "10:00" }, { label: "Lunch", start: "11:30", end: "14:00" }] } },
  };
  const hours = { locations: { hall: loc } };
  const hall = place("hall", { activities: ["eat", "study"], hours: [["07:00", "23:00"]] });
  const campus = makeCampus([hall]);
  const base = req({ start: "10:00", minutes: 120, to: null, date: "2026-10-19" });
  const eat = recommend({ ...base, activity: "eat", minActivity: 20 }, campus, {}, { hours }).options[0];
  assert.equal(eat.hours.kind, "service");
  assert.equal(eat.arrive, 11 * 60 + 30, "no meal between breakfast and lunch: wait for lunch");
  assert.match(hoursBasisText(eat.hours), /Meal service Monday, Oct 19: Breakfast 7:00 AM–10:00 AM, Lunch 11:30 AM–2:00 PM/);
  const study = recommend({ ...base, activity: "study", minActivity: 30 }, campus, {}, { hours }).options[0];
  assert.equal(study.hours.kind, "building");
  assert.equal(study.arrive, 10 * 60 + 10, "the building is open, so studying starts on arrival");
  // Meal service never extends past verified building hours.
  const late = { locations: { hall: { ...loc, serviceHours: { ...loc.serviceHours, weeklyHours: { monday: [{ label: "Dinner", start: "17:00", end: "23:30" }] } } } } };
  assert.deepEqual(planningHours(hall, { activity: "eat", date: "2026-10-19" }, late).segs, [[17 * 60, 22 * 60]]);
});

test("without hours data or a planning date, the engine keeps its illustrative behaviour", () => {
  const campus = makeCampus([fitrec]);
  const a = recommend(req({ start: "22:20", minutes: 70, to: null }), campus, {});
  const b = recommend(req({ start: "22:20", minutes: 70, to: null, date: "2026-10-19" }), campus, {});
  assert.equal(a.options.length, 1);
  assert.equal(b.options.length, 1);
  assert.equal(a.options[0].hours.basis, "illustrative");
});
