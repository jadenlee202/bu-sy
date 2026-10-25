// BU-sy minimal prototype: plan a gap in one sentence. Every decision comes from the
// shared modules the main app uses: the engine (recommend.js), verified hours (hours.js),
// the .ics import and free time (schedule.js, availability.js) and saved club meetings.
import { daySegments, zonedInstant } from "../js/availability.js";
import { fmtTime, toHHMM, toMin } from "../js/clock.js";
import { clubBusy, clubEventItems, loadClubEvents } from "../js/clubevents.js";
import { campusDateTime, nowStatus, nowText } from "../js/hours.js";
import { directionsURL } from "../js/plan.js";
import * as prefs from "../js/prefs.js";
import * as engine from "../js/recommend.js";
import { busyOf, clearSchedule, eventsOf, importCalendarFile, loadSchedule } from "../js/schedule.js";
import * as src from "../js/source.js";
import { esc } from "../js/ui.js";
import * as L from "./logic.js";

const TZ = "America/New_York";
const DAY = ["08:00", "22:00"];          // the preferred window the main Calendar uses by default
const KEY = "busy.proto.v1";
const $view = document.getElementById("view");
const $announce = document.getElementById("announce");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- remembered settings (this browser only) ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } })();
const settings = { onboarded: false, tipSeen: false, access: { library: "", fitness: "", dining: "" }, ...saved };
delete settings.from; delete settings.to;            // the sentence no longer has a start or a next stop

// Where you are: asked for when you tap "Find a spot", kept in memory for this visit only, never stored or sent.
// `near` is the fallback when location is off: a building you say you're next to.
const loc = { here: null, status: "idle", near: "" };
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ } };

// The sentence for this visit. minutes/start come from the schedule until someone picks a time.
const sentence = { activity: "study", minutes: 60, start: null, fromSchedule: false, picked: false, patch: {}, chosen: null };
const ui = { exploreTab: 0, showEvents: false, scheduleMsg: "" };

let data = null;
async function loadData() {
  if (data) return data;
  const [campus, hours] = await Promise.all([src.getCampus(), src.getHours().catch(() => null)]);
  const ids = [...new Set(campus.places.map((p) => p.facility_id))];
  const histories = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await src.getHistory(id)])));
  const geo = await fetch("proto/places-geo.json").then((r) => (r.ok ? r.json() : { locations: {} })).catch(() => ({ locations: {} }));
  data = { campus, hours, histories, geo: geo.locations, planDate: engine.demoDate(campus, histories) };
  return data;
}

/** The campus the engine plans on: from your location when we have it, else as published. */
const tripCampus = () => (loc.here ? L.campusFrom(data.campus, loc.here, data.geo) : data.campus);
const plan = () => engine.recommend(request(), tripCampus(), data.histories, { hours: data.hours });

/** Ask the browser for your position once; resolves either way. */
function locate() {
  if (!navigator.geolocation) { loc.status = "unavailable"; return Promise.resolve(false); }
  loc.status = "asking";
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => { loc.here = { lat: p.coords.latitude, lon: p.coords.longitude }; loc.status = "ok"; resolve(true); },
    (e) => { loc.status = e.code === 1 ? "denied" : "unavailable"; resolve(false); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }));
}

// ---------- small formatters ----------
const instantFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const at = (ms) => instantFmt.format(new Date(ms));
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" });
const locName = (id) => data.campus.locations.find((l) => l.id === id)?.name ?? "";
const actInfo = (id) => engine.activityInfo(data.campus, id);
const icon = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  chev: `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
  go: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>`,
};

// ---------- today's schedule (shared with the main app's Calendar) ----------
function today() {
  const now = Date.now();
  const date = campusDateTime().date;
  const start = zonedInstant(date, DAY[0], TZ), end = zonedInstant(date, DAY[1], TZ);
  const schedule = loadSchedule();
  const clubs = loadClubEvents();
  const busy = [...(schedule ? busyOf(schedule) : []), ...clubBusy(clubs)];
  const segments = daySegments(busy, start, end, 15, now);
  const events = [...(schedule ? eventsOf(schedule) ?? [] : []), ...clubEventItems(clubs)]
    .filter((e) => e.end > start && e.start < end).sort((a, b) => a.start - b.start);
  return { now, date, start, end, schedule, clubs, segments, events, hasAny: Boolean(schedule || clubs.length) };
}

/** Before someone picks a time, a schedule says how long they're free right now. */
function syncFromSchedule() {
  if (sentence.picked || sentence.start) return;
  const t = today();
  const free = t.hasAny ? L.freeNow(t.segments, t.now) : null;
  if (free) {
    sentence.minutes = Math.max(5, L.minutesBetween(t.now, free.end));
    sentence.fromSchedule = { until: free.end };
  } else {
    sentence.fromSchedule = false;
  }
}

