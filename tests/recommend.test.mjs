// Planner engine tests. Run: node --test tests/
// Uses Node's built-in runner, no packages. The engine is the same file the browser loads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  budgetSentence, busynessText, recommend, requestFromScenario, whyItFits,
} from "../web/js/recommend.js";

// ---------- tiny fixtures ----------
const ACTIVITIES = [
  { id: "study", label: "Study", verb: "study", noun: "study session", default_min: 30 },
  { id: "eat", label: "Eat", verb: "eat", noun: "meal", default_min: 20 },
  { id: "workout", label: "Work out", verb: "work out", noun: "workout", default_min: 35 },
];
const place = (id, over = {}) => ({
  place_id: id, name: id, facility_id: id, facility_name: id, area_id: null, interest: null, location_id: "b",
  activities: ["workout"], data_mode: "synthetic", hours: [["06:00", "24:00"]], hours_basis: "illustrative",
  closures: [], amenities: {}, amenities_basis: "illustrative", ...over,
});
// An area of a facility: shares facility_id/location, has its own area_id + interest.
const area = (facilityId, areaId, over = {}) => place(`${facilityId}:${areaId}`, {
  name: areaId, facility_id: facilityId, facility_name: facilityId, area_id: areaId, ...over,
});
const makeCampus = (places) => ({
  label: "Demo · Synthetic campus data", default_buffer: 10, activities: ACTIVITIES,
  amenity_labels: { outlets: "Outlets", quiet_space: "Quiet space" },
  interest_labels: { weights: "Weights", basketball: "Basketball", cardio: "Cardio", swimming: "Swimming" },
  locations: ["a", "b", "c", "x"].map((id) => ({ id, name: id.toUpperCase() })),
  travel: [
    { from_id: "a", to_id: "b", minutes: 10 }, { from_id: "b", to_id: "c", minutes: 15 }, { from_id: "c", to_id: "a", minutes: 25 },
  ],
  travel_basis: "Sample walking time", places, scenarios: [],
});
const hist = (count, busyness = "quiet") => ({
  coverage_start: "08:00:00", coverage_end: "23:00:00", capacity: 100, areas: [],
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
test("known closure during the visit excludes the place", () => {
  const r = one({}, { closures: [{ start: "15:20", end: "16:00", reason: "Reserved: Intramurals (sample)", source: "sample schedule" }] });
  assert.equal(r.options.length, 0);
  assert.equal(r.excluded[0].code, "closed");
  assert.match(r.excluded[0].reason, /Reserved: Intramurals \(sample\), 3:20 PM–4 PM/);
});

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
  assert.equal(busynessText(zero, req()).label, "Quiet at the selected demo time");
  assert.match(busynessText(zero, req()).basis, /Sample count 0 of 100 \(illustrative capacity\) at 3:00 PM\. Not a forecast/);

  const missing = one({}, {}, hist(null)).options[0];
  assert.equal(missing.busy.level, "unknown");
  assert.equal(missing.busy.count, null);
  assert.equal(busynessText(missing, req()).label, "Busyness unavailable");
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
  assert.deepEqual(fields({ from: "" }), ["from"]);
  assert.deepEqual(fields({ start: "23:30", minutes: 60 }), ["minutes"]); // past midnight
  assert.deepEqual(fields({ minutes: Number.NaN }), ["minutes"]);
  assert.deepEqual(fields({ buffer: -1 }), ["buffer"]);
  assert.deepEqual(fields({ activity: "nap" }), ["activity"]);
});

// ---------- grouping FitRec areas into one destination ----------
// Three FitRec areas at the same location, plus a standalone gym elsewhere.
const fitrecAreas = (over = {}) => [
  area("fitrec", "weights-1", { interest: "weights", ...over }),
  area("fitrec", "court-1", { interest: "basketball", ...over }),
  area("fitrec", "pool-1", { interest: "swimming", ...over }),
];
const groupHist = {
  "fitrec": hist(10, "quiet"),        // facility-level series (unused for areas, but present)
};
// Per-area histories live under hist.areas keyed by area_id.
function histWithAreas(areaCounts) {
  return {
    coverage_start: "08:00:00", coverage_end: "23:00:00", capacity: 100,
    observations: [{ observed_at: "2026-10-19T08:00:00", occupancy_count: 5, busyness: "quiet" }],
    areas: Object.entries(areaCounts).map(([area_id, [count, busyness]]) => ({
      area_id, capacity: 50,
      observations: count == null ? [] : [{ observed_at: "2026-10-19T08:00:00", occupancy_count: count, busyness }],
    })),
  };
}

