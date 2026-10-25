// Remembered planner preferences (web/js/prefs.js). Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
};
globalThis.location = { search: "" };

const prefs = await import("../web/js/prefs.js");
const campus = JSON.parse(readFileSync(new URL("../web/data/campus.json", import.meta.url), "utf-8"));

beforeEach(() => mem.clear());

test("first visit: visible defaults, no starting point assumed", () => {
  const d = prefs.defaults(campus, prefs.loadPrefs(campus), "workout");
  assert.deepEqual(d, {
    preparation: 5, cleanup: 5, access: {},
    from: "", to: null, minActivity: 35, buffer: campus.default_buffer,
    preferQuiet: true, preferShortTravel: false, needs: [],
  });
});

test("explicit choices are remembered; the next stop never is", () => {
  prefs.savePrefs({ from: "mugar", buffer: 15, preferQuiet: false, to: "warren" }, campus);
  prefs.savePrefs({ minByActivity: { study: 45 } }, campus);
  prefs.savePrefs({ minByActivity: { eat: 25 } }, campus);
  const saved = prefs.loadPrefs(campus);
  assert.equal(saved.to, undefined);
  const d = prefs.defaults(campus, saved, "study");
  assert.deepEqual([d.from, d.buffer, d.preferQuiet, d.minActivity, d.to], ["mugar", 15, false, 45, null]);
  assert.equal(prefs.defaults(campus, saved, "eat").minActivity, 25);      // per activity
  assert.equal(prefs.defaults(campus, saved, "workout").minActivity, 35);  // untouched: default
});

test("choosing 'Not set' clears the remembered starting point", () => {
  prefs.savePrefs({ from: "mugar" }, campus);
  prefs.savePrefs({ from: "" }, campus);
  assert.equal(prefs.defaults(campus, prefs.loadPrefs(campus), "eat").from, "");
});

test("bad or stale stored values are dropped, not trusted", () => {
  localStorage.setItem(prefs.PREFS_KEY, JSON.stringify({
    from: "demolished-hall", buffer: 500, preferQuiet: "yes", needs: ["outlets", "jacuzzi"], minByActivity: { nap: 20, study: 2 },
  }));
  assert.deepEqual(prefs.loadPrefs(campus), { needs: ["outlets"] });
  localStorage.setItem(prefs.PREFS_KEY, "{broken");
  assert.deepEqual(prefs.loadPrefs(campus), {});
});

test("reset returns every default", () => {
  prefs.savePrefs({ from: "west", buffer: 0, preferShortTravel: true, needs: ["outlets"] }, campus);
  prefs.resetPrefs();
  assert.deepEqual(prefs.defaults(campus, prefs.loadPrefs(campus), "study"),
    prefs.defaults(campus, {}, "study"));
});

test("older saved preferences receive per-activity preparation defaults", () => {
  localStorage.setItem(prefs.PREFS_KEY, JSON.stringify({buffer:15,minByActivity:{study:40}}));
  const saved=prefs.loadPrefs(campus);
  assert.deepEqual([prefs.defaults(campus,saved,"study").preparation,prefs.defaults(campus,saved,"study").cleanup],[3,2]);
  assert.equal(prefs.defaults(campus,saved,"study").minActivity,40);
  assert.deepEqual([prefs.defaults(campus,saved,"eat").preparation,prefs.defaults(campus,saved,"eat").cleanup],[5,2]);
});

test("preparation and cleanup persist per activity, reject malformed values and reset", () => {
  prefs.savePrefs({preparationByActivity:{study:8},cleanupByActivity:{study:4}},campus);
  prefs.savePrefs({preparationByActivity:{eat:9,workout:-1},cleanupByActivity:{eat:3,workout:999}},campus);
  const saved=prefs.loadPrefs(campus);
  assert.deepEqual(saved.preparationByActivity,{study:8,eat:9});
  assert.deepEqual(saved.cleanupByActivity,{study:4,eat:3});
  assert.equal(prefs.defaults(campus,saved,"workout").preparation,5);
  prefs.resetPrefs();
  assert.equal(prefs.defaults(campus,prefs.loadPrefs(campus),"study").preparation,3);
  assert.equal(prefs.defaults(campus,prefs.loadPrefs(campus),"study").cleanup,2);
});