function request() {
  const d = prefs.defaults(data.campus, prefs.loadPrefs(data.campus), sentence.activity);
  const start = sentence.start ?? toHHMM(L.roundUp5(campusDateTime().minute));
  return L.buildRequest({ ...sentence, from: loc.here ? L.HERE : loc.near, access: settings.access }, d, start, data.planDate);
}

// ---------- router + transitions ----------
const DEPTH = { welcome: 0, access: 1, plan: 2, answer: 3, options: 4 };
const TABS = { plan: "plan", answer: "plan", options: "plan", schedule: "schedule", explore: "explore" };
let current = null;
const routeOf = () => (location.hash.replace(/^#\/?/, "").split("/")[0] || "plan");

// ---------- logo: the pin clock (where to go, and when) ----------
const pinClock = ({ size = 24, label = "" } = {}) => `<svg class="pin-clock" width="${size}" height="${size}" viewBox="0 0 64 64" ${label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`}>
  <path class="pin-body" d="M32 61S11 41 11 26a21 21 0 0 1 42 0c0 15-21 35-21 35z"/>
  <circle class="pin-face" cx="32" cy="26" r="12"/>
  <path class="hand hand-h" d="M32 26l5 3"/><path class="hand hand-m" d="M32 26v-7"/></svg>`;
const brand = `<span class="brand">${pinClock({ size: 24 })}<span>BU-<em>sy</em></span></span>`;

// ---------- loader: the pin drops in, lands with a burst, then hovers while we wait ----------
const SPARKS = 14;
const MIN_SHOWN = 900;               // let the landing burst finish before the loader can leave
let loaderTimer = 0, shownAt = 0;
function showLoader(text) {
  document.getElementById("loader")?.remove();           // a fresh node replays the whole entrance
  const sparks = Array.from({ length: SPARKS }, (_, i) =>
    `<i class="spark s${i % 3}" style="--a:${Math.round((i * 360) / SPARKS)}deg;--d:${78 + (i % 3) * 20}px"></i>`).join("");
  const letters = [...text].map((ch, i) => (ch === " " ? " " : `<span class="ch" style="--i:${i}">${esc(ch)}</span>`)).join("");
  document.body.insertAdjacentHTML("beforeend", `<div id="loader" class="loader" role="status" aria-live="polite">
    <div class="stage" aria-hidden="true">
      <span class="flash"></span><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
      <span class="sparks">${sparks}</span><span class="shadow"></span>
      <span class="pin-wrap">${pinClock({ size: 92 })}</span>
    </div>
    <p class="loader-text"><span class="sr-only">${esc(text)}</span><span class="letters" aria-hidden="true">${letters}</span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
    <div class="loader-line" aria-hidden="true"><i></i></div></div>`);
  const $l = document.getElementById("loader");
  shownAt = performance.now();
  document.body.setAttribute("aria-busy", "true");
  requestAnimationFrame(() => $l.classList.add("on"));
}
function hideLoader() {
  clearTimeout(loaderTimer);
  const $l = document.getElementById("loader");
  if (!$l) { document.body.removeAttribute("aria-busy"); return; }
  const wait = reduced() ? 0 : Math.max(0, MIN_SHOWN - (performance.now() - shownAt));
  setTimeout(() => {
    document.body.removeAttribute("aria-busy");
    $l.classList.add("out");
    setTimeout(() => $l.remove(), reduced() ? 0 : 340);
  }, wait);
}
// Returning to the page (back button, or the Maps app opened instead of a tab) clears the loader.
window.addEventListener("pageshow", (e) => { if (e.persisted) hideLoader(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && current) hideLoader(); });

/** Show the loader, let it settle for a beat, then hand over to Google Maps in this tab. */
function openDirections(url) {
  showLoader("Opening Google Maps");
  setTimeout(() => location.assign(url), reduced() ? 80 : 1150);   // after the landing burst
  loaderTimer = setTimeout(hideLoader, 6000);      // the Maps app may open instead and leave this page up
}

async function route() {
  let name = routeOf();
  if (!settings.onboarded && !["welcome", "access"].includes(name)) { location.replace("#/welcome"); return; }
  if (!(name in DEPTH) && !(name in TABS)) name = "plan";
  const dir = current == null ? "none"
    : TABS[current] !== TABS[name] && name in TABS && current in TABS ? "tab"
    : (DEPTH[name] ?? 2) < (DEPTH[current] ?? 2) ? "back" : "fwd";
  document.documentElement.dataset.dir = dir;
  const previous = current;
  current = name;
  // Only show the loader if loading is slow enough to notice, so a fast load doesn't flicker.
  const slow = data ? 0 : setTimeout(() => showLoader("Loading campus data"), 150);
  try { await loadData(); } catch (err) {
    clearTimeout(slow);
    hideLoader();
    $view.innerHTML = `<div class="stack"><h1>Couldn't load campus data</h1><p class="fine">${esc(err.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  const draw = () => {
    SCREENS[name]();
    document.body.classList.toggle("no-tabs", name === "welcome" || name === "access");
    for (const a of document.querySelectorAll(".tabs a")) a.toggleAttribute("aria-current", a.dataset.tab === TABS[name]);
    for (const a of document.querySelectorAll(".tabs a[aria-current]")) a.setAttribute("aria-current", "page");
    window.scrollTo(0, 0);
  };
  if (previous && document.startViewTransition && !reduced()) {
    await document.startViewTransition(draw).updateCallbackDone;
  } else {
    draw();
    if (previous) { $view.classList.remove("enter"); void $view.offsetWidth; $view.classList.add("enter"); }
  }
  if (slow) { clearTimeout(slow); hideLoader(); }
  if (previous) $view.focus({ preventScroll: true });
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
window.addEventListener("hashchange", route);

