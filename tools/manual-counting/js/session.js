// Manual counting pilot: session model. Pure logic, no DOM, so tests.html can drive it directly.
//
// A session is an append-only list of records. Nothing is ever edited or deleted:
//   start      known starting occupancy
//   in / out   one tap of Entry +1 / Exit +1
//   undo       cancels one in/out record (target_id); the original stays in the log
//   headcount  a manual count of people in the room, with the estimate at that moment
//   reconcile  an explicit correction: adjustment = headcount − estimate at the headcount
// estimate = start + Σin − Σout (excluding undone) + Σadjustment. It may go negative: that is
// flagged for correction, never clamped, so the inconsistency stays visible in the data.

export const LABEL = "Manual controlled pilot — not live BU facility data.";
export const SCHEMA = 1;
export const MAX_COUNT = 10000;
export const FACILITY_RE = /^PILOT_[A-Z0-9_]{1,58}$/;
export const SENSOR_RE = /^[A-Z0-9_]{1,64}$/;
const NAME_MAX = 80;
const NOTE_MAX = 140;

// ---------- ids and time ----------
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Local wall time with its UTC offset, e.g. 2026-10-28T14:05:12.345-04:00 (DST-safe per record). */
export function isoLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export const timeZoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

// ---------- validation ----------
/** Whole number 0..MAX_COUNT typed by a person. Rejects "", "-1", "2.5", "1e3", "12abc". */
export function parseCount(text) {
  const s = String(text ?? "").trim();
  if (s === "") return { ok: false, error: "Enter a number." };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Use a whole number of people (0 or more)." };
  const value = Number(s);
  if (value > MAX_COUNT) return { ok: false, error: `That's more than ${MAX_COUNT.toLocaleString()}. Check the number.` };
  return { ok: true, value };
}

export function validateSetup({ name, facilityId, sensorId, startOccupancy }) {
  const errors = {};
  const n = String(name ?? "").trim();
  const f = String(facilityId ?? "").trim().toUpperCase();
  const s = String(sensorId ?? "").trim().toUpperCase();
  if (!n) errors.name = "Name the session, e.g. “Room test 1”.";
  else if (n.length > NAME_MAX) errors.name = `Keep it under ${NAME_MAX} characters.`;
  if (!FACILITY_RE.test(f)) errors.facilityId = "Start with PILOT_, then capitals, digits or _ (e.g. PILOT_MUGAR_STUDY_3).";
  if (!SENSOR_RE.test(s)) errors.sensorId = "Capitals, digits or _ only (e.g. PILOT_MUGAR_STUDY_3_D1).";
  const start = parseCount(startOccupancy);
  if (!start.ok) errors.startOccupancy = start.error;
  return { ok: !Object.keys(errors).length, errors, value: { name: n, facilityId: f, sensorId: s, startOccupancy: start.value } };
}

// ---------- building a session ----------
const nextSeq = (session) => session.records.reduce((m, r) => Math.max(m, r.seq), 0) + 1;

function append(session, record, now) {
  const r = { seq: nextSeq(session), id: newId(), ts: isoLocal(now), ...record };
  session.records.push(r);
  return r;
}

