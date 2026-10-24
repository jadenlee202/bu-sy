// Browser tests for the pilot counter. Open tests.html, or run: python tools/manual-counting/run_tests.py
import * as S from "./session.js";
import { KEY, PREVIOUS_KEY, UNREADABLE_KEY, makeStore } from "./store.js";

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const T0 = new Date(2026, 9, 28, 14, 0, 0);
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const SETUP = { name: "Room test 1", facilityId: "PILOT_TEST_ROOM", sensorId: "PILOT_TEST_ROOM_D1", startOccupancy: "2" };
const fresh = (over = {}) => S.createSession({ ...SETUP, ...over }, T0).session;
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const csvRows = (text) => text.trimEnd().split("\r\n").map((l) => l.split(","));

// ---------- starting counts ----------
test("starting occupancy sets the estimate", () => {
  const s = fresh({ startOccupancy: "7" });
  eq(S.summarize(s).estimate, 7);
  eq(s.records.map((r) => r.type), ["start"]);
  eq(s.facility_id, "PILOT_TEST_ROOM");
});
test("starting occupancy of zero is valid", () => eq(S.summarize(fresh({ startOccupancy: "0" })).estimate, 0));
test("ids are uppercased and trimmed", () => {
  const s = fresh({ facilityId: " pilot_lower ", sensorId: "pilot_lower_d2" });
  eq([s.facility_id, s.sensor_id], ["PILOT_LOWER", "PILOT_LOWER_D2"]);
});

// ---------- invalid counts ----------
test("parseCount rejects everything but whole numbers 0..MAX", () => {
  for (const bad of ["", "  ", "-1", "2.5", "1e3", "12abc", "abc", "+3", "0x10", String(S.MAX_COUNT + 1)]) {
    ok(!S.parseCount(bad).ok, `accepted ${JSON.stringify(bad)}`);
  }
  eq(S.parseCount(" 12 "), { ok: true, value: 12 });
  eq(S.parseCount("0").value, 0);
  eq(S.parseCount(String(S.MAX_COUNT)).value, S.MAX_COUNT);
});
test("setup reports every invalid field and creates nothing", () => {
  const r = S.createSession({ name: "", facilityId: "ROOM1", sensorId: "bad id!", startOccupancy: "-1" });
  eq(r.ok, false);
  eq(Object.keys(r.errors).sort(), ["facilityId", "name", "sensorId", "startOccupancy"]);
});
test("facility id must carry the PILOT_ prefix", () => {
  ok(!S.validateSetup({ ...SETUP, facilityId: "COD_Bosch_Office_1_Clemente" }).ok, "accepted a real dataset id");
  ok(!S.validateSetup({ ...SETUP, facilityId: "fitrec-synthetic" }).ok, "accepted a synthetic app id");
});
test("invalid headcount is rejected without a record", () => {
  const s = fresh();
  for (const bad of ["", "-3", "4.5", "lots"]) eq(S.addHeadcount(s, bad).ok, false, bad);
  eq(s.records.length, 1);
});
test("overlong headcount note is rejected", () => eq(S.addHeadcount(fresh(), "3", "x".repeat(141)).ok, false));
test("addEvent rejects unknown directions", () => {
  let threw = false;
  try { S.addEvent(fresh(), "sideways"); } catch { threw = true; }
  ok(threw, "no error");
});

