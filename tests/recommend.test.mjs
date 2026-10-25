// Planner engine tests. Run: node --test "tests/*.test.mjs"
// Uses Node's built-in runner, no packages. The engine is the same file the browser loads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  budgetSentence, busynessText, periodAt, rankReason, recommend, requestFromScenario, whyItFits,
} from "../web/js/recommend.js";

// ---------- tiny fixtures ----------
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
  label: "Demo · Synthetic campus data", default_buffer: 10, activities: ACTIVITIES,
  amenity_labels: { outlets: "Outlets", quiet_space: "Quiet space" },
  locations: ["a", "b", "c", "x"].map((id) => ({ id, name: id.toUpperCase() })),
  travel: [
    { from_id: "a", to_id: "b", minutes: 10 }, { from_id: "b", to_id: "c", minutes: 15 }, { from_id: "c", to_id: "a", minutes: 25 },
  ],
  travel_basis: "Sample walking time", places, scenarios: [],
});
const hist = (count, busyness = "quiet") => ({
  coverage_start: "08:00:00", coverage_end: "23:00:00", capacity: 100,
  observations: count == null ? [] : [{ observed_at: "2026-10-19T08:00:00", occupancy_count: count, busyness }],
});
const req = (over = {}) => ({
  activity: "workout", start: "15:00", minutes: 70, source: "manual", from: "a", to: "c",
  minActivity: 35, buffer: 10, preferQuiet: true, preferShortTravel: false, needs: [], ...over,
});
const sum = (o) => o.budget.reduce((s, b) => s + b.minutes, 0);
const one = (over = {}, placeOver = {}, h = hist(20)) => {
  const p = place("gym", placeOver);
  return recommend(req(over), makeCampus([p]), { gym: h });
};

// ---------- time feasibility ----------
test("exact fit: travel there + minimum + onward + buffer == window", () => {
  const r = one();
  assert.equal(r.options.length, 1);
  const o = r.options[0];
  assert.deepEqual([o.there, o.activity, o.onward], [10, 35, 15]);
  assert.equal(sum(o), 70);
  assert.equal(budgetSentence(o, req(), makeCampus([])),
    "Fits your 70-minute window: 10 min there + 35-minute workout + 15 min onward + 10-minute buffer.");
  assert.equal(o.depart, 15 * 60);
  assert.equal(o.arrive, 15 * 60 + 10);
  assert.equal(o.leaveBy, 15 * 60 + 45);
  assert.equal(o.arriveNext, 16 * 60);           // window end minus the buffer
  assert.equal(o.windowEnd, 16 * 60 + 10);
});

test("insufficient time: one minute short is excluded, and extending is suggested", () => {
  const r = one({ minutes: 69 });
  assert.equal(r.options.length, 0);
  assert.equal(r.excluded[0].code, "time");
  assert.equal(r.excluded[0].short, 1);
  assert.match(r.excluded[0].reason, /25 min of walking and your 10-min buffer/);
  assert.deepEqual(r.suggestions[0].patch, { minutes: 70 });
});

test("outbound and onward travel are each subtracted once", () => {
  const o = one({ minutes: 100 }).options[0];
  assert.equal(o.activity, 100 - 10 - 15 - 10);
  assert.equal(sum(o), 100);
});

test("missing next destination: onward travel excluded and explained", () => {
  const r = one({ to: null });
  const o = r.options[0];
  assert.equal(o.onward, 0);
  assert.equal(o.activity, 70 - 10 - 10);
  assert.equal(o.arriveNext, null);
  assert.ok(!o.budget.some((b) => b.kind === "onward"));
  assert.ok(whyItFits(o, req({ to: null }), makeCampus([])).some((t) => t.includes("onward travel not counted")));
});

test("unknown travel is unknown, not zero", () => {
  const from = one({ from: "x" });
  assert.equal(from.options.length, 0);
  assert.equal(from.excluded[0].code, "route");
  const to = one({ to: "x" });
  assert.equal(to.excluded[0].code, "route");
  assert.match(to.excluded[0].reason, /No sample walking time to X/);
});

test("same location travel is zero", () => {
  const o = one({ from: "b", to: "b" }).options[0];
  assert.deepEqual([o.there, o.onward, o.activity], [0, 0, 60]);
  assert.match(budgetSentence(o, req({ from: "b", to: "b" }), makeCampus([])), /0 min there \(same place\)/);
});