// ---------- sheet: the picker behind every red word ----------
function openSheet(title, options, onPick) {
  const root = document.getElementById("sheet-root");
  const opener = document.activeElement;
  root.innerHTML = `<div class="scrim"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(title)}</h2>
      ${options.map((o, i) => `<button class="opt" data-i="${i}" aria-pressed="${!!o.pressed}">
        <span>${esc(o.label)}</span>${o.note ? `<span class="note">${esc(o.note)}</span>` : ""}</button>`).join("")}
    </div>`;
  const $scrim = root.querySelector(".scrim"), $sheet = root.querySelector(".sheet");
  requestAnimationFrame(() => { $scrim.classList.add("open"); $sheet.classList.add("open"); });
  ($sheet.querySelector('[aria-pressed="true"]') ?? $sheet.querySelector(".opt")).focus({ preventScroll: true });
  const close = (after) => {
    $scrim.classList.remove("open"); $sheet.classList.remove("open");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => { root.innerHTML = ""; after?.(); if (!after) opener?.focus?.(); }, reduced() ? 0 : 260);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {                                  // keep focus inside the sheet
      const items = [...$sheet.querySelectorAll(".opt")];
      const i = items.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items.at(-1).focus(); }
      else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
    }
  };
  document.addEventListener("keydown", onKey);
  $scrim.addEventListener("click", () => close());
  $sheet.addEventListener("click", (e) => {
    const b = e.target.closest(".opt");
    if (b) close(() => onPick(options[Number(b.dataset.i)].value));
  });
}

function pop(selector) {
  const el = $view.querySelector(selector);
  if (!el) return;
  el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  el.focus({ preventScroll: true });
}

