import * as S from "./session.js";
import { KEY, browserStorage, makeStore } from "./store.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hms = (iso) => iso.slice(11, 19);
const signed = (n) => (n > 0 ? `+${n}` : String(n));

const { storage, persistent } = browserStorage();
const store = makeStore(storage);
let session = null;
let toastTimer = null;

// ---------- persistence ----------
function commit() {
  session = store.save(session);
  render();
}

function boot() {
  if (!persistent) {
    $("storage-warn").hidden = false;
    $("storage-warn").textContent = "This browser is blocking storage, so a refresh will lose the session. Export CSV often.";
  }
  const r = store.load();
  if (r.error) {
    $("storage-warn").hidden = false;
    $("storage-warn").textContent = `${r.error} A copy was kept in this browser; nothing was overwritten. Start a new session or ask for help recovering it.`;
  }
  session = r.session;
  if (session) note("Session restored from this browser.");
  render();
}

// Another tab on this device changed the session: adopt its copy so the two don't diverge.
addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  const r = store.load();
  if (session && r.session?.session_id !== session.session_id) note("Another tab reset or replaced this session.");
  else note("Updated from another tab.");
  session = r.session;
  render();
});

function note(text) {
  $("sync-note").hidden = false;
  $("sync-note").textContent = text;
}

function toast(text) {
  $("toast").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").textContent = ""), 2500);
}

// ---------- setup ----------
const form = $("setup-form");
form.facilityId.addEventListener("input", () => {
  form.facilityId.value = form.facilityId.value.toUpperCase();
  if (!form.sensorId.dataset.touched) form.sensorId.value = form.facilityId.value ? `${form.facilityId.value}_D1` : "";
});
form.sensorId.addEventListener("input", () => {
  form.sensorId.value = form.sensorId.value.toUpperCase();
  form.sensorId.dataset.touched = "1";
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = Object.fromEntries(new FormData(form));
  const r = S.createSession(input);
  for (const el of form.querySelectorAll(".err")) el.textContent = r.ok ? "" : r.errors[el.dataset.for] ?? "";
  if (!r.ok) return;
  session = r.session;
  form.reset();
  delete form.sensorId.dataset.touched;
  commit();
});

// ---------- counting ----------
function tap(direction) {
  S.addEvent(session, direction);
  navigator.vibrate?.(15);
  commit();
}
$("btn-in").addEventListener("click", () => tap("in"));
$("btn-out").addEventListener("click", () => tap("out"));

$("btn-undo").addEventListener("click", () => {
  const r = S.undoLast(session);
  if (!r.ok) return toast(r.error);
  toast(`Undid ${r.target.type === "in" ? "Entry" : "Exit"} at ${hms(r.target.ts)}. It stays in the log.`);
  commit();
});

const hc = $("hc-form");
hc.addEventListener("submit", (e) => {
  e.preventDefault();
  const r = S.addHeadcount(session, hc.observed.value, hc.note.value);
  $("hc-err").textContent = r.ok ? "" : r.error;
  if (!r.ok) return;
  hc.reset();
  commit();
});

$("btn-reconcile").addEventListener("click", () => {
  const latest = S.latestHeadcount(session);
  const r = S.reconcile(session, latest?.record.id);
  if (!r.ok) return toast(r.error);
  toast(`Corrected ${r.record.from} → ${r.record.to} (${signed(r.record.adjustment)}).`);
  commit();
});

// ---------- export ----------
const EXPORTS = { events: S.eventsCsv, headcounts: S.headcountsCsv, occupancy: S.occupancyCsv, audit: S.auditCsv };