// ---------- entries and exits ----------
test("entries and exits move the estimate", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1)); S.addEvent(s, "in", at(2)); S.addEvent(s, "in", at(3)); S.addEvent(s, "out", at(4));
  const sum = S.summarize(s);
  eq([sum.entries, sum.exits, sum.estimate], [3, 1, 4]);
  eq(S.timeline(s).map((t) => t.estimate), [2, 3, 4, 5, 4]);
});
test("record ids are unique and seq increases", () => {
  const s = fresh();
  for (let i = 0; i < 200; i++) S.addEvent(s, i % 3 ? "in" : "out", at(i));
  eq(new Set(s.records.map((r) => r.id)).size, s.records.length);
  eq(s.records.map((r) => r.seq), s.records.map((_, i) => i + 1));
});
test("timestamps carry a UTC offset and round-trip to the same instant", () => {
  const d = new Date(2026, 10, 1, 1, 30, 15, 250); // around the US DST change
  const iso = S.isoLocal(d);
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(iso), iso);
  eq(Date.parse(iso), d.getTime());
  const s = fresh();
  ok(s.records.every((r) => /[+-]\d\d:\d\d$/.test(r.ts)), "record without offset");
  ok(s.time_zone.length > 0, "no time zone name");
});

// ---------- negative occupancy ----------
test("negative estimate is flagged, not clamped, and events are kept", () => {
  const s = fresh({ startOccupancy: "1" });
  S.addEvent(s, "out", at(1)); S.addEvent(s, "out", at(2)); S.addEvent(s, "out", at(3));
  const sum = S.summarize(s);
  eq([sum.estimate, sum.negative, sum.exits], [-2, true, 3]);
  eq(S.timeline(s).map((t) => t.negative), [false, false, true, true]);
  ok(S.occupancyCsv(s).includes(",-2\r\n"), "occupancy CSV hid the negative value");
  ok(S.auditCsv(s).includes("negative_estimate"), "audit CSV lost the flag");
});
test("reconciling a negative estimate clears the flag and records the correction", () => {
  const s = fresh({ startOccupancy: "0" });
  S.addEvent(s, "out", at(1));
  const hc = S.addHeadcount(s, "0", "", at(2)).record;
  S.reconcile(s, hc.id, at(3));
  const sum = S.summarize(s);
  eq([sum.estimate, sum.negative, sum.corrections, sum.exits], [0, false, 1, 1]);
});

// ---------- undo ----------
test("undo cancels the newest event and keeps it in the audit trail", () => {
  const s = fresh();
  const a = S.addEvent(s, "in", at(1));
  const b = S.addEvent(s, "in", at(2));
  const r = S.undoLast(s, at(3));
  eq([r.ok, r.target.id, r.record.target_id], [true, b.id, b.id]);
  eq(S.summarize(s).estimate, 3);
  eq(s.records.length, 4, "original event must not be deleted");
  const t = S.timeline(s).find((x) => x.record.id === b.id);
  eq(t.undone, true);
  S.undoLast(s, at(4));
  eq(S.summarize(s).undo.reason, "Nothing to undo.");
  eq(S.summarize(s).estimate, 2);
  eq(S.timeline(s).find((x) => x.record.id === a.id).undone, true);
});
test("undo with nothing to undo fails cleanly", () => {
  const s = fresh();
  eq(S.undoLast(s).ok, false);
  eq(s.records.length, 1);
});
test("undo cannot reach behind a reconciliation", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1));
  const hc = S.addHeadcount(s, "3", "", at(2)).record;
  S.reconcile(s, hc.id, at(3));
  const r = S.undoLast(s, at(4));
  eq(r.ok, false);
  ok(/reconciliation/.test(r.error), r.error);
  S.addEvent(s, "out", at(5));
  eq(S.undoLast(s, at(6)).ok, true, "events after the correction can still be undone");
  eq(S.summarize(s).estimate, 3);
});
test("undone events are left out of events and occupancy CSVs but kept in the audit", () => {
  const s = fresh();
  const a = S.addEvent(s, "in", at(1));
  S.undoLast(s, at(2));
  ok(!S.eventsCsv(s).includes(a.id), "undone event exported as an event");
  eq(csvRows(S.occupancyCsv(s)).length, 2, "occupancy should hold only the start row");
  const audit = csvRows(S.auditCsv(s));
  ok(audit.some((r) => r[1] === a.id && r[9] === "undone"), "audit lost the undone event");
  ok(audit.some((r) => r[2] === "undo" && r[10] === a.id), "audit lost the undo record");
});