// ---------- screens ----------
const SCREENS = {
  welcome() {
    $view.innerHTML = `<section class="welcome stagger">
      <div class="logo">${pinClock({ size: 34, label: "BU-sy" })}</div>
      <h1>Got a gap between classes?</h1>
      <p class="lede">Tell BU-sy how long you have. It finds a spot on campus that fits, and gets you to your next class on time.</p>
      <div class="btn-col">
        <a class="btn primary" href="#/access">Get started</a>
        <button class="btn quiet" type="button" data-skip>Skip for now</button>
      </div>
      <p class="fine" style="text-align:center">No account. What you enter stays on this device.</p>
    </section>`;
    $view.querySelector("[data-skip]").addEventListener("click", () => { settings.onboarded = true; persist(); go("#/"); });
  },

  access() {
    const rows = [
      ["library", "Mugar Library", "I can enter the library with my BU ID"],
      ["fitness", "FitRec", "Membership, waiver and Terrier Card"],
      ["dining", "Dining halls", "A meal plan or accepted payment"],
    ];
    $view.innerHTML = `<div class="head"><a class="back" href="#/welcome">${icon.back}Back</a></div>
      <section class="stack stagger">
        <div><h1 style="margin:0;font-size:30px;line-height:1.15;letter-spacing:-0.02em">Which can you use?</h1>
          <p class="fine" style="font-size:15px;margin-top:8px">BU-sy only suggests places you can get into. You can change this any time.</p></div>
        <div>${rows.map(([k, title, sub]) => `<label class="toggle"><span class="main"><span style="font-weight:600">${title}</span><span class="sub">${sub}</span></span>
          <input class="switch" type="checkbox" role="switch" name="${k}" ${settings.access[k] === "yes" ? "checked" : ""}></label>`).join("")}</div>
        <button class="btn primary" type="button" data-done>Continue</button>
      </section>`;
    $view.querySelector("[data-done]").addEventListener("click", () => {
      for (const [k] of rows) settings.access[k] = $view.querySelector(`[name="${k}"]`).checked ? "yes" : "no";
      settings.onboarded = true; persist(); go("#/");
    });
  },

  plan() {
    syncFromSchedule();
    const act = actInfo(sentence.activity);
    const chip = sentence.start
      ? `<span class="chip free">${icon.cal}Planning ${fmtTime(toMin(sentence.start))}–${fmtTime(toMin(sentence.start) + sentence.minutes)} · from your schedule</span>`
      : sentence.fromSchedule && !sentence.picked
        ? `<span class="chip free">${icon.cal}Free until ${at(sentence.fromSchedule.until)} · from your schedule</span>` : "";
    const access = Object.entries(settings.access).filter(([, v]) => v === "yes").map(([k]) => ({ library: "library", fitness: "FitRec", dining: "dining" })[k]);
    $view.innerHTML = `<header class="topbar">${brand}</header>
    <section class="plan stagger">
      ${chip}
      <p class="sentence">I have <button class="word" data-pick="time" aria-label="Free time: ${esc(L.durationText(sentence.minutes))}. Change">${esc(L.durationText(sentence.minutes))}</button>
        to <button class="word" data-pick="activity" aria-label="Activity: ${esc(act.verb)}. Change">${esc(act.verb)}</button>.</p>
      <p class="hint">Tap a red word to change it.</p>
      <a class="btn primary" href="#/answer" data-find>Find a spot</a>
      <p class="fine">${loc.here ? "Walking times are estimated from your location." : "BU-sy asks where you are to time the walk. Your location stays on this device."}
        Busyness is simulated from a sample Monday, not live. Access: ${access.length ? esc(access.join(", ")) : "not set"} · <a href="#/access">Change</a> · <a href="index.html">Full app</a></p>
    </section>
    ${settings.tipSeen ? "" : `<div class="coach" role="dialog" aria-label="Tip"><p>Tap a <b>red word</b> to change it. That's all BU-sy needs.</p><button class="btn" type="button" data-tip>Got it</button></div>`}`;

    $view.querySelector("[data-tip]")?.addEventListener("click", (e) => {
      settings.tipSeen = true; persist(); e.target.closest(".coach").remove(); $view.querySelector('[data-pick="time"]').focus();
    });
    $view.querySelector(".plan").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b) PICKERS[b.dataset.pick]();
    });
    // The first "Find a spot" asks for your location (the loader covers the wait), then plans from it.
    $view.querySelector("[data-find]").addEventListener("click", async (e) => {
      if (loc.here || loc.near || loc.status === "denied" || loc.status === "unavailable") return;
      e.preventDefault();
      showLoader("Finding where you are");
      await locate();
      hideLoader();
      go("#/answer");
    });
  },

  answer() {
    const result = plan();
    const back = `<div class="head"><a class="back" href="#/">${icon.back}Change</a></div>`;
    if (!result.ok) {
      $view.innerHTML = `${back}<section class="stack stagger"><h1 style="margin:0;font-size:28px">Let's adjust that</h1>
        <ul class="list">${result.errors.map((e) => `<li class="row"><span class="main"><span class="title">${esc(e.message)}</span></span></li>`).join("")}</ul>
        <a class="btn primary" href="#/">Change my plan</a></section>`;
      return;
    }
    const fits = [...result.options, ...result.more];
    const o = fits.find((f) => f.place.place_id === sentence.chosen) ?? fits[0];
    if (o) { renderAnswer(o, result, fits.length, back); return; }
    renderNoFit(result, back);
  },

  options() {
    const result = plan();
    const fits = result.ok ? [...result.options, ...result.more] : [];
    const act = actInfo(sentence.activity);
    $view.innerHTML = `<div class="head"><a class="back" href="#/answer">${icon.back}Back</a></div>
      <section class="stack">
        <div><h1 style="margin:0 0 6px;font-size:26px">${fits.length} place${fits.length === 1 ? "" : "s"} fit</h1>
          <ul class="legend"><li><i class="k-there"></i>Walk</li><li><i class="k-activity"></i>${esc(act.label)}</li></ul></div>
        <div class="stack stagger" style="gap:14px">${fits.map((f, i) => optionCard(f, i === 0)).join("") || `<p class="empty">Nothing fits this window.</p>`}</div>
      </section>`;
    $view.querySelector("section").addEventListener("click", (e) => {
      const b = e.target.closest("[data-choose]");
      if (b) { sentence.chosen = b.dataset.choose; go("#/answer"); }
    });
  },

  schedule() {
    const t = today();
    const input = `<input type="file" id="ics" accept=".ics,text/calendar" hidden>`;
    if (!t.hasAny) {
      $view.innerHTML = `<div class="head"><h1>Schedule</h1></div>
        <section class="stack stagger">
          <div class="card">
            <h2 style="margin:0;font-size:22px;line-height:1.2">See every gap between your classes</h2>
            <ol class="steps-num"><li>Export your calendar as an .ics file from Google Calendar, Apple Calendar or Outlook.</li><li>Choose the file below.</li><li>Tap Plan on any free window.</li></ol>
            <div class="drop">${input}<label class="btn primary" for="ics">Choose .ics file</label><span class="fine">Up to 2 MB</span></div>
            <p class="fine">Read on this device and never uploaded. Kept until you close the tab.</p>
            ${ui.scheduleMsg ? `<p class="chip warn" role="alert">${esc(ui.scheduleMsg)}</p>` : ""}
          </div>
          <p class="fine">Until then you're treated as free 8 AM – 10 PM.</p>
        </section>`;
      wireImport();
      return;
    }
    const free = L.freeNow(t.segments, t.now);
    const later = L.laterFree(t.segments, t.now);
    const busyNow = t.events.find((e) => !e.free && e.start <= t.now && t.now < e.end);
    const next = L.nextEvent(t.events, free ? free.start : t.now);
    const nowCard = free
      ? `<div class="card now-card"><span class="when">${at(t.now)} – ${at(free.end)}</span>
          <span class="then">${esc(L.durationText(L.minutesBetween(t.now, free.end)))}${next ? `, then ${esc(next.title)}` : ""}</span>
          <button class="btn primary" type="button" data-plan-now>Plan this time</button></div>`
      : busyNow ? `<div class="card now-card"><span class="when">Busy until ${at(busyNow.end)}</span><span class="then">${esc(busyNow.title)}</span></div>`
      : `<div class="card now-card"><span class="then">No more free windows today between 8 AM and 10 PM.</span></div>`;
    $view.innerHTML = `<div class="head"><h1>Today</h1><span class="fine" style="margin-right:12px">${esc(dateFmt.format(new Date(t.now)))}</span></div>
      <section class="stack stagger">
        <div><p class="label">${free ? "Free now" : "Right now"}</p>${nowCard}</div>
        <div><p class="label">Later today</p>
          <ul class="list">${later.map((s) => `<li><button class="row" type="button" data-plan-at="${s.start}" data-plan-end="${s.end}">
            <span class="main"><span class="title">${at(s.start)} – ${at(s.end)}</span><span class="sub">${esc(L.durationText(L.minutesBetween(s.start, s.end)))}</span></span><span class="go">Plan</span></button></li>`).join("")
            || `<li class="empty">No more free windows today.</li>`}</ul></div>
        <div>
          <button class="btn quiet" type="button" data-toggle aria-expanded="${ui.showEvents}" aria-controls="events" style="padding:0;justify-content:flex-start">${icon.chev}${ui.showEvents ? "Hide" : "Show"} classes and clubs (${t.events.length})</button>
          <div class="collapse ${ui.showEvents ? "open" : ""}" id="events"${ui.showEvents ? "" : " inert"}><div><ul class="list events">${t.events.map((e) => `<li class="row"><span class="main"><span class="title">${esc(e.title)}</span>
            <span class="sub">${e.allDay ? "All day" : `${at(e.start)} – ${at(e.end)}`}${e.location ? ` · ${esc(e.location)}` : ""}</span></span>${e.source === "club" ? `<span class="tag">Club</span>` : ""}</li>`).join("") || `<li class="empty">Nothing scheduled today.</li>`}</ul></div></div>
        </div>
        <p class="fine">${t.schedule ? `From ${esc(t.schedule.fileName)} · ` : "Only club meetings so far · "}${input}<label for="ics" style="cursor:pointer;color:var(--accent);font-weight:600">${t.schedule ? "Replace" : "Add your class calendar"}</label>${t.schedule ? ` · <button type="button" data-clear style="border:none;background:none;padding:0;color:var(--accent);font-weight:600;cursor:pointer">Clear</button>` : ""}</p>
        ${ui.scheduleMsg ? `<p class="chip warn" role="alert">${esc(ui.scheduleMsg)}</p>` : ""}
      </section>`;
    wireImport();
    $view.querySelector("[data-plan-now]")?.addEventListener("click", () => {
      Object.assign(sentence, { start: null, picked: false, chosen: null });
      go("#/");
    });
    for (const b of $view.querySelectorAll("[data-plan-at]")) b.addEventListener("click", () => {
      const s = Number(b.dataset.planAt), e = Number(b.dataset.planEnd);
      const startMin = toMin(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s)));
      Object.assign(sentence, { start: toHHMM(startMin), minutes: L.minutesBetween(s, e), picked: true, chosen: null });
      go("#/");
    });
    $view.querySelector("[data-toggle]").addEventListener("click", (e) => {
      ui.showEvents = !ui.showEvents;
      e.currentTarget.setAttribute("aria-expanded", ui.showEvents);
      e.currentTarget.lastChild.textContent = `${ui.showEvents ? "Hide" : "Show"} classes and clubs (${t.events.length})`;
      $view.querySelector("#events").toggleAttribute("inert", !ui.showEvents);
      $view.querySelector("#events").classList.toggle("open", ui.showEvents);
    });
    $view.querySelector("[data-clear]")?.addEventListener("click", () => {
      if (!confirm("Clear your imported calendar from this browser? Saved club meetings stay.")) return;
      clearSchedule(); ui.scheduleMsg = ""; sentence.fromSchedule = false; SCREENS.schedule();
      $announce.textContent = "Calendar cleared.";
    });
  },

  explore() {
    const seen = new Set();
    const places = data.campus.places.filter((p) => !seen.has(p.facility_id) && seen.add(p.facility_id));
    $view.innerHTML = `<div class="head"><h1>Explore</h1></div>
      <section class="stack" style="gap:14px">
        <label class="search">${icon.search}<input type="search" placeholder="Search places and clubs" aria-label="Search places and clubs" id="q"></label>
        <div class="seg" role="tablist" aria-label="Show" data-active="${ui.exploreTab}">
          <button role="tab" aria-selected="${ui.exploreTab === 0}" data-tab-i="0">Places</button>
          <button role="tab" aria-selected="${ui.exploreTab === 1}" data-tab-i="1">Clubs</button>
        </div>
        <ul class="list stagger" id="results"></ul>
      </section>`;
    const $list = $view.querySelector("#results");
    const $q = $view.querySelector("#q");
    const placeRows = () => places.map((p) => {
      const loc = data.hours?.locations?.[p.facility_id];
      const s = loc ? nowStatus(loc) : { status: "unverified", label: "Hours unverified" };
      // Busyness now, from the place's simulated history (the same series the planner ranks on).
      // A closed or unverified building gets no crowd level: empty bars, never a guess. Only verified hours say "closed".
      const level = s.status === "open" ? engine.busynessAt(p, data.histories, campusDateTime().minute).level
        : s.status === "closed" || s.status === "closed_today" ? "closed" : "unknown";
      const word = level === "unknown" ? "no data" : level;
      return `<li data-name="${esc(p.name.toLowerCase())}"><a class="row" href="index.html#/place/${encodeURIComponent(p.facility_id)}">
        <span class="main"><span class="title">${esc(p.name)}</span><span class="sub ${s.status === "open" ? "open" : ""}">${esc(nowText(s))}</span></span>
        <span class="busy">${L.busyIcon(level, `${word}${level === "closed" ? "" : ", simulated"}`)}<span class="lvl" data-level="${level}">${esc(word)}</span></span>${icon.go}</a></li>`;
    }).join("");
    const clubRows = async () => {
      try {
        const clubs = await src.clubs.list();
        return clubs.map((c) => `<li data-name="${esc(c.name.toLowerCase())}"><a class="row" href="index.html#/club/${encodeURIComponent(c.id)}">
          <span class="main"><span class="title">${esc(c.name)}</span><span class="sub">${c.meeting_day ? `${esc(c.meeting_day)}s${c.meeting_start ? `, ${fmtTime(toMin(c.meeting_start))}` : ""}` : "Schedule TBD"} · ${esc(c.status ?? "")}</span></span>${icon.go}</a></li>`).join("");
      } catch { return `<li class="empty">Couldn't load clubs.</li>`; }
    };
    const filter = () => {
      const q = $q.value.trim().toLowerCase();
      let shown = 0;
      for (const li of $list.querySelectorAll("li[data-name]")) { const hit = !q || li.dataset.name.includes(q); li.hidden = !hit; shown += hit; }
      $list.querySelector(".no-hit")?.remove();
      if (!shown) $list.insertAdjacentHTML("beforeend", `<li class="empty no-hit">No matches.</li>`);
    };
    const show = async (i) => {
      ui.exploreTab = i;
      $view.querySelector(".seg").dataset.active = i;
      for (const b of $view.querySelectorAll("[data-tab-i]")) b.setAttribute("aria-selected", Number(b.dataset.tabI) === i);
      $list.innerHTML = i === 0 ? placeRows() : await clubRows();
      $list.classList.remove("stagger"); void $list.offsetWidth; $list.classList.add("stagger");
      filter();
    };
    $view.querySelector(".seg").addEventListener("click", (e) => { const b = e.target.closest("[data-tab-i]"); if (b) show(Number(b.dataset.tabI)); });
    $q.addEventListener("input", filter);
    show(ui.exploreTab);
  },
};

