// Isolated checks for the availability prototype. Run with:  node --test test/
// Uses only node:test and node:assert (built in; no dependencies).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildSnapshot,
  computeFreeGaps,
  fromManualWindows,
  isStale,
  normalizeGoogleFreeBusy,
  resolvePlanningWindows,
} from '../src/availability.mjs';
import { parseInstant, zonedWallTimeToInstant, formatInstant } from '../src/time.mjs';

const load = (f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const pairs = (list) => list.map((w) => [w.start, w.end]);
const triples = (list) => list.map((w) => [w.start, w.end, w.durationMinutes]);
const T = (s) => parseInstant(s);

// --- table-driven snapshot cases --------------------------------------------

for (const c of load('snapshot-cases.json').cases) {
  test(`snapshot: ${c.name}`, () => {
    const snap = buildSnapshot(c.input);
    assert.equal(snap.status, c.expected.status, JSON.stringify(snap.issues));
    assert.deepEqual(pairs(snap.busyIntervals), c.expected.busyIntervals);
    assert.deepEqual(triples(snap.freeWindows), c.expected.freeWindows);
    if ('requiresUserConfirmation' in c.expected) {
      assert.equal(snap.requiresUserConfirmation, c.expected.requiresUserConfirmation);
    }
    if ('invalidIntervalIssues' in c.expected) {
      assert.equal(snap.issues.filter((i) => i.code === 'invalid_interval').length, c.expected.invalidIntervalIssues);
    }
    // Every snapshot is self-describing.
    assert.equal(snap.schema, 'busy.availability/v1');
    assert.equal(snap.planning.timeZone, c.input.request.timeZone);
    assert.equal(snap.planning.selectedDate, c.input.request.selectedDate);
    assert.equal(snap.retrievedAt, c.input.retrievedAt);
    assert.equal(snap.source.kind, c.input.source.kind);
  });
}

// --- core pure function -----------------------------------------------------

test('computeFreeGaps: adjacent intervals merge into one busy block', () => {
  const w = { start: 0, end: 600 * 60_000 };
  const { mergedBusy, free } = computeFreeGaps(
    [{ start: 60 * 60_000, end: 120 * 60_000 }, { start: 120 * 60_000, end: 180 * 60_000 }],
    w,
    30,
  );
  assert.deepEqual(mergedBusy, [{ start: 60 * 60_000, end: 180 * 60_000 }]);
  assert.equal(free.length, 2);
});

test('computeFreeGaps: contained interval does not shrink the outer one', () => {
  const { mergedBusy } = computeFreeGaps(
    [{ start: 0, end: 100 }, { start: 10, end: 20 }],
    { start: 0, end: 10_000_000 },
    1,
  );
  assert.deepEqual(mergedBusy, [{ start: 0, end: 100 }]);
});

test('computeFreeGaps: unsorted input gives the same result as sorted input', () => {
  const busy = [
    { start: 5e6, end: 6e6 }, { start: 1e6, end: 2e6 }, { start: 1.5e6, end: 3e6 },
  ];
  const w = { start: 0, end: 1e7 };
  assert.deepEqual(computeFreeGaps(busy, w, 1), computeFreeGaps([...busy].reverse(), w, 1));
});

test('computeFreeGaps: gap exactly equal to minimum is kept; one ms shorter is dropped', () => {
  const w = { start: 0, end: 90 * 60_000 };
  assert.equal(computeFreeGaps([{ start: 30 * 60_000, end: 90 * 60_000 }], w, 30).free.length, 1);
  assert.equal(computeFreeGaps([{ start: 30 * 60_000 - 1, end: 90 * 60_000 }], w, 30).free.length, 0);
});

test('computeFreeGaps: intervals fully outside the window are ignored', () => {
  const { mergedBusy, free } = computeFreeGaps(
    [{ start: -5000, end: -1000 }, { start: 2e7, end: 3e7 }],
    { start: 0, end: 1e7 },
    1,
  );
  assert.deepEqual(mergedBusy, []);
  assert.deepEqual(free, [{ start: 0, end: 1e7 }]);
});

test('computeFreeGaps: is pure (does not mutate input)', () => {
  const busy = [{ start: 3e6, end: 5e6 }, { start: 1e6, end: 4e6 }];
  const copy = structuredClone(busy);
  computeFreeGaps(busy, { start: 2e6, end: 6e6 }, 1);
  assert.deepEqual(busy, copy);
});

test('computeFreeGaps: rejects invalid window, minimum, or unvalidated interval', () => {
  assert.throws(() => computeFreeGaps([], { start: 10, end: 10 }, 30), RangeError);
  assert.throws(() => computeFreeGaps([], { start: 0, end: 10 }, 0), RangeError);
  assert.throws(() => computeFreeGaps([{ start: 5, end: 1 }], { start: 0, end: 10 }, 1), RangeError);
  assert.throws(() => computeFreeGaps([{ start: NaN, end: 1 }], { start: 0, end: 10 }, 1), RangeError);
});

// --- time zones and DST -----------------------------------------------------

test('time zones: the same instants written with different offsets give identical output', () => {
  const base = load('snapshot-cases.json').cases[0].input;
  const shifted = structuredClone(base);
  shifted.calendars[0].busy = base.calendars[0].busy.map(({ start, end }) => ({
    start: formatInstant(T(start), 'Asia/Kolkata'),
    end: formatInstant(T(end), 'Asia/Kolkata'),
  }));
  assert.match(shifted.calendars[0].busy[0].start, /\+05:30$/);
  assert.deepEqual(buildSnapshot(shifted).freeWindows, buildSnapshot(base).freeWindows);
});

test('time zones: output is rendered in the requested planning zone', () => {
  const input = structuredClone(load('snapshot-cases.json').cases[1].input);
  input.request.timeZone = 'Europe/London';
  const snap = buildSnapshot(input);
  assert.deepEqual(triples(snap.freeWindows), [['2026-10-26T09:00:00+00:00', '2026-10-26T17:00:00+00:00', 480]]);
  assert.ok(snap.freeWindows.every((w) => w.timeZone === 'Europe/London'));
});

test('DST: planning start in the spring-forward gap is shifted forward and reported', () => {
  const r = resolvePlanningWindows({
    selectedDate: '2026-03-08', timeZone: 'America/New_York', dailyStart: '02:30', dailyEnd: '06:00', minDurationMinutes: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(formatInstant(r.windows[0].start, 'America/New_York'), '2026-03-08T03:30:00-04:00');
  assert.equal((r.windows[0].end - r.windows[0].start) / 60_000, 150);
  assert.ok(r.issues.some((i) => i.code === 'dst_nonexistent_shifted_forward'));
});

test('DST: ambiguous fall-back wall time resolves to the earlier instant and is reported', () => {
  const res = zonedWallTimeToInstant({ year: 2026, month: 11, day: 1 }, 90, 'America/New_York');
  assert.equal(res.resolution, 'ambiguous_used_earlier');
  assert.equal(formatInstant(res.ms, 'America/New_York'), '2026-11-01T01:30:00-04:00');
});

test('DST: a multi-day horizon across fall-back keeps each local day aligned', () => {
  const r = resolvePlanningWindows({
    selectedDate: '2026-10-31', horizonDays: 3, timeZone: 'America/New_York', dailyStart: '09:00', dailyEnd: '17:00',
  });
  assert.deepEqual(
    r.windows.map((w) => formatInstant(w.start, 'America/New_York')),
    ['2026-10-31T09:00:00-04:00', '2026-11-01T09:00:00-05:00', '2026-11-02T09:00:00-05:00'],
  );
});

// --- partial provider failure (Google-shaped synthetic response) ------------

test('partial failure: failed and missing calendars are reported; windows need confirmation', () => {
  const { body, requestedRefs } = load('google-freebusy-partial.json');
  const calendars = normalizeGoogleFreeBusy(body, requestedRefs);
  assert.deepEqual(calendars.map((c) => [c.ref, c.status, c.errorReason ?? null]), [
    ['cal-a', 'ok', null],
    ['cal-b', 'error', 'notFound'],
    ['cal-c', 'error', 'missing_from_response'],
  ]);
  const snap = buildSnapshot({
    request: { selectedDate: '2026-10-26', timeZone: 'America/New_York', dailyStart: '09:00', dailyEnd: '17:00', minDurationMinutes: 30 },
    source: { kind: 'synthetic', provider: 'google-shaped-fixture', connection: 'connected' },
    retrievedAt: '2026-10-26T08:00:00-04:00',
    calendars,
  });
  assert.equal(snap.status, 'partial');
  assert.equal(snap.requiresUserConfirmation, true);
  assert.deepEqual(triples(snap.freeWindows), [
    ['2026-10-26T09:00:00-04:00', '2026-10-26T10:00:00-04:00', 60],
    ['2026-10-26T11:30:00-04:00', '2026-10-26T14:00:00-04:00', 150],
    ['2026-10-26T15:00:00-04:00', '2026-10-26T17:00:00-04:00', 120],
  ]);
  // Raw calendar IDs (which can be email addresses) never appear in the snapshot.
  assert.ok(!JSON.stringify(snap).includes('@group.calendar.invalid'));
});

test('partial failure: when every calendar fails, status is error and no windows are offered', () => {
  const snap = buildSnapshot({
    request: { selectedDate: '2026-10-26', timeZone: 'America/New_York', dailyStart: '09:00', dailyEnd: '17:00' },
    source: { kind: 'synthetic', provider: 'fixture', connection: 'connected' },
    retrievedAt: '2026-10-26T08:00:00-04:00',
    calendars: [{ ref: 'cal-a', status: 'error', errorReason: 'backendError', busy: [] }],
  });
  assert.equal(snap.status, 'error');
  assert.deepEqual(snap.freeWindows, []);
});

test('disconnected: not_configured is distinct from an empty calendar', () => {
  const snap = buildSnapshot({
    request: { selectedDate: '2026-10-26', timeZone: 'America/New_York' },
    source: { kind: 'calendar', provider: 'google', connection: 'not_configured' },
    retrievedAt: '2026-10-26T08:00:00-04:00',
  });
  assert.equal(snap.status, 'disconnected');
  assert.ok(snap.issues.some((i) => i.code === 'source_disconnected'));
});

// --- one workflow for manual and calendar-derived availability --------------

test('manual and calendar-derived windows have the identical shape and values', () => {
  const m = load('manual-entries.json');
  const manual = fromManualWindows(m);
  const derived = buildSnapshot(load('snapshot-cases.json').cases[0].input);
  assert.equal(manual.source.kind, 'manual');
  assert.equal(manual.status, 'ok');
  assert.deepEqual(manual.freeWindows, derived.freeWindows);
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(derived).sort());
});

test('manual entry crossing midnight is supported; invalid entries are reported', () => {
  const snap = fromManualWindows({
    request: { selectedDate: '2026-10-23', horizonDays: 1, timeZone: 'America/New_York', dailyStart: '18:00', dailyEnd: '02:00' },
    enteredAt: '2026-10-23T08:00:00-04:00',
    entries: [{ date: '2026-10-23', start: '23:00', end: '01:00' }, { date: '2026-10-23', start: '25:00', end: '26:00' }],
  });
  assert.deepEqual(triples(snap.freeWindows), [['2026-10-23T23:00:00-04:00', '2026-10-24T01:00:00-04:00', 120]]);
  assert.equal(snap.issues.filter((i) => i.code === 'invalid_interval').length, 1);
});

// --- privacy / no inference -------------------------------------------------

test('output contains only time data, even if a provider leaks extra event fields', () => {
  const input = structuredClone(load('snapshot-cases.json').cases[0].input);
  input.calendars[0].busy[0].summary = 'SYNTHETIC-TITLE';
  input.calendars[0].busy[0].location = 'SYNTHETIC-ROOM';
  const snap = buildSnapshot(input);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('SYNTHETIC-TITLE') && !text.includes('SYNTHETIC-ROOM'));
  for (const w of [...snap.freeWindows, ...snap.busyIntervals]) {
    assert.deepEqual(Object.keys(w).sort(), ['durationMinutes', 'end', 'planningDate', 'start', 'timeZone']);
  }
  for (const banned of ['location', 'hunger', 'intent', 'attend', 'summary', 'title']) {
    assert.ok(!Object.keys(snap).some((k) => k.toLowerCase().includes(banned)), banned);
  }
});

test('issue messages for invalid intervals do not echo extra event fields', () => {
  const input = structuredClone(load('snapshot-cases.json').cases[0].input);
  input.calendars[0].busy.push({ start: 'not-a-time', end: 'nope', summary: 'SYNTHETIC-TITLE' });
  const snap = buildSnapshot(input);
  assert.equal(snap.status, 'partial');
  assert.ok(!JSON.stringify(snap.issues).includes('SYNTHETIC-TITLE'));
});

// --- staleness --------------------------------------------------------------

test('isStale: calendar snapshots expire; manual snapshots do not', () => {
  const derived = buildSnapshot(load('snapshot-cases.json').cases[1].input); // retrievedAt 12:00-04:00
  assert.equal(isStale(derived, '2026-10-25T12:10:00-04:00', 15), false);
  assert.equal(isStale(derived, '2026-10-25T12:16:00-04:00', 15), true);
  assert.equal(isStale(fromManualWindows(load('manual-entries.json')), '2027-01-01T00:00:00Z'), false);
});

// --- bridge to the main app's planner request (web/js/recommend.js) ----------

import { toPlannerWindows } from '../src/availability.mjs';

test('planner bridge: windows become { start "HH:MM", minutes, source } only', () => {
  const out = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[0].input));
  assert.equal(out.usable, true);
  assert.deepEqual(out.windows, [
    { date: '2026-10-26', start: '09:00', minutes: 30, source: 'synthetic' },
    { date: '2026-10-26', start: '11:30', minutes: 90, source: 'synthetic' },
    { date: '2026-10-26', start: '14:00', minutes: 165, source: 'synthetic' },
  ]);
  // No location/activity fields: those stay user-chosen in the planner.
  for (const w of out.windows) assert.ok(!('from' in w) && !('to' in w) && !('activity' in w));
});