// ---------- headcounts and corrections ----------
test("headcount reports the difference (estimate − headcount)", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1)); S.addEvent(s, "in", at(2));
  S.addHeadcount(s, "3", "after group", at(3));
  const h = S.latestHeadcount(s);
  eq([h.estimate, h.record.observed, h.difference, h.reconciled], [4, 3, 1, false]);
  eq(S.summarize(s).estimate, 4, "a headcount alone must not change the estimate");
});
test("reconcile records the correction; later events count on top of it", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1));
  const hc = S.addHeadcount(s, "6", "", at(2)).record;
  S.addEvent(s, "in", at(3)); // between headcount and reconcile
  const r = S.reconcile(s, hc.id, at(4));
  eq([r.ok, r.record.from, r.record.to, r.record.adjustment], [true, 3, 6, 3]);
  eq(S.summarize(s).estimate, 7);
  eq(S.latestHeadcount(s).reconciled, true);
});
test("a headcount can be reconciled only once, and only the newest", () => {
  const s = fresh();
  const h1 = S.addHeadcount(s, "1", "", at(1)).record;
  const h2 = S.addHeadcount(s, "4", "", at(2)).record;
  eq(S.reconcile(s, h1.id, at(3)).ok, false);
  eq(S.reconcile(s, h2.id, at(4)).ok, true);
  eq(S.reconcile(s, h2.id, at(5)).ok, false);
  eq(s.records.filter((r) => r.type === "reconcile").length, 1);
  eq(S.summarize(s).estimate, 4);
});
test("a matching headcount reconciles with a zero adjustment", () => {
  const s = fresh();
  const hc = S.addHeadcount(s, "2", "", at(1)).record;
  eq(S.reconcile(s, hc.id, at(2)).record.adjustment, 0);
});
test("undoing an event before an open headcount updates its difference", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1));
  S.addHeadcount(s, "2", "", at(2));
  eq(S.latestHeadcount(s).difference, 1);
  S.undoLast(s, at(3));
  eq(S.latestHeadcount(s).difference, 0);
  eq(S.latestHeadcount(s).record.estimate_at_capture, 3, "audit snapshot must not change");
});

// ---------- duplicates ----------
test("merge of two tab copies keeps each record once", () => {
  const a = fresh();
  S.addEvent(a, "in", at(1));
  const b = structuredClone(a);
  S.addEvent(a, "in", at(2));     // tab A
  S.addEvent(b, "out", at(3));    // tab B, same seq number as A's tap
  const m = S.merge(a, b);
  eq(m.records.length, 4);
  eq(new Set(m.records.map((r) => r.id)).size, 4);
  eq(m.records.map((r) => r.seq), [1, 2, 3, 4]);
  eq(S.summarize(m).estimate, 3);
  eq(S.merge(m, m).records.length, 4, "merge must be idempotent");
});
test("merge ignores a different session", () => {
  const a = fresh(), b = fresh();
  eq(S.merge(a, b), a);
});
test("restore drops duplicate record ids", () => {
  const s = fresh();
  const e = S.addEvent(s, "in", at(1));
  const r = S.restore({ ...s, records: [...s.records, { ...e }] });
  eq([r.ok, r.session.records.length, S.summarize(r.session).estimate], [true, 2, 3]);
});
test("restore rejects malformed data", () => {
  for (const bad of [null, {}, { schema: 1 }, { ...fresh(), schema: 99 }, { ...fresh(), records: [{ id: 1 }] }, { ...fresh(), records: [] }]) {
    eq(S.restore(bad).ok, false);
  }
});