// ---------- answer pieces ----------
function bar(o) {
  const parts = o.budget.filter((b) => b.minutes > 0);
  const label = parts.map((b) => `${b.minutes} min ${b.kind}`).join(", ");
  return `<div class="bar" role="img" aria-label="${esc(label)}">${parts.map((b) => `<span class="k-${b.kind}" style="flex:${b.minutes}"></span>`).join("")}</div>`;
}

function renderAnswer(o, result, count, back) {
  const req = result.request;
  const act = actInfo(req.activity);
  const busy = L.visitWords(o);
  const directions = directionsURL(o.place);
  const steps = [
    [o.depart, o.there ? `Walk there <span class="muted">· about ${o.there} min${req.from === L.HERE ? " from you (estimate)" : ` from ${esc(locName(req.from))}`}</span>` : `You're already there`],
    [o.activityStart, `${esc(act.label)} until ${fmtTime(o.activityEnd)}`],
  ];
  $view.innerHTML = `${back}<section class="answer stagger">
      <div><span class="fine" style="font-size:14px;font-weight:600">${sentence.chosen && o !== result.options[0] ? "Your pick" : "Go to"}</span>
        <h1 class="place">${esc(o.place.name)}</h1></div>
      <p class="what"><b>${o.activity} min</b> to ${esc(act.verb)} · <span class="busy">${L.busyIcon(busy.peak, busy.text)}<span class="lvl" data-level="${busy.peak}">${esc(busy.text)}</span></span></p>
      ${bar(o)}
      <ol class="steps">${steps.map(([t, text]) => `<li><time>${fmtTime(t)}</time><span>${text}</span></li>`).join("")}</ol>
      <div class="spacer"></div>
      <div class="btn-col">
        ${directions ? `<a class="btn primary" href="${esc(directions)}" data-directions>Open directions</a>` : `<a class="btn primary" href="index.html#/place/${encodeURIComponent(o.place.facility_id)}">See this place</a>`}
        ${count > 1 ? `<a class="btn" href="#/options">See all ${count} options</a>` : ""}
        <p class="fine" style="text-align:center">Busyness is simulated, not live. Walks are estimates; check hours before you go.</p>
      </div>
    </section>`;
  $announce.textContent = `Go to ${o.place.name}: ${o.activity} minutes to ${act.verb}.`;
  $view.querySelector("[data-directions]")?.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // let "open in new tab" work as usual
    e.preventDefault();
    openDirections(e.currentTarget.href);
  });
}

