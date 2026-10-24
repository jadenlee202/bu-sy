// Static-mode meetups (no server): the browser store must follow the same rules
// as server/community_events.py. Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

// ---- a tiny browser: storage, location, fetch (no API -> static mode) ----
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
};
globalThis.location = { search: "" };
const seed = readFileSync(new URL("../web/data/community_events_seed.json", import.meta.url), "utf-8");
globalThis.fetch = async (url) => {
  if (String(url).includes("api/")) throw new TypeError("no server");
  if (String(url).endsWith("community_events_seed.json")) {
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => JSON.parse(seed) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const src = await import("../web/js/source.js");
const { esc } = await import("../web/js/ui.js");
const ev = src.communityEvents;
const KEY = "busy.events.v1";

const device = (token) => localStorage.setItem("busy.token", token);
const plusDays = (n) => new Date(Date.parse(`${src.campusNow().date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const event = (over = {}) => ({
  title: "Basketball run", place: "Climbing Wall", note: "", date: plusDays(3), start: "18:00", end: "20:00",
  host: "Ben", spots: 3, invite_only: true, ...over,
});
const status = async (p) => { try { await p; return 200; } catch (e) { return e.status; } };

beforeEach(() => { mem.clear(); device("host-device-1"); });

test("static mode is used when there is no API", async () => {
  assert.equal(await src.getMode(), "static");
});

test("examples load without exposing codes", async () => {
  const list = await ev.list();
  assert.ok(list.length && list.every((e) => e.example && e.invite_code === null));
});

test("invite flow: code needed, forgiving format, capacity, idempotent joins", async () => {
  const e = await ev.create(event());
  assert.match(e.invite_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  device("guest-device-1");
  assert.equal(await status(ev.join(e.id, { name: "Al", code: "NOPE" })), 403);
  assert.equal(await status(ev.join(e.id, { name: "Al" })), 403);
  const ok = await ev.join(e.id, { name: "Al", code: ` ${e.invite_code.toLowerCase().replace("-", " ")} ` });
  assert.ok(ok.joined && ok.invite_code === null);
  assert.equal((await ev.join(e.id, { name: "Al", code: e.invite_code })).going_count, 2); // no duplicate
  device("guest-device-2");
  await ev.join(e.id, { name: "Bo", code: e.invite_code });
  device("guest-device-3");
  assert.equal(await status(ev.join(e.id, { name: "Cy", code: e.invite_code })), 409);
});

test("only the host cancels; the host can't leave; leaving only removes yourself", async () => {
  const e = await ev.create(event({ invite_only: false, spots: null }));
  assert.equal(await status(ev.leave(e.id)), 400);
  device("guest-device-1");
  await ev.join(e.id, { name: "Al" });
  device("guest-device-2");
  await ev.join(e.id, { name: "Bo" });
  assert.equal((await ev.leave(e.id)).going_count, 2);
  assert.equal(await status(ev.cancel(e.id)), 403);
  device("host-device-1");
  await ev.cancel(e.id);
  assert.equal(await status(ev.join(e.id, { name: "Al" })), 404);
});

test("ended events are hidden and can't be joined", async () => {
  const e = await ev.create(event({ invite_only: false }));
  const stored = JSON.parse(localStorage.getItem(KEY));
  stored.find((x) => x.id === e.id).date = "2020-01-01";
  localStorage.setItem(KEY, JSON.stringify(stored));
  assert.ok(!(await ev.list()).some((x) => x.id === e.id));
  device("guest-device-1");
  assert.equal(await status(ev.join(e.id, { name: "Al" })), 410);
});

test("creation applies the server's limits", async () => {
  for (const bad of [
    { title: "   " }, { host: " " }, { title: "x".repeat(61) }, { note: "z".repeat(81) }, { title: "a\nb" },
    { start: "20:00", end: "18:00" }, { end: "99:99" }, { date: "2020-01-01" }, { date: plusDays(61) },
    { spots: 1 }, { spots: 201 },
  ]) {
    assert.equal(await status(ev.create(event(bad))), 422, JSON.stringify(bad));
  }
  const ok = await ev.create(event({ title: "  Run  " }));
  assert.equal(ok.title, "Run");
});

test("unreadable local storage falls back to the examples instead of breaking", async () => {
  localStorage.setItem(KEY, "{oops");
  assert.ok((await ev.list()).length > 0);
});

test("user text is escaped before it reaches the page", () => {
  assert.equal(esc(`<img src=x onerror="alert('1')">&`), "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;");
});
