// BU-sy minimal prototype: plan a gap in one sentence. Every decision comes from the
// shared modules the main app uses: the engine (recommend.js), verified hours (hours.js),
// the .ics import and free time (schedule.js, availability.js) and saved club meetings.
import { daySegments, zonedInstant } from "../js/availability.js";
import { fmtTime, toHHMM, toMin } from "../js/clock.js";
import { addClubEvent, clubBusy, clubEventItems, clubMeetings, loadClubEvents, removeClubEvent } from "../js/clubevents.js";
import { campusDateTime, nowServiceLabel, nowStatus, nowText, selectedBuildingStatus, todayBuildingHoursSummary } from "../js/hours.js";
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
const settings = { onboarded: false, tipSeen: false, from: "", to: "", access: { library: "", fitness: "", dining: "" }, ...saved };
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
  data = { campus, hours, histories, planDate: engine.demoDate(campus, histories) };
  return data;
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
  pin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
};

// ---------- places: status and busyness (simulated history, verified hours) ----------
const statusOf = (p) => { const loc = data.hours?.locations?.[p.facility_id]; return loc ? nowStatus(loc) : { status: "unverified", label: "Hours unverified" }; };
/**
 * Busyness now, from the place's simulated history (the same series the planner ranks on). A closed or
 * unverified building gets no crowd level: an empty crowd, never a guess. Only verified hours say "closed".
 */
function busyNow(p, s = statusOf(p)) {
  if (s.status !== "open") return { level: s.status === "closed" || s.status === "closed_today" ? "closed" : "unknown", pct: null };
  const b = engine.busynessAt(p, data.histories, campusDateTime().minute);
  return { ...b, pct: L.percentFull(b.count, b.capacity) };
}
/** Today's busyness hour by hour (5 AM to 11 PM), for hours the verified schedule says are open. */
function hourly(p) {
  const loc = data.hours?.locations?.[p.facility_id];
  const { date } = campusDateTime();
  return Array.from({ length: 19 }, (_, i) => {
    const minute = (5 + i) * 60;
    const open = Boolean(loc) && selectedBuildingStatus(loc, date, minute + 30).status === "open";
    const b = open ? engine.busynessAt(p, data.histories, minute + 30) : { level: "closed", count: null, capacity: null };
    return { minute, open, level: b.level, pct: L.percentFull(b.count, b.capacity) };
  });
}
const hourLabel = (minute) => { const h = Math.floor(minute / 60) % 24; return `${h % 12 || 12}${h < 12 ? "a" : "p"}`; };

// ---------- clubs ----------
const APP_STATUS = { approved: "You're a member", pending: "Application pending", waitlisted: "On the waitlist", rejected: "Declined" };
function clubWhen(c) {
  if (!c.meeting_day && !c.meeting_start) return "Schedule TBD";
  const day = c.meeting_day ? `${c.meeting_day}s` : "Day TBD";
  return c.meeting_start ? `${day}, ${fmtTime(toMin(c.meeting_start))}–${fmtTime(toMin(c.meeting_end))}` : `${day}, time TBD`;
}
const clubWhere = (c) => [...new Set([c.location_name, c.location_text].filter(Boolean))].join(" · ") || "Location TBD";
const clubSpots = (c) => (c.capacity == null ? "No member limit" : `${c.spots_left} of ${c.capacity} spots left`)
  + (c.waitlist_count ? ` · ${c.waitlist_count} waiting` : "");
const meetingDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

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
  return L.buildRequest({ ...sentence, from: settings.from, to: settings.to, access: settings.access }, d, start, data.planDate);
}