function optionCard(o, first) {
  const busy = L.visitWords(o);
  const req = engine.normalizeRequest(request());
  return `<article class="opt-card${first ? " best" : ""}">
    <div class="top"><h2>${esc(o.place.name)}</h2><span class="busy" style="font-size:13px">${L.busyIcon(busy.peak, busy.text)}<span class="lvl" data-level="${busy.peak}">${esc(busy.text)}</span></span></div>
    ${bar(o)}
    <div class="facts"><span>Leave<b>${o.there ? fmtTime(o.depart) : "Here"}</b></span><span>${esc(actInfo(req.activity).label)}<b>${o.activity} min</b></span>
      <span>Done at<b>${fmtTime(o.activityEnd)}</b></span></div>
    <button class="btn${first ? " primary" : ""}" type="button" data-choose="${esc(o.place.place_id)}">Choose</button>
  </article>`;
}

function renderNoFit(result, back) {
  const names = (list) => list.map((o) => esc(o.place.name)).join(", ");
  let body;
  if (result.browse.length) {
    const why = loc.status === "denied" ? "Location is turned off for this site, so the walk to each place can't be timed."
      : loc.status === "unavailable" ? "Your location couldn't be found, so the walk to each place can't be timed."
      : "BU-sy needs your location to time the walk to each place.";
    body = `<h1 style="margin:0;font-size:28px">Where are you?</h1>
      <p class="fine" style="font-size:15px">${why} These could work: ${names(result.browse)}.</p>
      <div class="btn-col"><button class="btn primary" type="button" data-locate>Use my location</button>
        <button class="btn" type="button" data-near>I'm near a campus building</button></div>
      ${loc.status === "denied" ? `<p class="fine">To turn it back on, allow location for this site in your browser's settings.</p>` : ""}`;
  } else if (result.checkAccess.length) {
    body = `<h1 style="margin:0;font-size:28px">Can you get in?</h1>
      <p class="fine" style="font-size:15px">${names(result.checkAccess)} would fit, but you haven't said you can use ${result.checkAccess.length === 1 ? "it" : "them"}.</p>
      <a class="btn primary" href="#/access">Update access</a>`;
  } else {
    body = `<h1 style="margin:0;font-size:28px">Nothing fits this window</h1>
      <ul class="list">${result.reasons.map((r) => `<li class="row"><span class="main"><span class="title">${r.count} ${r.count === 1 ? "place" : "places"}</span><span class="sub">${esc(r.text)}</span></span></li>`).join("")}
        ${result.checkHours.length ? `<li class="row"><span class="main"><span class="title">Hours unknown</span><span class="sub">${names(result.checkHours)}</span></span></li>` : ""}</ul>
      ${result.suggestions.length ? `<p class="label" style="margin-top:8px">These would fit</p><div class="btn-col">${result.suggestions.map((s, i) =>
        `<button class="btn${i === 0 ? " primary" : ""}" type="button" data-fix="${i}">${esc(s.label)}<span style="font-weight:400;opacity:.8"> · ${esc(s.detail)}</span></button>`).join("")}</div>`
        : result.reasons.some((r) => r.code === "access") ? `<a class="btn primary" href="#/access">Update access</a>` : `<a class="btn primary" href="#/">Change my plan</a>`}`;
  }
  $view.innerHTML = `${back}<section class="stack stagger">${body}</section>`;
  $view.querySelector("[data-locate]")?.addEventListener("click", async () => {
    showLoader("Finding where you are");
    await locate();
    hideLoader();
    SCREENS.answer();
  });
  $view.querySelector("[data-near]")?.addEventListener("click", () => PICKERS.near(() => SCREENS.answer()));
  for (const b of $view.querySelectorAll("[data-fix]")) b.addEventListener("click", () => {
    Object.assign(sentence, L.applySuggestion(sentence, result.suggestions[Number(b.dataset.fix)].patch), { picked: true });
    SCREENS.answer();
    $view.classList.remove("enter"); void $view.offsetWidth; $view.classList.add("enter");
  });
}

