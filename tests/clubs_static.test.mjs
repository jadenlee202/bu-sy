// Static-mode club directory (no server): the browser store must follow the same rules
// as server/clubs.py, and its busyness hints must equal the server's. Run: node --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

// ---- a tiny browser: storage, location, fetch (no API -> static mode) ----
const mem = new Map();
let blocked = false;
globalThis.localStorage = {
  getItem: (k) => { if (blocked) throw new Error("blocked"); return mem.has(k) ? mem.get(k) : null; },
  setItem: (k, v) => { if (blocked) throw new Error("blocked"); mem.set(k, String(v)); },
};
globalThis.location = { search: "" };
const webData = (path) => readFileSync(new URL(`../web/data/${path}`, import.meta.url), "utf-8");
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api/")) throw new TypeError("no server");
  try {
    const body = webData(u.replace(/^data\//, ""));
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const src = await import("../web/js/source.js");
const clubs = src.clubs;
const SEED = JSON.parse(webData("clubs_seed.json"));
const KEY = "busy.clubs.v1";

const device = (token) => localStorage.setItem("busy.token", token);
const status = async (p) => { try { await p; return 200; } catch (e) { return e.status; } };
const club = (over = {}) => ({
  name: "Chess Club", category: "Social", description: "Casual and rated games.", activities: "",
  meeting_day: "Wednesday", meeting_start: "18:00", meeting_end: "19:00", location_id: "mugar-synthetic",
  location_text: "", officers: [], contact: "", requirements: "", requires_approval: false, capacity: 3,
  waitlist: true, upcoming: [], ...over,
});
const app = (over = {}) => ({ name: "Sam Student", email: "sam@bu.edu", year: "Sophomore", ...over });
/** Run one call as another device, then switch back (the token is read when the call starts). */
const as = async (token, fn) => {
  const before = localStorage.getItem("busy.token");
  device(token);
  try { return await fn(); } finally { device(before); }
};

beforeEach(() => { mem.clear(); blocked = false; device("organizer-device-1"); });

test("static mode is used when there is no API", async () => {
  assert.equal(await src.getMode(), "static");
});

test("busyness hints equal the server's, for every sample club", async () => {
  for (const s of SEED.clubs) {
    const mine = await src.meetingBusyness(s.location_id, s.meeting_start, s.meeting_end);
    assert.deepEqual(mine, s.busyness_hint, s.name);
  }
  assert.ok(SEED.clubs.some((s) => s.busyness_hint?.estimate != null), "at least one real estimate is compared");
});

test("limits match the server's exported options", () => {
  assert.equal(src.CLUB_MAX_MEMBERS, SEED.options.limits.capacity);
  assert.equal(src.CLUB_MAX_WAITLIST, SEED.options.limits.waitlist);
});

test("sample clubs load with every status, labeled, and nobody runs them", async () => {
  const list = await clubs.list();
  assert.equal(list.length, SEED.clubs.length);
  assert.deepEqual(new Set(list.map((c) => c.status)), new Set(["Open", "Waitlist", "Full"]));
  assert.ok(list.every((c) => c.example && !c.is_organizer && !("applications" in c) && !("organizer_token" in c)));
  device("example");
  assert.ok((await clubs.list()).every((c) => !c.is_organizer));
  assert.equal(await status(clubs.applications(list[0].id)), 403);
});

test("create: the creator is the organizer; others aren't", async () => {
  const c = await clubs.create(club());
  assert.ok(c.is_organizer && c.status === "Open" && c.spots_left === 3);
  assert.equal(c.busyness_hint.level, (await src.meetingBusyness("mugar-synthetic", "18:00", "19:00")).level);
  const other = await as("student-device-1", () => clubs.get(c.id));
  assert.equal(other.is_organizer, false);
});

test("sign-up: approved or pending, duplicates refused", async () => {
  const open = await clubs.create(club());
  const reviewed = await clubs.create(club({ name: "Debate", requires_approval: true }));
  device("student-device-1");
  assert.equal((await clubs.apply(open.id, app())).my_application.status, "approved");
  assert.equal((await clubs.apply(reviewed.id, app())).my_application.status, "pending");
  assert.equal(await status(clubs.apply(open.id, app())), 409);
  assert.equal((await clubs.get(open.id)).members, 1);
});

test("full club: waitlist only when asked for, never an unbounded join", async () => {
  const c = await clubs.create(club({ capacity: 1 }));
  await as("student-device-1", () => clubs.apply(c.id, app()));
  device("student-device-2");
  await assert.rejects(clubs.apply(c.id, app()), (e) => e.status === 409 && /waitlist instead/.test(e.message));
  const w = await clubs.apply(c.id, app({ join_waitlist: true }));
  assert.deepEqual([w.my_application.status, w.my_application.position, w.members], ["waitlisted", 1, 1]);
  device("organizer-device-1");
  const shut = await clubs.create(club({ name: "Tiny", capacity: 1, waitlist: false }));
  await as("student-device-1", () => clubs.apply(shut.id, app()));
  await assert.rejects(as("student-device-2", () => clubs.apply(shut.id, app({ join_waitlist: true }))), (e) => e.status === 409);
  assert.equal((await clubs.get(shut.id)).status, "Full");
});

test("simultaneous sign-ups can't overfill a club", async () => {
  const c = await clubs.create(club({ capacity: 3 }));
  const attempts = [];
  for (let i = 0; i < 10; i++) { device(`student-device-${i}`); attempts.push(status(clubs.apply(c.id, app()))); }
  const results = await Promise.all(attempts);
  assert.equal(results.filter((s) => s === 200).length, 3);
  assert.equal((await clubs.get(c.id)).members, 3);
});

test("withdrawing moves the waitlist up in order; to pending when approval is required", async () => {
  const c = await clubs.create(club({ capacity: 1, requires_approval: true }));
  await as("student-device-1", () => clubs.apply(c.id, app()));
  await as("student-device-2", () => clubs.apply(c.id, app({ join_waitlist: true })));
  await as("student-device-3", () => clubs.apply(c.id, app({ join_waitlist: true })));
  assert.equal((await as("student-device-3", () => clubs.get(c.id))).my_application.position, 2);
  assert.equal((await as("student-device-1", () => clubs.withdraw(c.id))).my_application, null);
  assert.equal((await as("student-device-2", () => clubs.get(c.id))).my_application.status, "pending");
  assert.equal((await as("student-device-3", () => clubs.get(c.id))).my_application.position, 1);
  assert.equal(await as("student-device-1", () => status(clubs.withdraw(c.id))), 404);
});

test("approval flow and organizer-only gating", async () => {
  const c = await clubs.create(club({ capacity: 1, requires_approval: true }));
  await as("student-device-1", () => clubs.apply(c.id, app({ name: "Private Person", email: "Private@BU.edu" })));
  await as("student-device-2", () => clubs.apply(c.id, app({ join_waitlist: true })));
  for (const t of ["student-device-1", "student-device-2"]) {
    device(t);
    assert.equal(await status(clubs.applications(c.id)), 403);
    assert.equal(await status(clubs.edit(c.id, club({ name: "Hijacked" }))), 403);
    assert.equal(await status(clubs.decide(c.id, "x", "approve")), 403);
    const seen = JSON.stringify(await clubs.list()) + JSON.stringify(await clubs.get(c.id));
    assert.ok(!seen.includes("Private Person") && !seen.includes("private@bu.edu") && !seen.includes("organizer-device-1"));
  }
  device("organizer-device-1");
  const [pending, waiting] = await clubs.applications(c.id);
  assert.deepEqual([pending.status, pending.email, waiting.status, waiting.position], ["pending", "private@bu.edu", "waitlisted", 1]);
  assert.equal(await status(clubs.decide(c.id, waiting.id, "approve")), 409);      // no free spot
  assert.equal((await clubs.decide(c.id, pending.id, "approve")).members, 1);
  await clubs.decide(c.id, pending.id, "reject");                                   // frees the spot
  assert.equal((await as("student-device-2", () => clubs.get(c.id))).my_application.status, "pending");
  assert.equal(await as("student-device-1", () => status(clubs.apply(c.id, app()))), 409);   // declined stays declined
  assert.equal(await status(clubs.apply(c.id, app())), 400);                        // organizers don't apply
});

test("edit: capacity can't drop below approved members; raising it moves the waitlist up", async () => {
  const c = await clubs.create(club({ capacity: 1 }));
  await as("student-device-1", () => clubs.apply(c.id, app()));
  await as("student-device-2", () => clubs.apply(c.id, app({ join_waitlist: true })));
  assert.equal((await clubs.edit(c.id, club({ capacity: 2 }))).members, 2);
  await assert.rejects(clubs.edit(c.id, club({ capacity: 1 })), (e) => e.status === 409);
});

test("validation matches the server", async () => {
  const c = await clubs.create(club());
  device("student-device-1");
  for (const bad of [{ email: "sam@gmail.com" }, { email: "sam@bu.edu.evil.com" }, { name: "  " }, { name: "x".repeat(61) },
    { name: "a\nb" }, { year: "Freshman" }, { reason: "r".repeat(501) }, { availability: "a".repeat(121) }]) {
    assert.equal(await status(clubs.apply(c.id, app(bad))), 422, JSON.stringify(bad));
  }
  device("organizer-device-1");
  for (const bad of [{ name: "" }, { category: "Gaming" }, { description: " " }, { meeting_end: null },
    { meeting_start: "19:00", meeting_end: "18:00" }, { capacity: 0 }, { capacity: 501 },
    { location_id: "COD_Bosch_Office_1_Clemente" }, { upcoming: [{ date: "2020-01-01", note: "" }] },
    { officers: Array(6).fill({ role: "P", name: "x" }) }]) {
    assert.equal(await status(clubs.create(club(bad))), 422, JSON.stringify(bad));
  }
});

test("missing details stay empty, never invented", async () => {
  const board = (await clubs.list()).find((c) => c.name === "Board Game Night");
  assert.deepEqual([board.meeting_day, board.next_meeting, board.busyness_hint, board.officers], [null, null, null, []]);
});

test("unreadable storage falls back to the sample clubs", async () => {
  localStorage.setItem(KEY, "{oops");
  assert.equal((await clubs.list()).length, SEED.clubs.length);
});

test("blocked storage still works for this tab and says it won't persist", async () => {
  blocked = true;
  const c = await clubs.create(club());
  assert.equal(clubs.persistent, false);
  assert.ok((await clubs.list()).some((x) => x.id === c.id));
});
