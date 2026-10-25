import assert from "node:assert/strict";
import { test } from "node:test";
import { Tracker, iou } from "../web/counter/js/tracker.js";
import { LineCounter, PRESETS, measure } from "../web/counter/js/line.js";

// Simulated detections only: no camera, model, DOM or network.
const W = 640, H = 480, FRAME_MS = 33;
const person = (cx, cy = 240, score = 0.9) => ({ x: cx - 30, y: cy - 80, w: 60, h: 160, score });

/** Feeds frames (each a list of detections) through a fresh tracker + counter. */
function run(frames, { line = PRESETS.vertical, counter = new LineCounter(), tracker = new Tracker(), start = 0 } = {}) {
  const events = [];
  frames.forEach((dets, i) => {
    const now = start + i * FRAME_MS;
    events.push(...counter.update(tracker.update(dets, now), line, W, H, now));
  });
  return { counter, tracker, events };
}

const walk = (from, to, step, cy) => {
  const frames = [];
  for (let x = from; from < to ? x <= to : x >= to; x += from < to ? step : -step) frames.push([person(x, cy)]);
  return frames;
};

test("iou of identical, disjoint and half-overlapping boxes", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, { x: 20, y: 0, w: 10, h: 10 }), 0);
  assert.equal(iou(a, { x: 5, y: 0, w: 10, h: 10 }), 50 / 150);
});

test("default vertical line: the right side is In", () => {
  const right = measure(PRESETS.vertical, W, H, { x: 500, y: 240 }).dist;
  assert.ok(right < 0);
  assert.equal(new LineCounter().inSide, -1);
});

test("a track needs three matched frames before it gets an ID", () => {
  const tracker = new Tracker();
  tracker.update([person(100)], 0);
  tracker.update([person(105)], 33);
  assert.equal(tracker.tracks[0].id, null);
  tracker.update([person(110)], 66);
  assert.equal(tracker.tracks[0].id, 1);
});

test("one person walking left to right counts once, as In", () => {
  const { counter } = run(walk(100, 540, 10));
  assert.deepEqual(counter.counts, { in: 1, out: 0 });
});

test("walking right to left counts Out, and Flip swaps it to In", () => {
  assert.deepEqual(run(walk(540, 100, 10)).counter.counts, { in: 0, out: 1 });
  const flipped = new LineCounter();
  flipped.flip();
  assert.deepEqual(run(walk(540, 100, 10), { counter: flipped }).counter.counts, { in: 1, out: 0 });
});

test("someone who stays on one side is never counted", () => {
  assert.deepEqual(run(walk(400, 600, 5)).counter.counts, { in: 0, out: 0 });
});

test("crossing and coming straight back undoes the first count", () => {
  const frames = [...walk(200, 420, 10), ...walk(420, 200, 10)];
  const { counter, events } = run(frames);
  assert.deepEqual(counter.counts, { in: 0, out: 0 });
  assert.deepEqual(events.map(e => [e.dir, e.undo]), [["in", false], ["in", true]]);
});

test("coming back after the reversal window counts as a new Out", () => {
  const counter = new LineCounter({ reversalMs: 100 });
  const { counts } = run([...walk(200, 420, 10), ...walk(420, 200, 10)], { counter }).counter;
  assert.deepEqual(counts, { in: 1, out: 1 });
});

test("passing beyond the end of a short line is not a crossing", () => {
  const line = { a: { x: 0.5, y: 0.1 }, b: { x: 0.5, y: 0.3 } };
  assert.deepEqual(run(walk(100, 540, 10, 400), { line }).counter.counts, { in: 0, out: 0 });
});

test("moving the line resets sides, so nobody is counted by the move", () => {
  const counter = new LineCounter(), tracker = new Tracker();
  run(walk(100, 200, 10), { counter, tracker });           // stands left of the default line
  counter.lineChanged(tracker.tracks);
  const line = { a: { x: 0.1, y: 0.08 }, b: { x: 0.1, y: 0.92 } };   // line now left of them
  run(walk(200, 260, 10), { counter, tracker, line, start: 1000 });
  assert.deepEqual(counter.counts, { in: 0, out: 0 });
});

test("Reset zeroes the counts but keeps sides", () => {
  const counter = new LineCounter(), tracker = new Tracker();
  run(walk(100, 540, 10), { counter, tracker });
  counter.reset(tracker.tracks);
  run(walk(550, 600, 10), { counter, tracker, start: 2000 });
  assert.deepEqual(counter.counts, { in: 0, out: 0 });
});

test("two people walking in opposite directions keep separate IDs and both count", () => {
  const frames = [];
  for (let i = 0; i <= 44; i++) frames.push([person(100 + i * 10, 140), person(540 - i * 10, 360)]);
  const { counter, tracker } = run(frames);
  assert.deepEqual(counter.counts, { in: 1, out: 1 });
  assert.deepEqual(tracker.tracks.map(t => t.id).sort(), [1, 2]);
});

test("weak detections keep an existing track but never start one", () => {
  const tracker = new Tracker();
  for (let i = 0; i < 4; i++) tracker.update([person(100 + i * 5)], i * 33);
  const id = tracker.tracks[0].id;
  tracker.update([person(120, 240, 0.35)], 4 * 33);
  assert.equal(tracker.tracks.length, 1);
  assert.equal(tracker.tracks[0].id, id);
  assert.equal(tracker.tracks[0].misses, 0);
  assert.equal(new Tracker().update([person(100, 240, 0.35)], 0).length, 0);
});
