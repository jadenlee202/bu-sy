import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { zonedInstant } from "../web/js/availability.js";
import { addMyEvent, eventProblem, loadMyEvents, myEventItems, removeMyEvent } from "../web/js/myevents.js";

class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.get(key) ?? null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}
beforeEach(() => Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true }));

let n = 0;
const id = () => `e${(n += 1)}`;

test("an added event is saved with only its title, date and times, in date order", () => {
  addMyEvent({ title: "  Gym with Sam ", date: "2026-10-28", start: "17:00", end: "18:00", extra: "dropped" }, id);
  addMyEvent({ title: "Lunch at Warren", date: "2026-10-27", start: "12:00", end: "12:45" }, id);
  const list = loadMyEvents();
  assert.deepEqual(list.map((e) => e.title), ["Lunch at Warren", "Gym with Sam"]);
  assert.deepEqual(Object.keys(list[1]).sort(), ["date", "end", "id", "start", "title"]);
});

test("an event that can't be placed is refused with a reason, and nothing is saved", () => {
  assert.equal(eventProblem({ title: "", date: "2026-10-27", start: "12:00", end: "13:00" }), "Give the event a name.");
  assert.equal(eventProblem({ title: "X", date: "2026-10-27", start: "13:00", end: "12:00" }), "The event has to end after it starts.");
  assert.equal(eventProblem({ title: "X", date: "2026-10-27", start: "", end: "12:00" }), "Choose a start and end time.");
  assert.equal(eventProblem({ title: "x".repeat(81), date: "2026-10-27", start: "12:00", end: "13:00" }), "Keep the name under 80 characters.");
  assert.throws(() => addMyEvent({ title: "X", date: "2026-10-27", start: "13:00", end: "13:00" }, id), /end after it starts/);
  assert.deepEqual(loadMyEvents(), []);
});

test("removing one event keeps the others; unreadable storage reads as none", () => {
  addMyEvent({ title: "A", date: "2026-10-27", start: "09:00", end: "10:00" }, () => "a");
  addMyEvent({ title: "B", date: "2026-10-27", start: "11:00", end: "12:00" }, () => "b");
  assert.deepEqual(removeMyEvent("a").map((e) => e.id), ["b"]);
  globalThis.localStorage.setItem("busy.myEvents.v1", "{not json");
  assert.deepEqual(loadMyEvents(), []);
});

test("saved events become busy calendar occurrences in campus time", () => {
  const [item] = myEventItems([{ id: "a", title: "A", date: "2026-10-27", start: "09:00", end: "10:00" }]);
  assert.equal(item.start, zonedInstant("2026-10-27", "09:00", "America/New_York"));
  assert.equal(item.end - item.start, 3_600_000);
  assert.equal(item.source, "mine");
  assert.equal(item.free, false);
});