test('planner bridge: manual and calendar-derived windows give identical planner fields', () => {
  const strip = (ws) => ws.map(({ source, ...rest }) => rest);
  const manual = toPlannerWindows(fromManualWindows(load('manual-entries.json')));
  const derived = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[0].input));
  assert.deepEqual(strip(manual.windows), strip(derived.windows));
  assert.ok(manual.windows.every((w) => w.source === 'manual'));
});

test('planner bridge: cuts at local midnight and caps at 720 minutes', () => {
  const out = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[3].input)); // crosses midnight
  assert.deepEqual(out.windows.find((w) => w.date === '2026-10-24' && w.start === '20:00'),
    { date: '2026-10-24', start: '20:00', minutes: 240, source: 'synthetic' });
  const empty = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[4].input)); // 23h DST day
  assert.ok(empty.windows.every((w) => w.minutes <= 720));
  assert.ok(empty.notes.some((n) => n.includes('capped')));
});

test('planner bridge: partial needs confirmation; disconnected/error are unusable', () => {
  const partial = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[6].input));
  assert.equal(partial.usable, true);
  assert.equal(partial.requiresUserConfirmation, true);
  for (const i of [7, 8]) {
    const out = toPlannerWindows(buildSnapshot(load('snapshot-cases.json').cases[i].input));
    assert.equal(out.usable, false);
    assert.deepEqual(out.windows, []);
  }
});