test("buffer is protected before the next commitment", () => {
  const a = one({ buffer: 10, minutes: 90 }).options[0];
  const b = one({ buffer: 20, minutes: 90 }).options[0];
  assert.equal(a.activity - b.activity, 10);
  assert.equal(b.arriveNext, b.windowEnd - 20);
  assert.equal(one({ buffer: 21 }).options.length, 0);
});

// ---------- hours ----------
test("closing before the minimum fits excludes; closing after it shortens the visit", () => {
  assert.equal(one({}, { hours: [["06:00", "15:30"]] }).excluded[0].code, "closed");
  const r = one({ minutes: 90 }, { hours: [["06:00", "16:00"]] });
  const o = r.options[0];
  assert.equal(o.leaveBy, 16 * 60);
  assert.equal(o.spare, 5);                      // latest leave was 4:05 PM
  assert.equal(sum(o), 90);
});

test("a place that opens later waits for opening instead of counting it as activity", () => {
  const o = one({ minutes: 90 }, { hours: [["15:20", "24:00"]] }).options[0];
  assert.equal(o.free, 10);
  assert.equal(o.depart, 15 * 60 + 10);
  assert.equal(o.arrive, 15 * 60 + 20);
  assert.equal(sum(o), 90);
});

test("unknown hours are never confirmed: listed under check hours", () => {
  const r = one({}, { hours: null, hours_basis: "unknown" });
  assert.equal(r.options.length, 0);
  assert.equal(r.checkHours.length, 1);
  assert.equal(r.checkHours[0].activity, 35);
});

// ---------- busyness ----------
test("zero occupancy is quiet; missing occupancy is unavailable", () => {
  const zero = one({}, {}, hist(0, "quiet")).options[0];
  assert.equal(zero.busy.level, "quiet");
  assert.equal(zero.busy.count, 0);
  assert.equal(busynessText(zero, req()).label, "Quiet at 3:00 PM");
  assert.match(busynessText(zero, req()).basis, /Simulated count 0 of 100 \(illustrative capacity\) at 3:00 PM\. Not a forecast/);

  const missing = one({}, {}, hist(null)).options[0];
  assert.equal(missing.busy.level, "unknown");
  assert.equal(missing.busy.count, null);
  assert.equal(busynessText(missing, req()).label, "No busyness data");
});

test("a value names its simulation period: dataset-derived, modeled or not simulated", () => {
  const simulation = { periods: [
    { start: "07:00", end: "11:00", basis: "modeled", label: "Breakfast and morning: modeled" },
    { start: "11:00", end: "14:00", basis: "reference_dataset", label: "Lunch: from canteen purchase times" },
    { start: "14:00", end: "23:00", basis: "unavailable", label: "Not simulated: no source data" },
  ] };
  assert.equal(periodAt(simulation, 11 * 60 - 1).basis, "modeled");
  assert.equal(periodAt(simulation, 11 * 60).basis, "reference_dataset");   // [start, end): one period per minute
  assert.equal(periodAt(simulation, 23 * 60), null);
  assert.equal(periodAt(null, 600), null);

  const lunch = one({ start: "12:00" }, {}, { ...hist(30), simulation }).options[0];
  assert.match(busynessText(lunch, req({ start: "12:00" })).basis, /at 12:00 PM \(Lunch: from canteen purchase times\)\. Not a forecast/);
  const late = one({ start: "15:00" }, {}, { ...hist(null), simulation }).options[0];
  assert.equal(late.busy.level, "unknown");
  assert.match(busynessText(late, req()).basis, /Not simulated: no source data\.$/);
});

test("busyness before the first observation is unavailable, not zero", () => {
  const o = one({ start: "07:30" }).options[0];
  assert.equal(o.busy.level, "unknown");
});

test("missing busyness ranks after known quiet/moderate, before busy, and is never best match", () => {
  const places = [place("busy"), place("unknown"), place("moderate")];
  const histories = { busy: hist(90, "busy"), unknown: hist(null), moderate: hist(50, "moderate") };
  const r = recommend(req(), makeCampus(places), histories);
  assert.deepEqual(r.options.map((o) => o.place.name), ["moderate", "unknown", "busy"]);
  const top = recommend(req(), makeCampus([place("unknown"), place("busy")]), histories);
  assert.equal(top.options[0].place.name, "unknown");
  assert.equal(top.featured, null);
});