export function createSession(input, now = new Date()) {
  const v = validateSetup(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { name, facilityId, sensorId, startOccupancy } = v.value;
  const session = {
    schema: SCHEMA, label: LABEL, session_id: newId(), name, facility_id: facilityId, sensor_id: sensorId,
    time_zone: timeZoneName(), created_at: isoLocal(now), records: [],
  };
  append(session, { type: "start", count: startOccupancy }, now);
  return { ok: true, session };
}

export function addEvent(session, direction, now = new Date()) {
  if (direction !== "in" && direction !== "out") throw new Error(`direction must be in or out, got ${direction}`);
  return append(session, { type: direction, count: 1 }, now);
}

// ---------- derived state ----------
const ordered = (session) => [...session.records].sort((a, b) => a.seq - b.seq);
const undoneIds = (session) => new Set(session.records.filter((r) => r.type === "undo").map((r) => r.target_id));
const reconciledIds = (session) => new Set(session.records.filter((r) => r.type === "reconcile").map((r) => r.headcount_id));

function delta(r, undone) {
  if (r.type === "start") return null; // sets, not adds
  if (r.type === "in") return undone.has(r.id) ? 0 : r.count;
  if (r.type === "out") return undone.has(r.id) ? 0 : -r.count;
  if (r.type === "reconcile") return r.adjustment;
  return 0;
}

/** Estimate from records with seq < beforeSeq (all records when omitted), using today's undo state. */
export function estimateAt(session, beforeSeq = Infinity) {
  const undone = undoneIds(session);
  let est = 0;
  for (const r of ordered(session)) {
    if (r.seq >= beforeSeq) break;
    const d = delta(r, undone);
    est = d === null ? r.count : est + d;
  }
  return est;
}

/** Every record with the estimate right after it and whether it was undone. Oldest first. */
export function timeline(session) {
  const undone = undoneIds(session), reconciled = reconciledIds(session);
  let est = 0;
  return ordered(session).map((r) => {
    const d = delta(r, undone);
    est = d === null ? r.count : est + d;
    return { record: r, estimate: est, undone: undone.has(r.id), reconciled: reconciled.has(r.id), negative: est < 0 };
  });
}

/** The newest in/out still active, or why Undo is unavailable. */
export function undoCandidate(session) {
  const undone = undoneIds(session);
  const recs = ordered(session);
  const last = recs.filter((r) => (r.type === "in" || r.type === "out") && !undone.has(r.id)).at(-1);
  if (!last) return { record: null, reason: "Nothing to undo." };
  if (recs.some((r) => r.type === "reconcile" && r.seq > last.seq)) {
    return { record: null, reason: "The last event is already covered by a reconciliation. Take a new headcount instead." };
  }
  return { record: last, reason: "" };
}

export function undoLast(session, now = new Date()) {
  const { record, reason } = undoCandidate(session);
  if (!record) return { ok: false, error: reason };
  return { ok: true, record: append(session, { type: "undo", target_id: record.id }, now), target: record };
}

export function addHeadcount(session, observedText, note = "", now = new Date()) {
  const c = parseCount(observedText);
  if (!c.ok) return { ok: false, error: c.error };
  const n = String(note ?? "").trim();
  if (n.length > NOTE_MAX) return { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` };
  const estimate = estimateAt(session);
  return { ok: true, record: append(session, { type: "headcount", observed: c.value, estimate_at_capture: estimate, note: n }, now) };
}

/** The newest headcount and how far the estimate was from it, recomputed with current undo state. */
export function latestHeadcount(session) {
  const hc = ordered(session).filter((r) => r.type === "headcount").at(-1);
  if (!hc) return null;
  const estimate = estimateAt(session, hc.seq);
  return { record: hc, estimate, difference: estimate - hc.observed, reconciled: reconciledIds(session).has(hc.id) };
}

/** Explicit correction to the newest headcount. Later events keep counting on top of it. */
export function reconcile(session, headcountId, now = new Date()) {
  const latest = latestHeadcount(session);
  if (!latest || latest.record.id !== headcountId) return { ok: false, error: "Only the newest headcount can be reconciled." };
  if (latest.reconciled) return { ok: false, error: "This headcount is already reconciled." };
  const adjustment = latest.record.observed - latest.estimate;
  const record = append(session, {
    type: "reconcile", headcount_id: headcountId, from: latest.estimate, to: latest.record.observed, adjustment,
  }, now);
  return { ok: true, record };
}

export function summarize(session) {
  const undone = undoneIds(session);
  const active = (t) => session.records.filter((r) => r.type === t && !undone.has(r.id)).reduce((s, r) => s + r.count, 0);
  const estimate = estimateAt(session);
  return {
    start: session.records.find((r) => r.type === "start")?.count ?? 0,
    entries: active("in"), exits: active("out"), undone: undone.size,
    corrections: session.records.filter((r) => r.type === "reconcile").reduce((s, r) => s + r.adjustment, 0),
    estimate, negative: estimate < 0, headcount: latestHeadcount(session), undo: undoCandidate(session),
  };
}

// ---------- persistence ----------
/** Check a parsed object is a usable session. Duplicate record ids keep the first copy. */
export function restore(obj) {
  if (!obj || obj.schema !== SCHEMA || !Array.isArray(obj.records) || !obj.session_id || !FACILITY_RE.test(obj.facility_id ?? "")) {
    return { ok: false, error: "Saved data is not a pilot session this version understands." };
  }
  const seen = new Set(), records = [];
  for (const r of obj.records) {
    if (!r || typeof r.id !== "string" || !Number.isInteger(r.seq) || typeof r.ts !== "string") {
      return { ok: false, error: "Saved data has a malformed record." };
    }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    records.push(r);
  }
  if (!records.some((r) => r.type === "start")) return { ok: false, error: "Saved session has no starting count." };
  return { ok: true, session: { ...obj, records } };
}

/**
 * Union of two copies of the same session (e.g. two tabs), deduplicated by record id.
 * Order is by timestamp, then seq; seq is renumbered so it stays unique.
 */
export function merge(a, b) {
  if (!b || a.session_id !== b.session_id) return a;
  const byId = new Map();
  for (const r of [...a.records, ...b.records]) if (!byId.has(r.id)) byId.set(r.id, r);
  const t = (r) => Date.parse(r.ts);
  const records = [...byId.values()]
    .sort((x, y) => t(x) - t(y) || x.seq - y.seq || x.id.localeCompare(y.id))
    .map((r, i) => ({ ...r, seq: i + 1 }));
  return { ...a, records };
}

// ---------- CSV ----------
const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Free text a person typed: stop spreadsheets from treating it as a formula.
const text = (v) => cell(/^[=+\-@\t\r]/.test(v ?? "") ? `'${v}` : v);
const csv = (header, rows) => [header.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";

/** team/member-1-data-pilot/event_template.csv columns. Undone taps are left out. */
export function eventsCsv(session) {
  const rows = timeline(session)
    .filter((t) => (t.record.type === "in" || t.record.type === "out") && !t.undone)
    .map(({ record: r }) => [r.id, session.facility_id, session.sensor_id, r.ts, r.type, r.count].map(cell));
  return csv(["event_id", "facility_id", "sensor_id", "timestamp", "direction", "count"], rows);
}

/** team/member-1-data-pilot/headcount_template.csv columns. */
export function headcountsCsv(session) {
  const rows = timeline(session).filter((t) => t.record.type === "headcount")
    .map(({ record: r }) => [cell(session.facility_id), cell(r.ts), cell(r.observed), text(r.note)]);
  return csv(["facility_id", "timestamp", "observed_count", "observer_note"], rows);
}

/** Same columns as data/*.csv: the estimate after every change that moved it. May contain negatives. */
export function occupancyCsv(session) {
  const rows = timeline(session)
    .filter((t) => ["start", "in", "out", "reconcile"].includes(t.record.type) && !t.undone)
    .map((t) => [session.facility_id, t.record.ts, t.estimate].map(cell));
  return csv(["facility_id", "timestamp", "occupancy_count"], rows);
}

/** Everything, including undone taps, undo records and corrections. */
export function auditCsv(session) {
  const header = [
    "seq", "record_id", "type", "timestamp", "session_id", "session_name", "facility_id", "sensor_id",
    "count", "status", "target_id", "observed_count", "estimate_at_capture", "headcount_id", "adjustment",
    "estimate_after", "flag", "note", "data_origin",
  ];
  const rows = timeline(session).map(({ record: r, estimate, undone, reconciled, negative }) => [
    cell(r.seq), cell(r.id), cell(r.type), cell(r.ts), cell(session.session_id), text(session.name),
    cell(session.facility_id), cell(session.sensor_id), cell(r.count),
    cell(r.type === "in" || r.type === "out" ? (undone ? "undone" : "active") : r.type === "headcount" ? (reconciled ? "reconciled" : "open") : ""),
    cell(r.target_id), cell(r.observed), cell(r.estimate_at_capture), cell(r.headcount_id), cell(r.adjustment),
    cell(estimate), cell(negative ? "negative_estimate" : ""), text(r.note), cell("manual_controlled_pilot"),
  ]);
  return csv(header, rows);
}

export function exportName(session, kind, now = new Date()) {
  const stamp = isoLocal(now).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `manual-pilot_${session.facility_id}_${stamp}_${kind}.csv`;
}