// ---------- router + transitions ----------
const DEPTH = { welcome: 0, access: 1, plan: 2, answer: 3, options: 4, place: 3, club: 3, join: 4 };
const TABS = { plan: "plan", answer: "plan", options: "plan", schedule: "schedule", explore: "explore", place: "explore", club: "explore", join: "explore" };
let current = null;
const hashParts = () => location.hash.replace(/^#\/?/, "").split("/").map((s) => decodeURIComponent(s));
// #/club/<id>/join is its own screen; everything else is named by its first part.
const routeOf = () => { const [first, , third] = hashParts(); return first === "club" && third === "join" ? "join" : first || "plan"; };
const param = () => hashParts()[1] ?? "";

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
    $view.onclick = null;                                 // a screen's delegated handler leaves with it
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
        to <button class="word" data-pick="activity" aria-label="Activity: ${esc(act.verb)}. Change">${esc(act.verb)}</button>,
        starting from <button class="word" data-pick="from" aria-label="Starting point: ${esc(locName(settings.from) || "not set")}. Change">${esc(locName(settings.from) || "somewhere")}</button>.</p>
      <p class="sentence then">Then I'm off to <button class="word" data-pick="to" aria-label="Next stop: ${esc(locName(settings.to) || "none")}. Change">${esc(locName(settings.to) || "wherever")}</button>.</p>
      <p class="hint">Tap a red word to change it.</p>
      <a class="btn primary" href="#/answer">Find a spot</a>
      <p class="fine">Busyness is simulated from a sample Monday, not live. Access: ${access.length ? esc(access.join(", ")) : "not set"} · <a href="#/access">Change</a> · <a href="index.html">Full app</a></p>
    </section>
    ${settings.tipSeen ? "" : `<div class="coach" role="dialog" aria-label="Tip"><p>Tap a <b>red word</b> to change it. That's all BU-sy needs.</p><button class="btn" type="button" data-tip>Got it</button></div>`}`;

    $view.querySelector("[data-tip]")?.addEventListener("click", (e) => {
      settings.tipSeen = true; persist(); e.target.closest(".coach").remove(); $view.querySelector('[data-pick="time"]').focus();
    });
    $view.querySelector(".plan").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b) PICKERS[b.dataset.pick]();
    });
  },

  answer() {
    const result = engine.recommend(request(), data.campus, data.histories, { hours: data.hours });
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
    const result = engine.recommend(request(), data.campus, data.histories, { hours: data.hours });
    const fits = result.ok ? [...result.options, ...result.more] : [];
    const act = actInfo(sentence.activity);
    $view.innerHTML = `<div class="head"><a class="back" href="#/answer">${icon.back}Back</a></div>
      <section class="stack">
        <div><h1 style="margin:0 0 6px;font-size:26px">${fits.length} place${fits.length === 1 ? "" : "s"} fit</h1>
          <ul class="legend"><li><i class="k-there"></i>Walk</li><li><i class="k-preparation"></i>Set up / pack up</li><li><i class="k-activity"></i>${esc(act.label)}</li><li><i class="k-buffer"></i>Buffer</li></ul></div>
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
      const s = statusOf(p);
      const now = busyNow(p, s);
      return `<li data-name="${esc(p.name.toLowerCase())}"><a class="row" href="#/place/${encodeURIComponent(p.facility_id)}">
        <span class="main"><span class="title">${esc(p.name)}</span><span class="sub ${s.status === "open" ? "open" : ""}">${esc(nowText(s))}</span>
          ${L.busyBadge(now.level, { pct: now.pct, label: `${L.levelWord(now.level)}${now.level === "closed" ? "" : ", simulated"}` })}</span>${icon.go}</a></li>`;
    }).join("");
    const clubRows = async () => {
      try {
        const clubs = await src.clubs.list();
        return clubs.map((c) => `<li data-name="${esc(c.name.toLowerCase())}"><a class="row" href="#/club/${encodeURIComponent(c.id)}">
          <span class="main"><span class="title">${esc(c.name)}</span><span class="sub">${esc(clubWhen(c))} · ${esc(c.my_application ? APP_STATUS[c.my_application.status] : c.status ?? "")}</span>
          ${c.busyness_hint ? L.busyBadge(c.busyness_hint.level, { text: `${L.levelWord(c.busyness_hint.level)} at meeting time`, label: `${L.levelWord(c.busyness_hint.level)} at meeting time, estimate` }) : ""}</span>${icon.go}</a></li>`).join("");
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

  place() {
    const back = `<div class="head"><a class="back" href="#/explore">${icon.back}Explore</a></div>`;
    const p = data.campus.places.find((x) => x.facility_id === param());
    if (!p) {
      $view.innerHTML = `${back}<section class="stack"><h1 class="page-title">Place not found</h1><a class="btn primary" href="#/explore">Back to Explore</a></section>`;
      return;
    }
    ui.exploreTab = 0;
    const loc = data.hours?.locations?.[p.facility_id];
    const s = statusOf(p);
    const now = busyNow(p, s);
    const { minute } = campusDateTime();
    const all = hourly(p);
    const first = all.findIndex((x) => x.open), last = all.findLastIndex((x) => x.open);
    const slots = first < 0 ? [] : all.slice(first, last + 1);   // the chart spans today's opening hours only
    const best = L.quietestFrom(slots, minute);
    const directions = directionsURL(p);
    const meal = loc && p.activities?.includes("eat") ? nowServiceLabel(loc) : "";
    const nowLine = now.count != null
      ? `About ${now.count.toLocaleString("en-US")} people, against an illustrative capacity of ${now.capacity.toLocaleString("en-US")}.`
      : now.level === "closed" ? "Closed right now, so there's no crowd to show."
      : "Today's hours aren't verified, so BU-sy doesn't guess how busy it is.";
    const chart = slots.length ? `<div class="day-chart" role="img" aria-label="Busyness today, simulated: ${esc(slots.map((x) =>
        `${hourLabel(x.minute)} ${x.open ? L.levelWord(x.level) : "closed"}`).join(", "))}">
        ${slots.map((x) => `<span class="col${Math.floor(minute / 60) * 60 === x.minute ? " now" : ""}" data-level="${x.open ? x.level : "closed"}" style="--h:${x.open && x.pct != null ? Math.max(8, x.pct) : 4}%">
          <i></i><b>${(x.minute / 60) % 3 === 0 ? hourLabel(x.minute) : ""}</b></span>`).join("")}</div>
        <ul class="legend"><li><i class="lv-quiet"></i>Quiet</li><li><i class="lv-moderate"></i>Moderate</li><li><i class="lv-busy"></i>Busy</li><li><i class="lv-now"></i>Now</li></ul>`
      : `<p class="fine">No verified opening hours today, so there's no busyness to chart.</p>`;
    const bestLine = best ? `<p class="quietest">${icon.clock}<span>${best.minute <= minute && minute < best.minute + 60 ? "Quietest from now: <b>right now</b>" : `Quietest later today: <b>around ${fmtTime(best.minute)}</b>`}</span>
      ${L.busyBadge(best.level, { pct: best.pct, label: `${best.level} then, simulated` })}</p>` : "";

    $view.innerHTML = `${back}<section class="stack stagger place-page">
      <div><h1 class="page-title">${esc(p.name)}</h1><p class="status${s.status === "open" ? " open" : ""}">${esc(nowText(s))}</p></div>
      <div class="card busy-now"><p class="label">How busy right now</p>
        ${L.busyBadge(now.level, { pct: now.pct, size: "lg", label: `${L.levelWord(now.level)}${now.level === "closed" ? "" : ", simulated"}` })}
        <p class="fine">${nowLine}</p></div>
      <div><p class="label">Today</p>${chart}${bestLine}</div>
      <ul class="list">
        <li class="row static"><span class="main"><span class="sub">Hours today</span><span class="title">${esc(loc ? todayBuildingHoursSummary(loc) : "Hours unverified")}</span></span></li>
        ${meal ? `<li class="row static"><span class="main"><span class="sub">Meal service</span><span class="title">${esc(meal)}</span></span></li>` : ""}
      </ul>
      <div class="btn-col">
        ${directions ? `<a class="btn primary" href="${esc(directions)}" data-directions>Open directions</a>` : ""}
        <a class="btn${directions ? "" : " primary"}" href="#/">Plan my free time</a>
      </div>
      <p class="fine">Busyness is simulated from a sample day of outside datasets, not live BU counts. Hours come from BU's published schedules.</p>
    </section>`;
    $view.querySelector("[data-directions]")?.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openDirections(e.currentTarget.href);
    });
  },

  club() {
    const id = param();
    ui.exploreTab = 1;                                    // back to Explore lands on the Clubs list
    const back = `<div class="head"><a class="back" href="#/explore">${icon.back}Clubs</a></div>`;
    const stillHere = () => current === "club" && param() === id;
    $view.innerHTML = `${back}<p class="fine" role="status">Loading club…</p>`;
    let c = null, notice = "";
    const meetings = () => {
      const { regular, extra } = clubMeetings(c);
      const saved = new Set(loadClubEvents().map((e) => e.id));
      return `<div class="meetings" aria-live="polite"><p class="label">Next meetings</p>${notice}
        <ul class="list">${regular.map((m) => `<li class="row static"><span class="main"><span class="title">${esc(meetingDate(m.date))}, ${fmtTime(toMin(m.start))}–${fmtTime(toMin(m.end))}</span>
          <span class="sub">${esc(m.location || "Location TBD")}</span></span>
          ${saved.has(m.id) ? `<button class="chip-btn added" type="button" data-cal-remove="${esc(m.id)}" aria-label="Remove the meeting on ${esc(meetingDate(m.date))} from your schedule">${icon.check}Added</button>`
            : `<button class="chip-btn" type="button" data-cal-add="${esc(m.id)}" aria-label="Add the meeting on ${esc(meetingDate(m.date))} to your schedule">Add</button>`}</li>`).join("")
          || `<li class="empty">No weekly meeting time listed yet.</li>`}
          ${extra.map((m) => `<li class="row static"><span class="main"><span class="title">${esc(meetingDate(m.date))}${m.note ? ` · ${esc(m.note)}` : ""}</span><span class="sub">Extra meeting · time not listed</span></span></li>`).join("")}</ul>
        <p class="fine">Added meetings show on your Schedule and count as busy when BU-sy looks for free time. Saved in this browser only.</p></div>`;
    };
    const joinBox = () => {
      const a = c.my_application;
      if (c.is_organizer) return `<p class="label">You run this club</p><p class="fine">${esc(clubSpots(c))}. Review applications and edit the club in the <a href="index.html#/club/${encodeURIComponent(c.id)}/manage">full app</a>.</p>`;
      if (a) {
        const next = { approved: "Come along to the next meeting.", pending: "An officer will review your application.", rejected: "The organizer declined this application.",
          waitlisted: `You're #${a.position} in line. If a spot opens you move up automatically.` }[a.status];
        return `<p class="label">Your status</p><p class="join-status" data-app="${esc(a.status)}">${esc(APP_STATUS[a.status])}</p><p class="fine">${esc(next)}</p>
          ${a.status !== "rejected" ? `<button class="btn" type="button" data-withdraw>Withdraw</button>` : ""}`;
      }
      if (c.status === "Full") return `<p class="label">Full</p><p class="fine">${esc(clubSpots(c))}. Not taking waitlist sign-ups right now.</p>`;
      return `<p class="label">${c.status === "Open" ? "Spots available" : "Full · waitlist open"}</p><p class="fine">${esc(clubSpots(c))}</p>
        <a class="btn primary" href="#/club/${encodeURIComponent(c.id)}/join">${c.status === "Open" ? (c.requires_approval ? "Apply to join" : "Join") : "Join the waitlist"}</a>`;
    };
    const render = () => {
      const h = c.busyness_hint;
      const more = [["Activities", c.activities], ["Requirements", c.requirements], ["Joining", c.requires_approval ? "An officer approves each application" : "Open sign-up: you're in right away if there's a spot"],
        ["Officers", c.officers?.map((o) => `${o.role}: ${o.name}`).join(", ")], ["Contact", c.contact]].filter(([, v]) => v);
      $view.innerHTML = `${back}<section class="stack stagger club-page">
        <div><p class="tags"><span class="tag" data-status="${esc(c.status.toLowerCase())}">${esc(c.status)}</span><span class="tag">${esc(c.category)}</span>${c.example ? `<span class="tag soft" title="Sample club for the demo, not a real BU organization">Sample</span>` : ""}</p>
          <h1 class="page-title">${esc(c.name)}</h1><p class="lede">${esc(c.description)}</p></div>
        <ul class="list">
          <li class="row static">${icon.clock}<span class="main"><span class="title">${esc(clubWhen(c))}</span><span class="sub">When it meets</span></span></li>
          <li class="row static">${icon.pin}<span class="main"><span class="title">${esc(clubWhere(c))}</span><span class="sub">Where</span></span></li>
        </ul>
        <div class="card"><p class="label">Busy at meeting time?</p>
          ${h ? `${L.busyBadge(h.level, { pct: L.percentFull(h.estimate, h.capacity), size: "lg", label: `${L.levelWord(h.level)} at meeting time, estimate` })}<p class="fine">${esc(h.basis)}</p>`
            : `<p class="fine">No estimate: ${c.location_id ? "no meeting time is set" : "this meeting place has no busyness data"}.</p>`}</div>
        <div class="card join-card" aria-live="polite">${joinBox()}</div>
        ${meetings()}
        ${more.length ? `<details class="more-info"><summary>${icon.chev}More about this club</summary><dl>${more.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>` : ""}
      </section>`;
    };
    $view.onclick = async (e) => {
      if (!c || current !== "club") return;
      const add = e.target.closest("[data-cal-add]"), remove = e.target.closest("[data-cal-remove]");
      if (add || remove) {
        const m = clubMeetings(c).regular.find((x) => x.id === (add ?? remove).dataset[add ? "calAdd" : "calRemove"]);
        try {
          if (!m) throw new Error("That meeting is no longer on the club's schedule.");
          if (add) addClubEvent(m); else removeClubEvent(m.id);
          notice = `<p class="chip free" role="status">${add ? `Added ${esc(meetingDate(m.date))} to your schedule.` : `Removed ${esc(meetingDate(m.date))} from your schedule.`}</p>`;
        } catch (err) {
          notice = `<p class="chip warn" role="alert">${esc(err instanceof DOMException ? "This browser couldn't save your schedule, so nothing changed." : err.message)}</p>`;
        }
        $view.querySelector(".meetings").outerHTML = meetings();
        $view.querySelector(`.meetings [data-cal-add="${CSS.escape(m?.id ?? "")}"], .meetings [data-cal-remove="${CSS.escape(m?.id ?? "")}"]`)?.focus();
        return;
      }
      if (e.target.closest("[data-withdraw]")) {
        if (!confirm(`Withdraw from ${c.name}?`)) return;
        try { c = await src.clubs.withdraw(id); render(); $announce.textContent = `Withdrawn from ${c.name}.`; } catch (err) { alert(err.message); }
      }
    };
    src.clubs.get(id).then((club) => { if (!stillHere()) return; c = club; render(); })
      .catch((err) => { if (stillHere()) $view.innerHTML = `${back}<section class="stack"><h1 class="page-title">Couldn't load this club</h1><p class="fine">${esc(err.message)}</p></section>`; });
  },

  join() {
    const id = param();
    const back = `<div class="head"><a class="back" href="#/club/${encodeURIComponent(id)}">${icon.back}Club</a></div>`;
    const stillHere = () => current === "join" && param() === id;
    $view.innerHTML = `${back}<p class="fine" role="status">Loading…</p>`;
    Promise.all([src.clubs.get(id), src.clubOptions(), src.getMode()]).then(([c, o, mode]) => {
      if (!stillHere()) return;
      if (c.my_application || c.is_organizer || c.status === "Full") { go(`#/club/${encodeURIComponent(id)}`); return; }
      let waitlist = c.status === "Waitlist";
      const lim = o.limits;
      const field = (label, input, note = "") => `<label class="field"><span>${label}${note ? ` <span class="field-note">${note}</span>` : ""}</span>${input}</label>`;
      $view.innerHTML = `${back}<section class="stack stagger">
        <div><h1 class="page-title">${waitlist ? "Join the waitlist" : c.requires_approval ? "Apply to join" : "Join"}</h1><p class="lede">${esc(c.name)}</p></div>
        <form class="form" id="join-club" novalidate>
          <p class="chip warn" id="full-note" role="status"${waitlist ? "" : " hidden"}>This club is full. You'll join its waitlist, in sign-up order.</p>
          ${field("Full name", `<input name="name" required maxlength="${lim.applicant_name}" autocomplete="name">`)}
          ${field("School email", `<input name="email" type="email" required maxlength="${lim.email}" autocomplete="email" inputmode="email" placeholder="name@bu.edu">`)}
          ${field("Year", `<select name="year" required><option value="">Choose…</option>${o.years.map((y) => `<option>${esc(y)}</option>`).join("")}</select>`)}
          ${field("Other contact", `<input name="contact" maxlength="${lim.contact}" placeholder="Phone or handle">`, "optional")}
          ${field("Why do you want to join?", `<textarea name="reason" rows="3" maxlength="${lim.reason}"></textarea>`, "optional")}
          ${field("Availability", `<input name="availability" maxlength="${lim.availability}" placeholder="e.g. weekday evenings">`, "optional")}
          <p class="fine">Only this club's organizer sees these details. ${mode === "static" ? "Demo mode: they're stored in this browser only." : "They're stored on the BU-sy demo server."} BU-sy doesn't send emails.</p>
          <p class="form-error" role="alert"></p>
          <button class="btn primary" type="submit">${waitlist ? "Join waitlist" : c.requires_approval ? "Send application" : "Join club"}</button>
        </form></section>`;
      const form = $view.querySelector("#join-club"), $err = form.querySelector(".form-error"), $btn = form.querySelector("button");
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
        const problem = src.applicationProblem(d, o);          // same rules as the server
        if (problem) {
          $err.textContent = problem.message;
          const el = form.elements.namedItem(problem.field);
          el?.setAttribute("aria-invalid", "true"); el?.focus();
          return;
        }
        $btn.disabled = true;
        try {
          const updated = await src.clubs.apply(id, { ...d, join_waitlist: waitlist });
          const a = updated.my_application;
          const [title, text] = { approved: ["You're in", `You're a member of ${updated.name}. ${clubWhen(updated) === "Schedule TBD" ? "Its meeting time isn't set yet." : `It meets ${clubWhen(updated)}.`}`],
            pending: ["Application sent", `An officer of ${updated.name} will review it. You won't get an email; check back here.`],
            waitlisted: [`You're #${a.position} on the waitlist`, `If a spot opens at ${updated.name}, you move up automatically in sign-up order.`] }[a.status];
          $view.innerHTML = `${back}<section class="stack stagger done" role="status"><div class="logo">${icon.check}</div>
            <h1 class="page-title">${esc(title)}</h1><p class="lede">${esc(text)}</p>
            <div class="btn-col"><a class="btn primary" href="#/club/${encodeURIComponent(id)}">Back to the club</a><a class="btn" href="#/explore">Explore more clubs</a></div></section>`;
          $view.focus({ preventScroll: true });
        } catch (err) {
          $btn.disabled = false;
          if (err.status === 409 && /waitlist instead/.test(err.message)) {   // filled up while typing
            waitlist = true;
            form.querySelector("#full-note").hidden = false;
            $btn.textContent = "Join waitlist";
            $err.textContent = "The last spot was just taken. You can join the waitlist instead.";
          } else {
            $err.textContent = err.message;
          }
        }
      });
    }).catch((err) => { if (stillHere()) $view.innerHTML = `${back}<section class="stack"><h1 class="page-title">Couldn't load this club</h1><p class="fine">${esc(err.message)}</p></section>`; });
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
    [o.depart, o.there ? `Leave ${esc(locName(req.from))} <span class="muted">· ${o.there} min walk</span>` : `You're already there`],
    [o.activityStart, `${esc(act.label)} until ${fmtTime(o.activityEnd)}`],
    [o.leaveBy, req.to ? `Head to ${esc(locName(req.to))} <span class="muted">· there by ${fmtTime(o.arriveNext)}</span>` : `Pack up <span class="muted">· free until ${fmtTime(o.windowEnd)}</span>`],
  ];
  $view.innerHTML = `${back}<section class="answer stagger">
      <div><span class="fine" style="font-size:14px;font-weight:600">${sentence.chosen && o !== result.options[0] ? "Your pick" : "Go to"}</span>
        <h1 class="place">${esc(o.place.name)}</h1></div>
      <p class="what"><b>${o.activity} min</b> to ${esc(act.verb)}</p>
      <p class="what">${L.busyBadge(busy.peak ?? "unknown", { text: busy.text, label: `${busy.text} during your visit, simulated` })}</p>
      ${bar(o)}
      <ol class="steps">${steps.map(([t, text]) => `<li><time>${fmtTime(t)}</time><span>${text}</span></li>`).join("")}</ol>
      <div class="spacer"></div>
      <div class="btn-col">
        ${directions ? `<a class="btn primary" href="${esc(directions)}" data-directions>Open directions</a>` : `<a class="btn primary" href="#/place/${encodeURIComponent(o.place.facility_id)}">See this place</a>`}
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
    <div class="top"><h2>${esc(o.place.name)}</h2>${L.busyBadge(busy.peak ?? "unknown", { text: busy.text, label: `${busy.text} during your visit, simulated` })}</div>
    ${bar(o)}
    <div class="facts"><span>Leave<b>${o.there ? fmtTime(o.depart) : "Here"}</b></span><span>${esc(actInfo(req.activity).label)}<b>${o.activity} min</b></span>
      <span>${req.to ? `At ${esc(locName(req.to))}` : "Free until"}<b>${fmtTime(req.to ? o.arriveNext : o.windowEnd)}</b></span></div>
    <button class="btn${first ? " primary" : ""}" type="button" data-choose="${esc(o.place.place_id)}">Choose</button>
  </article>`;
}