// ---------- export format ----------
test("events CSV matches event_template.csv", () => {
  const s = fresh();
  const e = S.addEvent(s, "in", at(1));
  S.addEvent(s, "out", at(2));
  const rows = csvRows(S.eventsCsv(s));
  eq(rows[0], ["event_id", "facility_id", "sensor_id", "timestamp", "direction", "count"]);
  eq(rows[1], [e.id, "PILOT_TEST_ROOM", "PILOT_TEST_ROOM_D1", e.ts, "in", "1"]);
  eq(rows[2][4], "out");
  eq(rows.length, 3);
});
test("headcounts CSV matches headcount_template.csv and quotes free text", () => {
  const s = fresh();
  S.addHeadcount(s, "3", 'door "A", busy', at(1));
  S.addHeadcount(s, "4", "=HYPERLINK(1)", at(2));
  const text = S.headcountsCsv(s);
  const lines = text.trimEnd().split("\r\n");
  eq(lines[0], "facility_id,timestamp,observed_count,observer_note");
  ok(lines[1].endsWith(',3,"door ""A"", busy"'), lines[1]);
  ok(lines[2].endsWith(",4,'=HYPERLINK(1)"), `formula not neutralised: ${lines[2]}`);
});
test("occupancy CSV uses the data/*.csv columns", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1));
  const hc = S.addHeadcount(s, "5", "", at(2)).record;
  S.reconcile(s, hc.id, at(3));
  const rows = csvRows(S.occupancyCsv(s));
  eq(rows[0], ["facility_id", "timestamp", "occupancy_count"]);
  eq(rows.slice(1).map((r) => r[2]), ["2", "3", "5"]);
});
test("audit CSV has one row per record with a constant column count", () => {
  const s = fresh();
  S.addEvent(s, "in", at(1)); S.undoLast(s, at(2));
  const hc = S.addHeadcount(s, "2", "ok, fine", at(3)).record;
  S.reconcile(s, hc.id, at(4));
  const lines = S.auditCsv(s).trimEnd().split("\r\n");
  eq(lines.length, 1 + s.records.length);
  const width = lines[0].split(",").length;
  for (const l of lines.slice(1)) eq(l.replace(/"[^"]*"/g, "x").split(",").length, width, l);
  ok(lines.slice(1).every((l) => l.endsWith(",manual_controlled_pilot")), "missing data_origin");
});
test("export names identify the pilot and facility", () => {
  ok(/^manual-pilot_PILOT_TEST_ROOM_\d{8}-\d{4}_events\.csv$/.test(S.exportName(fresh(), "events", T0)), S.exportName(fresh(), "events", T0));
});

// ---------- refresh recovery (storage) ----------
test("a saved session loads back identically in a new store", () => {
  const storage = memStorage();
  const s = fresh();
  S.addEvent(s, "in", at(1)); S.undoLast(s, at(2));
  makeStore(storage).save(s);
  const r = makeStore(storage).load();
  eq(r.session, s);
});
test("save merges with another tab's copy instead of overwriting it", () => {
  const storage = memStorage();
  const a = fresh();
  makeStore(storage).save(a);
  const b = structuredClone(a);
  S.addEvent(b, "out", at(5));
  makeStore(storage).save(b);           // other tab saved first
  S.addEvent(a, "in", at(6));
  const merged = makeStore(storage).save(a);
  eq(merged.records.length, 3);
  eq(makeStore(storage).load().session.records.length, 3);
});
test("unreadable saved data is kept aside, not overwritten", () => {
  const storage = memStorage();
  storage.setItem(KEY, "{not json");
  const r = makeStore(storage).load();
  eq([r.session, typeof r.error], [null, "string"]);
  eq(storage.getItem(UNREADABLE_KEY), "{not json");
});
test("reset archives the session as previous", () => {
  const storage = memStorage();
  const store = makeStore(storage);
  const s = fresh();
  store.save(s);
  store.archive(s);
  eq(store.load().session, null);
  eq(store.previous().session_id, s.session_id);
});

// ---------- end to end: the real page in an iframe, including a reload ----------
const frame = () => document.getElementById("app");
const loadFrame = () => new Promise((resolve) => { frame().onload = () => setTimeout(resolve, 50); frame().src = "index.html"; });
const reloadFrame = () => new Promise((resolve) => { frame().onload = () => setTimeout(resolve, 50); frame().contentWindow.location.reload(); });
const tick = () => new Promise((r) => setTimeout(r, 50));
const q = (id) => frame().contentDocument.getElementById(id);
const click = (id, n = 1) => { for (let i = 0; i < n; i++) q(id).click(); };
function fill(formId, values) {
  const f = q(formId);
  for (const [k, v] of Object.entries(values)) f.elements[k].value = v;
  f.requestSubmit();
}

test("UI: setup, count, undo, headcount, reconcile, reload, negative flag, reset", async () => {
  localStorage.removeItem(KEY); localStorage.removeItem(PREVIOUS_KEY);
  await loadFrame();
  ok(!q("setup").hidden && q("count").hidden, "setup not shown first");
  ok(frame().contentDocument.body.textContent.includes(S.LABEL), "pilot label missing");

  fill("setup-form", { name: "UI run", facilityId: "ROOM1", sensorId: "D1", startOccupancy: "-1" });
  ok(q("count").hidden, "invalid setup started a session");
  ok(frame().contentDocument.querySelector('[data-for="facilityId"]').textContent.length > 0, "no facility error");
  ok(frame().contentDocument.querySelector('[data-for="startOccupancy"]').textContent.length > 0, "no count error");

  fill("setup-form", { name: "UI run", facilityId: "PILOT_UI", sensorId: "PILOT_UI_D1", startOccupancy: "2" });
  eq(q("estimate").textContent, "2");
  click("btn-in", 3); click("btn-out");
  eq(q("estimate").textContent, "4");
  click("btn-undo");
  eq(q("estimate").textContent, "5");
  eq(frame().contentDocument.querySelectorAll("#log li.undone").length, 1);

  fill("hc-form", { observed: "abc", note: "" });
  ok(q("hc-err").textContent.length > 0, "invalid headcount accepted");
  fill("hc-form", { observed: "7", note: "pilot check" });
  ok(/difference -2/.test(q("hc-text").textContent), q("hc-text").textContent);
  click("btn-reconcile");
  eq(q("estimate").textContent, "7");
  ok(q("btn-reconcile").disabled, "reconcile still enabled");

  await reloadFrame();
  ok(!q("count").hidden, "session not restored after reload");
  eq(q("estimate").textContent, "7");
  eq(frame().contentDocument.querySelectorAll("#log li").length, 8); // start, 3 in, out, undo, headcount, correction
  ok(/restored/i.test(q("sync-note").textContent), "no restore notice");

  click("btn-out", 8);
  eq(q("estimate").textContent, "-1");
  ok(!q("negative").hidden, "negative estimate not flagged");

  click("btn-reset");
  ok(q("reset-dialog").open, "reset did not ask for confirmation");
  click("reset-cancel");
  await tick();
  ok(!q("reset-dialog").open && !q("count").hidden, "cancel reset cleared the session");
  click("btn-reset");
  click("reset-confirm");
  ok(!q("setup").hidden, "reset did not return to setup");
  ok(!q("previous").hidden, "reset kept no previous copy");
  await reloadFrame();
  ok(!q("setup").hidden, "reset session came back after reload");
});

// ---------- runner ----------
async function run() {
  // Don't let tests clobber a real pilot session saved in this browser.
  const saved = [KEY, PREVIOUS_KEY, UNREADABLE_KEY].map((k) => [k, localStorage.getItem(k)]);
  try {
    for (const t of tests) {
      try { await t.fn(); results.push({ name: t.name, ok: true }); }
      catch (e) { results.push({ name: t.name, ok: false, error: e.message }); }
    }
  } finally {
    for (const [k, v] of saved) v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  }
  const failed = results.filter((r) => !r.ok);
  document.getElementById("results").innerHTML = results
    .map((r) => `<li class="${r.ok ? "pass" : "fail"}">${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error.replace(/</g, "&lt;")}`}</li>`)
    .join("");
  document.getElementById("summary").textContent = `RESULT pass=${results.length - failed.length} fail=${failed.length}`;
}
run();