// ---------- pickers ----------
const PICKERS = {
  time() {
    const t = today();
    const free = t.hasAny ? L.freeNow(t.segments, t.now) : null;
    const options = L.PRESETS.map((m) => ({ value: m, label: L.durationText(m), pressed: sentence.minutes === m && !sentence.fromSchedule }));
    if (free) {
      const m = Math.max(5, L.minutesBetween(t.now, free.end));
      options.unshift({ value: "schedule", label: "Until my next event", note: `${L.durationText(m)}, until ${at(free.end)}`, pressed: !!sentence.fromSchedule && !sentence.picked });
    }
    openSheet("How long are you free?", options, (v) => {
      if (v === "schedule") Object.assign(sentence, { picked: false, start: null });
      else Object.assign(sentence, { minutes: v, picked: true, fromSchedule: false });
      sentence.chosen = null;
      SCREENS.plan(); pop('[data-pick="time"]');
    });
  },
  activity() {
    openSheet("What do you want to do?", data.campus.activities.map((a) => ({ value: a.id, label: a.label, pressed: a.id === sentence.activity })), (v) => {
      Object.assign(sentence, { activity: v, patch: {}, chosen: null });
      SCREENS.plan(); pop('[data-pick="activity"]');
    });
  },
  // Fallback only, when location is off: a building you're next to, for this visit (not remembered).
  near(after) {
    const options = data.campus.locations.map((l) => ({ value: l.id, label: l.name, pressed: l.id === loc.near }));
    openSheet("Which building are you near?", options, (v) => { loc.near = v; sentence.chosen = null; after(); });
  },
};

// Statuses and "free now" move with the clock: refresh the live screens every minute.
setInterval(() => { if (["schedule", "explore"].includes(current) && !document.querySelector(".sheet")) SCREENS[current](); }, 60_000);

// Imports go through the main app's validator and storage, so both see the same schedule.
function wireImport() {
  const $file = $view.querySelector("#ics");
  $file?.addEventListener("change", async () => {
    const file = $file.files[0];
    if (!file) return;
    try {
      const schedule = await importCalendarFile(file);
      ui.scheduleMsg = "";
      Object.assign(sentence, { picked: false, start: null });
      $announce.textContent = `Imported ${schedule.fileName}.`;
    } catch (err) {
      ui.scheduleMsg = `${err.message} Your previous schedule is unchanged.`;
    }
    SCREENS.schedule();
  });
}

route();