test("FitRec areas collapse into ONE destination, not several cards", () => {
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [20, "moderate"], "pool-1": [30, "busy"] }) };
  const r = recommend(req({ minutes: 90 }), makeCampus(places), histories);
  assert.equal(r.options.length, 1, "one FitRec card, not three");
  const g = r.options[0];
  assert.equal(g.grouped, true);
  assert.equal(g.facility_name, "fitrec");
  assert.equal(g.areas.length, 3, "all eligible areas listed inside");
  assert.equal(r.more.length, 0);
});

test("a grouped facility shares one travel calculation across its areas", () => {
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [10, "quiet"], "pool-1": [10, "quiet"] }) };
  const g = recommend(req({ minutes: 90 }), makeCampus(places), histories).options[0];
  // location "b" -> a:10, c:15. from a, to c => there 10, onward 15, shared by all areas.
  assert.deepEqual([g.there, g.onward], [10, 15]);
  assert.equal(sum(g), 90);                       // time budget intact after grouping
  assert.ok(g.areas.every((a) => a.there === g.there && a.onward === g.onward));
});

test("grouping keeps each area's own count; it never sums to a building number", () => {
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [11, "quiet"], "court-1": [22, "moderate"], "pool-1": [33, "busy"] }) };
  const g = recommend(req({ minutes: 90 }), makeCampus(places), histories).options[0];
  const counts = g.areas.map((a) => a.busy.count).sort((x, y) => x - y);
  assert.deepEqual(counts, [11, 22, 33]);
  assert.ok(!counts.includes(66), "areas are not summed into a building total");
});

test("choosing a workout interest narrows FitRec to matching areas only", () => {
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [10, "quiet"], "pool-1": [10, "quiet"] }) };
  const r = recommend(req({ minutes: 90, interests: ["swimming"] }), makeCampus(places), histories);
  assert.equal(r.options.length, 1);
  assert.deepEqual(r.options[0].areas.map((a) => a.place.area_id), ["pool-1"]);
});

test("an interest with no eligible area yields nothing, and suggests dropping it", () => {
  const places = fitrecAreas();                   // no "cardio" area exists
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [10, "quiet"], "pool-1": [10, "quiet"] }) };
  const r = recommend(req({ minutes: 90, interests: ["cardio"] }), makeCampus(places), histories);
  assert.equal(r.options.length, 0);
  assert.ok(r.suggestions.some((s) => JSON.stringify(s.patch) === JSON.stringify({ interests: [] })),
    "offers to show all workout types");
});

test("a reserved area is excluded but its sibling areas still fit the same card", () => {
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [10, "quiet"], "pool-1": [10, "quiet"] }) };
  // Reserve the basketball court across the whole window so it can't fit.
  places[1].closures = [{ start: "15:00", end: "17:00", reason: "Reserved: Intramurals (sample)", source: "sample schedule" }];
  const r = recommend(req({ minutes: 90 }), makeCampus(places), histories);
  assert.equal(r.options.length, 1);
  const ids = r.options[0].areas.map((a) => a.place.area_id);
  assert.ok(!ids.includes("court-1"), "reserved area not offered as a fit");
  assert.ok(ids.includes("weights-1") && ids.includes("pool-1"));
});

test("excluded FitRec collapses to one 'why not' row, not one per area", () => {
  // Window too tight for any area: all three excluded on time.
  const places = fitrecAreas();
  const histories = { fitrec: histWithAreas({ "weights-1": [10, "quiet"], "court-1": [10, "quiet"], "pool-1": [10, "quiet"] }) };
  const r = recommend(req({ minutes: 40 }), makeCampus(places), histories);
  assert.equal(r.options.length, 0);
  const fitrecRows = r.excluded.filter((e) => e.place.facility_id === "fitrec");
  assert.equal(fitrecRows.length, 1, "one FitRec row in why-not, not three");
});

test("grouping does not affect non-area places (dining/study unchanged)", () => {
  const places = [
    place("mugar", { activities: ["study"], area_id: null }),
    place("marciano", { activities: ["study"], area_id: null }),
  ];
  const histories = { mugar: hist(10), marciano: hist(10) };
  const r = recommend(req({ activity: "study", minActivity: 30, minutes: 90 }), makeCampus(places), histories);
  assert.equal(r.options.length, 2, "two separate study cards, never grouped");
  assert.ok(r.options.every((o) => !o.grouped));
});

test("unknown interest is reported as invalid input, not guessed", () => {
  const r = recommend(req({ interests: ["yoga"] }), makeCampus(fitrecAreas()), { fitrec: histWithAreas({ "weights-1": [1, "quiet"] }) });
  assert.deepEqual(r.errors?.map((e) => e.field), ["interests"]);
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