function download(s, kind) {
  const url = URL.createObjectURL(new Blob([EXPORTS[kind](s)], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: S.exportName(s, kind) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const b of document.querySelectorAll("[data-export]")) b.addEventListener("click", () => download(session, b.dataset.export));
$("previous-export").addEventListener("click", () => {
  const prev = store.previous();
  if (prev) download(prev, "audit");
});

// ---------- reset ----------
$("btn-reset").addEventListener("click", () => {
  const n = session.records.length;
  $("reset-text").textContent = `“${session.name}” (${session.facility_id}) has ${n} record${n === 1 ? "" : "s"}. They will be cleared from this screen.`;
  $("reset-dialog").showModal();
});
// Only this button resets. Cancel, Esc and closing the dialog any other way keep the session.
$("reset-confirm").addEventListener("click", () => {
  $("reset-dialog").close();
  if (!session) return;
  store.archive(session);
  session = null;
  render();
});

// ---------- render ----------
const LOG_LABEL = { start: "Start", in: "Entry", out: "Exit", undo: "Undo", headcount: "Headcount", reconcile: "Correction" };

function logItem({ record: r, estimate, undone, reconciled, negative }) {
  let what = `${LOG_LABEL[r.type]}`;
  if (r.type === "start") what += ` ${r.count}`;
  if (r.type === "in" || r.type === "out") what += ` +${r.count}`;
  if (r.type === "undo") what += ` of ${esc(r.target_id.slice(0, 8))}`;
  if (r.type === "headcount") what += ` ${r.observed} (estimate was ${r.estimate_at_capture})${reconciled ? " · reconciled" : ""}`;
  if (r.type === "reconcile") what += ` ${r.from} → ${r.to} (${signed(r.adjustment)})`;
  const tags = [undone && `<em class="tag">undone</em>`, negative && `<em class="tag bad">negative</em>`].filter(Boolean).join(" ");
  const note = r.note ? ` <span class="muted">“${esc(r.note)}”</span>` : "";
  return `<li class="t-${r.type}${undone ? " undone" : ""}"><time>${hms(r.ts)}</time>` +
    `<span class="what">${what}${note} ${tags}</span><span class="est" title="Estimate after">${estimate}</span></li>`;
}

function render() {
  $("setup").hidden = !!session;
  $("count").hidden = !session;
  if (!session) {
    const prev = store.previous();
    $("previous").hidden = !prev;
    if (prev) $("previous-text").textContent = `“${prev.name}” (${prev.facility_id}), ${prev.records.length} records, started ${prev.created_at}.`;
    return;
  }
  const s = S.summarize(session);
  $("session-name").textContent = session.name;
  $("session-ids").textContent = `${session.facility_id} · ${session.sensor_id} · ${session.time_zone}`;
  $("estimate").textContent = s.estimate;
  $("estimate").classList.toggle("bad", s.negative);
  $("breakdown").textContent = `start ${s.start} + in ${s.entries} − out ${s.exits}` +
    (s.corrections ? ` ${s.corrections > 0 ? "+" : "−"} correction ${Math.abs(s.corrections)}` : "") +
    (s.undone ? ` · ${s.undone} undone` : "");
  $("negative").hidden = !s.negative;
  $("negative").textContent = `Inconsistent: the estimate is ${s.estimate}, below zero. More exits were tapped than the start count ` +
    "plus entries allow. All events are kept. Take a headcount and reconcile, or undo a mistaken Exit.";

  $("btn-undo").disabled = !s.undo.record;
  $("undo-hint").textContent = s.undo.record
    ? `Last: ${s.undo.record.type === "in" ? "Entry" : "Exit"} at ${hms(s.undo.record.ts)}`
    : s.undo.reason;

  const h = s.headcount;
  $("hc-result").hidden = !h;
  if (h) {
    const d = h.difference;
    $("hc-text").textContent = `Headcount ${h.record.observed} at ${hms(h.record.ts)} · estimate then ${h.estimate} · difference ${signed(d)}` +
      (d === 0 ? " (match)" : d > 0 ? " (estimate too high)" : " (estimate too low)");
    $("btn-reconcile").disabled = h.reconciled;
    $("hc-status").textContent = h.reconciled ? "Reconciled. Record a new headcount to check again." : "";
  }

  const rows = S.timeline(session);
  $("log-count").textContent = `${rows.length} records`;
  $("log").innerHTML = rows.slice().reverse().map(logItem).join("");
}

function tick() {
  const now = S.isoLocal();
  $("clock").textContent = `${now.slice(11, 19)} ${now.slice(23)}`;
}
tick();
setInterval(tick, 1000);
boot();