// ---------- preferences ----------
test("required amenities filter; unlisted is not assumed", () => {
  const places = [
    place("yes", { activities: ["study"], amenities: { outlets: true } }),
    place("no", { activities: ["study"], amenities: { outlets: false } }),
    place("unlisted", { activities: ["study"] }),
  ];
  const histories = { yes: hist(10), no: hist(10), unlisted: hist(10) };
  const r = recommend(req({ activity: "study", minActivity: 30, needs: ["outlets"] }), makeCampus(places), histories);
  assert.deepEqual(r.options.map((o) => o.place.name), ["yes"]);
  assert.deepEqual(r.excluded.map((e) => e.reason), ["No outlets in sample metadata", "Outlets not listed in sample metadata"]);
  assert.equal(r.featured.kind, "only");
});

test("activity mismatch is filtered before anything else", () => {
  const r = one({ activity: "eat", minActivity: 20 });
  assert.equal(r.options.length + r.excluded.length + r.checkHours.length, 0);
});

test("ranking is stable and ties are not called a best match", () => {
  const names = ["delta", "alpha", "charlie", "bravo"];
  const histories = Object.fromEntries(names.map((n) => [n, hist(10)]));
  const forward = recommend(req(), makeCampus(names.map((n) => place(n))), histories);
  const backward = recommend(req(), makeCampus([...names].reverse().map((n) => place(n))), histories);
  assert.deepEqual(forward.options.map((o) => o.place.name), ["alpha", "bravo", "charlie"]);
  assert.deepEqual(backward.options.map((o) => o.place.name), ["alpha", "bravo", "charlie"]);
  assert.equal(forward.more.length, 1);
  assert.equal(forward.featured, null);
});

test("preferences change the order: quieter vs shorter walk", () => {
  const places = [place("far-quiet", { location_id: "c" }), place("near-busy", { location_id: "b" })];
  const histories = { "far-quiet": hist(5, "quiet"), "near-busy": hist(90, "busy") };
  const base = { to: null, minutes: 90 };
  const quiet = recommend(req({ ...base, preferQuiet: true }), makeCampus(places), histories);
  assert.equal(quiet.options[0].place.name, "far-quiet");
  assert.match(quiet.featured.why, /Quieter/);
  const short = recommend(req({ ...base, preferQuiet: false, preferShortTravel: true }), makeCampus(places), histories);
  assert.equal(short.options[0].place.name, "near-busy");
  assert.match(short.featured.why, /Shorter sample walk/);
});

test("COD-style historical places are never campus suggestions", () => {
  const cod = place("COD_Bosch_Office_1_Clemente", { data_mode: "historical_playback", activities: ["study"] });
  const r = recommend(req({ activity: "study", minActivity: 30 }), makeCampus([cod]), { [cod.facility_id]: hist(0) });
  assert.equal(r.options.length, 0);
  assert.equal(r.excluded[0].code, "not_campus");
});

test("invalid input is reported, not guessed", () => {
  const campus = makeCampus([place("gym")]);
  const fields = (over) => recommend(req(over), campus, { gym: hist(1) }).errors?.map((e) => e.field);
  assert.deepEqual(fields({ from: "nowhere" }), ["from"]);
  assert.equal(fields({ from: "" }), undefined); // no start is allowed: see the browse tests
  assert.deepEqual(fields({ start: "23:30", minutes: 60 }), ["minutes"]); // past midnight
  assert.deepEqual(fields({ minutes: Number.NaN }), ["minutes"]);
  assert.deepEqual(fields({ buffer: -1 }), ["buffer"]);
  assert.deepEqual(fields({ activity: "nap" }), ["activity"]);
});

// ---------- no starting point: browse, never "fits" ----------
test("unknown start: places are browsed, never called a fit or given trip times", () => {
  const r = one({ from: "" });
  assert.equal(r.travelKnown, false);
  assert.equal(r.options.length + r.more.length, 0);
  assert.equal(r.featured, null);
  const [o] = r.browse;
  assert.equal(o.status, "unchecked");
  assert.equal(o.there, null);                       // unknown, not zero
  assert.equal(o.activity, 70 - 15 - 10);            // an upper bound: onward and buffer only
  assert.ok(o.upTo && o.depart === undefined && o.arrive === undefined);
  assert.match(budgetSentence(o, req(), makeCampus([])), /^Up to 45 min .* Travel not checked/);
});