function renderNoFit(result, back) {
  const names = (list) => list.map((o) => esc(o.place.name)).join(", ");
  let body;
  if (result.browse.length) {
    body = `<h1 style="margin:0;font-size:28px">Where are you starting?</h1>
      <p class="fine" style="font-size:15px">These could work, but the walk can't be checked without a starting point: ${names(result.browse)}.</p>
      <button class="btn primary" type="button" data-fix-from>Set a starting point</button>`;
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
  $view.querySelector("[data-fix-from]")?.addEventListener("click", () => PICKERS.from(() => SCREENS.answer()));
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
  from(after) {
    const options = [{ value: "", label: "Not set", note: "walks can't be checked", pressed: !settings.from },
      ...data.campus.locations.map((l) => ({ value: l.id, label: l.name, pressed: l.id === settings.from }))];
    openSheet("Where are you now?", options, (v) => {
      settings.from = v; persist(); sentence.chosen = null;
      if (typeof after === "function") { after(); return; }
      SCREENS.plan(); pop('[data-pick="from"]');
    });
  },
  to() {
    const options = [{ value: "", label: "Wherever", note: "no walk after", pressed: !settings.to },
      ...data.campus.locations.map((l) => ({ value: l.id, label: l.name, pressed: l.id === settings.to }))];
    openSheet("Where do you need to be after?", options, (v) => {
      settings.to = v; persist(); sentence.chosen = null;
      SCREENS.plan(); pop('[data-pick="to"]');
    });
  },
};

// Statuses and "free now" move with the clock: refresh the live screens every minute.
setInterval(() => { if (["schedule", "explore", "place"].includes(current) && !document.querySelector(".sheet")) SCREENS[current](); }, 60_000);

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