test("unknown start still rules out places that can't fit even before walking", () => {
  const r = one({ from: "", minutes: 50 });          // 50 - 15 onward - 10 buffer = 25 < 35
  assert.equal(r.browse.length, 0);
  assert.equal(r.excluded[0].code, "time");
  assert.match(r.excluded[0].reason, /before the walk there/);
  assert.equal(r.suggestions.length, 0);              // "would fit" can't be claimed without a start
  const closed = one({ from: "" }, { hours: [["18:00", "22:00"]] });
  assert.equal(closed.excluded[0].code, "closed");
  const unknownHours = one({ from: "" }, { hours: null });
  assert.equal(unknownHours.checkHours[0].upTo, true);
});

test("unknown start ignores walking in ranking, so 'shorter walk' can't decide", () => {
  const places = [place("far", { location_id: "c" }), place("near", { location_id: "a" })];
  const r = recommend(req({ from: "", to: null, preferQuiet: false, preferShortTravel: true }), makeCampus(places), { far: hist(5), near: hist(5) });
  assert.deepEqual(r.browse.map((o) => o.place.name), ["far", "near"]); // equal evidence: by name
});

test("rankReason names the first factor that puts an option below the top one", () => {
  const places = [place("quiet"), place("busy"), place("quiet2")];
  const r = recommend(req(), makeCampus(places), { quiet: hist(5), busy: hist(90, "busy"), quiet2: hist(5) });
  const [top, tie, busy] = r.options;
  assert.equal(rankReason(top, top), null);
  assert.equal(rankReason(tie, top), "Tied with the top option; listed by name");
  assert.equal(rankReason(busy, top), "Busier than the top option");
});

// ---------- the real exported sample data (what static mode serves) ----------
const read = (p) => JSON.parse(readFileSync(new URL(`../web/data/${p}`, import.meta.url)));
const campus = read("campus.json");
const histories = Object.fromEntries(
  [...new Set(campus.places.map((p) => p.facility_id))].map((id) => [id, read(`history/${id}.json`)]),
);
const scenario = (id) => requestFromScenario(campus.scenarios.find((s) => s.id === id));

test("sample scenario: 70-minute workout before class fits through the real engine", () => {
  const r = recommend(scenario("workout-between-classes"), campus, histories);
  assert.ok(r.options.length >= 1);
  for (const o of [...r.options, ...r.more]) {
    assert.equal(sum(o), 70);
    assert.ok(o.there + o.activity + o.onward + 10 <= 70 && o.activity >= 35);
  }
});

test("sample scenario: study with outlets picks a best match on evidence", () => {
  const r = recommend(scenario("study-with-outlets"), campus, histories);
  assert.equal(r.featured.kind, "best");
  assert.ok(r.options.every((o) => o.place.amenities.outlets === true));
});

test("sample scenario: nothing fits, and every suggestion really fits", () => {
  const req0 = scenario("lunch-too-tight");
  const r = recommend(req0, campus, histories);
  assert.equal(r.options.length, 0);
  assert.ok(r.reasons.length && r.suggestions.length);
  for (const s of r.suggestions) {
    const fixed = recommend({ ...req0, ...s.patch }, campus, histories);
    assert.ok(fixed.options.length + fixed.more.length > 0, s.label);
  }
});

test("exported campus data has no COD place, and every result keeps the time budget", () => {
  assert.ok(campus.places.every((p) => p.data_mode === "synthetic" && !p.facility_id.startsWith("COD")));
  const ids = campus.locations.map((l) => l.id);
  for (const a of campus.activities) {
    for (const from of ids) {
      for (const to of [null, ...ids]) {
        for (const start of ["07:30", "12:00", "15:00", "18:30", "22:30"]) {
          const q = { ...scenario("workout-between-classes"), activity: a.id, minActivity: a.default_min, from, to, start, minutes: 90 };
          const r = recommend(q, campus, histories);
          for (const o of [...r.options, ...r.more, ...r.checkHours]) {
            assert.equal(sum(o), 90);
            assert.ok(o.activity >= a.default_min);
            assert.ok(!o.place.facility_id.startsWith("COD"));
          }
        }
      }
    }
  }
});
