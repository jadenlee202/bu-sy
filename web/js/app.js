import { clockSec, fmtHHMM, fmtHour, fmtShort, fmtTime, latestAt, obsMinute, obsOffset } from "./clock.js";
import { clubFormView, clubView, clubsView, joinView, manageView, myClubsView } from "./clubs.js";
import { icon, paw, terrier } from "./icons.js";
import { planView } from "./plan.js";
import { hoursText, openSegments } from "./recommend.js";
import { placeAvailability, zonedInstant } from "./availability.js";
import { calendarView, DEFAULT_TZ, formatInstant, loadCalendarPrefs, MIN_OPTIONS } from "./calendar.js";
import { findTimeCard } from "./findtime.js";
import { busyOf, covers, loadSchedule } from "./schedule.js";
import {
  addDays, buildingHoursSummary, campusDateTime, dateLabel, daySchedule, displaySchedule, formatPeriod,
  selectedBuildingStatus, selectedStatusLabel, serviceAtTime, serviceStatusLabel, weekRangeLabel, weekStart,
} from "./hours.js";
import * as src from "./source.js";
import { LEVEL, esc, failure, fmtCount, level, loading } from "./ui.js";

// ---------- constants ----------
// One replay clock, shared by every screen, covering the whole day. Outside a place's
// recorded hours it shows "Closed" when the place's hours say so, otherwise "No data".
const DAY_START = 0;
const DAY_END = 24 * 60 - 1;       // 11:59 PM
const FIRST_VIEW = 17 * 60 + 30;   // open on a busy moment instead of an empty morning
const STEP_MIN = 5;                // each playback tick; the slider itself moves by the minute
const TICK_MS = 300;               // at 1×; faster speeds tick more often, so the step stays 5 minutes
const SPEEDS = [1, 2, 4, 6];

const CATEGORY = { fitness: "Fitness", dining: "Dining", library: "Library", office: "Office" };
const FILTERS = [["all", "All"], ["fitness", "Fitness"], ["dining", "Dining"], ["library", "Library"], ["historical", "Historical"]];
// Availability filters combine with the category chips. Only "open_now" works without an uploaded schedule.
const AVAIL_FILTERS = [["any", "Any time"], ["open_now", "Open now"], ["free", "Open during my free time"],
  ["breakfast", "Serving breakfast during my free time"], ["brunch", "Serving brunch during my free time"],
  ["lunch", "Serving lunch during my free time"], ["dinner", "Serving dinner during my free time"]];
const CALENDAR_FILTERS = new Set(["free", "breakfast", "brunch", "lunch", "dinner"]);

const state = { minute: FIRST_VIEW, playing: false, speed: 1, timer: null, filter: "all", query: "", avail: "any" };
const $view = document.getElementById("view");
let view = null; // the mounted screen: { update?(), resize?() }

// ---------- helpers ----------
const isHistorical = (f) => f.data_mode === "historical_playback";
const tag = (f) => (isHistorical(f)
  ? `<span class="tag tag-real" title="Real recorded data from elsewhere, replayed. Not live, not BU.">Historical</span>`
  : `<span class="tag">Sample</span>`);
const backToPlaces = `<a class="back" href="#/places">${icon("back", 16)} All places</a>`;
const offsetText = (o) => (obsOffset(o) ? `UTC${obsOffset(o).replace("-", "−")}` : "timezone unverified");

/**
 * Quietest later hour. With a typical profile it's a historical pattern; without one
 * it's read from the same recorded day, so it's labelled as hindsight. `insight_hours`
 * limits the search (the gym's opening hours are unknown, so nights are left out).
 */
function quieterTime(hist, minute) {
  const series = hist.typical ?? hist.hourly;
  // Short form here; the full averaging method is under "How this works".
  const basis = hist.typical ? hist.typical_label.split(" (")[0] : `${hist.day_label} · in hindsight, from the same day`;
  const [lo, hi] = hist.insight_hours ?? [0, 24];
  const later = series.filter((b) => b.hour * 60 > minute && b.hour >= lo && b.hour < hi && b.occupancy != null);
  if (!later.length) return { kind: "none", basis };
  const best = later.reduce((a, b) => (b.occupancy < a.occupancy ? b : a));
  const thisHour = series.find((b) => b.hour === Math.floor(minute / 60));
  if (thisHour?.occupancy != null && best.occupancy >= thisHour.occupancy) return { kind: "now", basis };
  return { kind: "later", hour: best.hour, value: best.occupancy, basis, usual: !!hist.typical };
}

/**
 * Opening hours for a campus place, from the planner data (illustrative samples).
 * null when unknown: Fenway Dining, and the historical references, whose hours
 * aren't documented, so the app never claims they were closed.
 */
function openingHours(campus, facilityId) {
  const p = campus.places.find((x) => x.facility_id === facilityId && x.hours);
  return p ? { segs: openSegments({ hours: p.hours, closures: [] }), text: hoursText(p), basis: p.hours_basis } : null;
}

/** Closed at `minute` by those hours: { opens } (null = not again today); null when open or unknown. */
function closedAt(hours, minute) {
  if (!hours || hours.segs.some(([a, b]) => minute >= a && minute < b)) return null;
  const next = hours.segs.find(([a]) => a > minute);
  return { opens: next ? next[0] : null };
}

const closedText = (closed, hours) => `${closed.opens != null ? `Opens at ${fmtShort(closed.opens)}` : "Closed for the rest of the day"}`
  + ` · ${hours.basis === "verified" ? "" : "sample "}hours ${hours.text}`;

/** Observation at the playback minute, plus why there is none (before, gap, ended). */
function observationAt(hist, minute) {
  const o = latestAt(hist.observations, minute, hist.coverage_end, hist.max_hold_minutes);
  if (o) return { o };
  const sec = minute * 60;
  if (!hist.observations.length || sec < clockSec(hist.observations[0].observed_at.slice(11, 19))) return { why: "before" };
  if (sec > clockSec(hist.coverage_end)) return { why: "ended" };
  return { why: "gap" };
}

// ---------- playback (one clock shared by every screen) ----------
function playbackBar() {
  return `<div class="playback" role="group" aria-label="Historical playback">
    <button class="icon-btn pb-toggle" data-pb="toggle"></button>
    <div class="pb-main">
      <div class="pb-row"><span class="pb-time num"></span>
        <span class="pb-speed" role="group" aria-label="Playback speed">${SPEEDS.map((x) =>
          `<button class="pb-speed-btn num" type="button" data-pb-speed="${x}" aria-label="${x}× speed">${x}×</button>`).join("")}</span>
        <span class="pb-status"></span></div>
      <input class="pb-range" type="range" min="${DAY_START}" max="${DAY_END}" step="1" aria-label="Playback time">
      <div class="pb-ends num" aria-hidden="true"><span>${fmtTime(DAY_START)}</span><span>${fmtTime(DAY_END)}</span></div>
    </div>
    <button class="icon-btn" data-pb="reset" aria-label="Back to ${fmtTime(DAY_START)}" title="Back to ${fmtTime(DAY_START)}">${icon("reset")}</button>
  </div>`;
}

function syncPlayback() {
  const ended = state.minute >= DAY_END;
  for (const el of document.querySelectorAll(".pb-time")) el.textContent = fmtTime(state.minute);
  for (const el of document.querySelectorAll(".pb-status")) {
    el.textContent = state.playing ? `Replay running${state.speed > 1 ? ` at ${state.speed}×` : ""}` : ended ? "End of replay" : "Replay paused";
  }
  for (const el of document.querySelectorAll("[data-pb-speed]")) {
    el.setAttribute("aria-pressed", Number(el.dataset.pbSpeed) === state.speed);
  }
  for (const el of document.querySelectorAll(".pb-range")) {
    el.value = state.minute;
    el.setAttribute("aria-valuetext", fmtTime(state.minute));
  }
  for (const el of document.querySelectorAll(".pb-toggle")) {
    el.innerHTML = icon(state.playing ? "pause" : "play");
    el.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }
  view?.update?.();
}

function setPlaying(on) {
  clearInterval(state.timer);
  state.playing = on;
  if (on) {
    if (state.minute >= DAY_END) state.minute = DAY_START;
    state.timer = setInterval(() => {
      state.minute = Math.min(DAY_END, state.minute + STEP_MIN);
      if (state.minute >= DAY_END) setPlaying(false); else syncPlayback();
    }, TICK_MS / state.speed);
  }
  syncPlayback();
}

document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-pb]")?.dataset.pb;
  if (action === "toggle") setPlaying(!state.playing);
  if (action === "reset") { state.minute = DAY_START; setPlaying(false); }
  const speed = e.target.closest("[data-pb-speed]")?.dataset.pbSpeed;
  if (speed) {
    state.speed = Number(speed);
    // A running replay switches speed in place; a paused one keeps it for the next play.
    if (state.playing) setPlaying(true); else syncPlayback();
  }
});
document.addEventListener("input", (e) => {
  if (!e.target.matches(".pb-range")) return;
  state.minute = Number(e.target.value);
  setPlaying(false);
});

// ---------- screen: places ----------
async function placesView() {
  $view.innerHTML = `
    <div class="page-head"><h1 class="title">How busy is it?</h1>
      <p class="tagline">Replays of recorded days. Tags show where each place's data comes from.</p></div>
    ${playbackBar()}
    <label class="search">${icon("search")}<input type="search" placeholder="Search places" aria-label="Search places" value="${esc(state.query)}"></label>
    <div class="chips" role="group" aria-label="Filter places">
      ${FILTERS.map(([id, label]) => `<button class="chip" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join("")}
    </div>
    <div class="chips" id="avail-chips" role="group" aria-label="Filter by availability"></div>
    <div class="avail-panel" id="avail-panel" aria-live="polite"></div>
    <div id="places" class="places" aria-live="polite">${loading()}</div>`;
  syncPlayback();

  const $list = $view.querySelector("#places");
  let facilities, histories, campus, hours;
  try {
    [facilities, campus, hours] = await Promise.all([src.listFacilities(), src.getCampus(), src.getHours()]);
    histories = Object.fromEntries(
      await Promise.all(facilities.map(async (f) => [f.facility_id, await src.getHistory(f.facility_id)])),
    );
  } catch (err) {
    $list.innerHTML = failure(err);
    return {};
  }

  // Free-time filters read the schedule uploaded on the Calendar page (kept in this browser).
  const schedule = loadSchedule();
  const prefs = loadCalendarPrefs();
  const zone = prefs.timezone ?? DEFAULT_TZ;
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const freeFilter = { date: todayLocal, minimum: prefs.minimum ?? 30, from: prefs.from ?? "08:00", until: prefs.until ?? "22:00" };
  const $availChips = $view.querySelector("#avail-chips");
  const $availPanel = $view.querySelector("#avail-panel");

  const renderAvailControls = () => {
    if (CALENDAR_FILTERS.has(state.avail) && !schedule) state.avail = "any";
    const offered = AVAIL_FILTERS.filter(([id]) => !CALENDAR_FILTERS.has(id) || schedule);
    $availChips.innerHTML = offered.map(([id, label]) =>
      `<button class="chip" data-avail="${id}" aria-pressed="${state.avail === id}">${label}</button>`).join("");
    if (CALENDAR_FILTERS.has(state.avail)) {
      $availPanel.innerHTML = `<div class="calendar-controls calendar-controls-grid">
          <label>Date<input type="date" data-free="date" value="${freeFilter.date}"></label>
          <label>Free for at least<select data-free="minimum">${MIN_OPTIONS.map((minutes) =>
            `<option value="${minutes}"${minutes === freeFilter.minimum ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
        </div>
        <p class="help">Using your uploaded schedule (${esc(schedule.fileName)}) within ${esc(freeFilter.from)}–${esc(freeFilter.until)} (${esc(zone)}). <a href="#/calendar">Change on the Calendar page</a>. Travel time isn't included.</p>`;
    } else if (state.avail === "open_now") {
      $availPanel.innerHTML = `<p class="help">Open right now by each place's published hours (campus time), not the replay slider.</p>`;
    } else {
      $availPanel.innerHTML = schedule ? ""
        : `<p class="help"><a href="#/calendar">Upload your class schedule (.ics)</a> to find places open during your free time. It's read in this browser and never uploaded.</p>`;
    }
  };
  renderAvailControls();

  const visible = () => {
    const q = state.query.trim().toLowerCase();
    return facilities.filter((f) =>
      (state.filter === "all" || (state.filter === "historical" ? isHistorical(f) : f.category === state.filter)) &&
      (!q || `${f.facility_name} ${CATEGORY[f.category] ?? ""}`.toLowerCase().includes(q)));
  };

  // Applies the availability filter. Returns the kept places with their first matching window,
  // the places whose hours can't be checked, and a notice when the date can't be checked at all.
  const applyAvailability = (rows) => {
    if (state.avail === "any") return { rows, windows: {}, unchecked: [], notice: "" };
    const calendarMode = CALENDAR_FILTERS.has(state.avail);
    if (calendarMode) {
      let covered = false;
      try {
        covered = covers(schedule, zonedInstant(freeFilter.date, freeFilter.from, zone), zonedInstant(freeFilter.date, freeFilter.until, zone));
      } catch { /* a preferred hour that doesn't exist on this date: treated as not covered */ }
      if (!covered) {
        return {
          rows: [], windows: {}, unchecked: [],
          notice: `<p class="help">This date is outside the dates your uploaded calendar covers, so BU-sy can't tell when you're free. Choose another date or <a href="#/calendar">upload a newer export</a>.</p>`,
        };
      }
    }
    const context = calendarMode
      ? { busy: busyOf(schedule), date: freeFilter.date, timezone: zone, from: freeFilter.from, until: freeFilter.until, minimum: freeFilter.minimum, now: Date.now() }
      : { now: Date.now() };
    const kept = [];
    const windows = {};
    const unchecked = [];
    for (const f of rows) {
      if (isHistorical(f)) continue; // never suggested
      const location = hours.locations[f.facility_id];
      const outcome = location ? placeAvailability(location, f.category, state.avail, context) : { result: "unchecked" };
      if (outcome.result === "match") {
        kept.push(f);
        if (outcome.match) windows[f.facility_id] = outcome.match;
      } else if (outcome.result === "unchecked") unchecked.push(f);
    }
    return { rows: kept, windows, unchecked, notice: "" };
  };

  const update = () => {
    const filtered = applyAvailability(visible());
    const { rows, windows, unchecked } = filtered;
    const uncheckedNote = unchecked.length
      ? `<p class="help">Not shown because their hours aren't verified or published for this date: ${unchecked.map((f) => esc(f.facility_name)).join(", ")}.</p>`
      : "";
    if (!rows.length) {
      $list.innerHTML = filtered.notice || `<div class="state">${terrier({ size: 44, sleepy: true })}<p>${state.avail === "any" ? "No places match."
        : CALENDAR_FILTERS.has(state.avail) ? `No places match your free time on this date. Try a shorter minimum or another date.` : "No places are open right now."}</p></div>${uncheckedNote}`;
      return;
    }
    const currentDate = campusDateTime().date;
    // The summary's own phrases already say "today", so the "Today:" label shortens them.
    const TODAY_TEXT = { "Closed today": "Closed", "Today's hours not published": "Hours not published" };
    const fact = (label, value, attrs = "") => `<div class="row-fact"><dt>${label}</dt><dd${attrs}>${value}</dd></div>`;
    // One list item per place: labelled facts on the left, the replay count and level on the right.
    // The whole item links to the place page, as before.
    const row = (f) => {
      const h = histories[f.facility_id];
      const { o } = observationAt(h, state.minute);
      const locationHours = isHistorical(f) ? null : hours.locations[f.facility_id];
      const summary = isHistorical(f)
        ? null
        : locationHours ? buildingHoursSummary(locationHours, currentDate) : "Hours unverified";
      const selectedStatus = locationHours ? selectedBuildingStatus(locationHours, currentDate, state.minute) : null;
      const closed = !o && selectedStatus?.status === "closed";
      const facts = [
        fact("Category", `${CATEGORY[f.category] ?? esc(f.category)} ${tag(f)}`),
        isHistorical(f) ? fact("Recorded day", esc(h.day_label)) : "",
        summary ? fact("Today", esc(TODAY_TEXT[summary] ?? summary), ' class="num"') : "",
        selectedStatus && ["open", "closed"].includes(selectedStatus.status)
          ? fact("Status", selectedStatusLabel(selectedStatus), ` class="row-status" data-status="${selectedStatus.status}"`) : "",
        f.category === "dining" && locationHours
          ? fact("Meal service", esc(serviceStatusLabel(serviceAtTime(locationHours, currentDate, state.minute), selectedStatus))) : "",
        windows[f.facility_id]
          ? fact("Fits your free time", `${formatInstant(windows[f.facility_id].start, zone)}–${formatInstant(windows[f.facility_id].end, zone)}`, ' class="num"') : "",
      ].join("");
      return `<li><a class="row" href="#/place/${encodeURIComponent(f.facility_id)}">
        <span class="row-main"><span class="row-name">${esc(f.facility_name)}</span>
          <dl class="row-facts">${facts}</dl>
          <span class="row-more" aria-hidden="true">View details →</span></span>
        <span class="row-side">
          <span class="row-count num">${closed ? "" : fmtCount(o?.occupancy_count)}</span>
          ${level(o?.busyness ?? (closed ? "closed" : "unknown"))}
          ${icon("chevron", 16)}
        </span>
      </a></li>`;
    };
    const places = rows.filter((f) => !isHistorical(f));
    const refs = rows.filter(isHistorical);
    $list.innerHTML = `${filtered.notice}${places.length ? `<ul class="list" aria-label="Places">${places.map(row).join("")}</ul>` : ""}${uncheckedNote}
      ${refs.length ? `<section class="refs"><h2 class="section-title">Historical references</h2>
        <p class="help">Real recordings from outside BU, replayed for comparison. Never suggested as places to go.</p>
        <ul class="list" aria-label="Historical references">${refs.map(row).join("")}</ul></section>` : ""}`;
  };

  $view.querySelector(".search input").addEventListener("input", (e) => { state.query = e.target.value; update(); });
  $view.querySelector(".chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    for (const c of chip.parentElement.querySelectorAll(".chip")) c.setAttribute("aria-pressed", c === chip);
    update();
  });
  $availChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-avail]");
    if (!chip) return;
    state.avail = chip.dataset.avail;
    renderAvailControls();
    update();
  });
  $availPanel.addEventListener("change", (e) => {
    const field = e.target.dataset.free;
    if (field === "date" && e.target.value) freeFilter.date = e.target.value;
    else if (field === "minimum") freeFilter.minimum = Number(e.target.value);
    else return;
    update();
  });
  update();
  return { update };
}

// ---------- screen: one place ----------
async function placeView(id) {
  $view.innerHTML = `${backToPlaces}${loading()}`;
  let f, hist, hours, scheduleLocation;
  try {
    const [facilities, campus, allHours] = await Promise.all([src.listFacilities(), src.getCampus(), src.getHours()]);
    hours = openingHours(campus, id);
    scheduleLocation = allHours.locations[id] ?? null;
    f = facilities.find((x) => x.facility_id === id);
    if (!f) throw new Error("We couldn't find that place.");
    hist = await src.getHistory(id);
  } catch (err) {
    $view.innerHTML = `${backToPlaces}${failure(err)}`;
    return {};
  }
  const historical = isHistorical(f);
  const office = f.category === "office";
  const days = hist.playback_days ?? [];
  let selectedScheduleDate = campusDateTime().date;
  const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  $view.innerHTML = `
    ${backToPlaces}
    <div class="page-head"><h1 class="title">${esc(f.facility_name)}</h1>
      <p class="sub">${CATEGORY[f.category] ?? esc(f.category)} ${tag(f)} ${historical ? `<span class="muted">${office ? "Office room, not BU" : "Not BU"} · never suggested</span>` : ""}</p></div>
    ${hist.notice ? `<p class="banner" role="note">${icon("info", 16)}<span>${esc(hist.notice)}</span></p>` : ""}
    <div class="replay-row">
      ${days.length > 1 ? `<label class="field day-pick"><span class="field-label">Recorded day</span>
        <select id="day">${days.map((d) => `<option value="${esc(d)}"${d === hist.day ? " selected" : ""}>${esc(dayName(d))}</option>`).join("")}</select></label>` : ""}
      ${playbackBar()}
    </div>
    <section class="card schedule-card" id="location-hours" aria-label="Weekly operating hours">
      <div class="card-head">
        <h2>Weekly operating hours</h2>
        <div class="schedule-nav" role="group" aria-label="Navigate operating-hours weeks">
          <button class="icon-btn schedule-nav-btn" type="button" data-week="-7" aria-label="Previous week">‹</button>
          <span id="schedule-week" aria-live="polite"></span>
          <button class="icon-btn schedule-nav-btn" type="button" data-week="7" aria-label="Next week">›</button>
        </div>
      </div>
      <p class="schedule-note" id="schedule-note"></p>
      <ul class="schedule-days" id="schedule-days"></ul>
      <div class="selected-hours" id="selected-hours" aria-live="polite"></div>
    </section>
    ${historical ? "" : `<section class="card find-time" id="find-time" aria-live="polite"></section>`}
    <div class="place-grid">
      <div class="place-now">
        <section class="hero" id="hero" aria-live="polite"></section>
        <section class="suggest" id="suggest"></section>
      </div>
      <section class="card place-chart" id="day-card"></section>
      ${hist.areas.length ? `<section class="card place-areas"><h2>Areas</h2><ul class="list" id="areas"></ul></section>` : ""}
      ${hist.typical_week ? `<section class="card place-week" id="week"></section>` : ""}
    </div>
    <details class="about" id="how"></details>`;
  syncPlayback();
  if (!historical) void findTimeCard($view.querySelector("#find-time"), f, scheduleLocation);

  const $hero = $view.querySelector("#hero");
  const $suggest = $view.querySelector("#suggest");
  const $areas = $view.querySelector("#areas");
  const $dayCard = $view.querySelector("#day-card");
  const $scheduleDays = $view.querySelector("#schedule-days");
  let chart;

  const renderSchedule = () => {
    const today = campusDateTime().date;
    const start = weekStart(selectedScheduleDate);
    $view.querySelector("#schedule-week").textContent = weekRangeLabel(start);
    $scheduleDays.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(start, index);
      const schedule = displaySchedule(scheduleLocation, date, f.category);
      let details;
      const assumedNote = schedule.assumed ? `<span class="hours-note">Assumed: repeats the published weekly hours</span>` : "";
      if (schedule.status === "closed") {
        details = `<span class="hours-closed">Closed${schedule.note ? ` · ${esc(schedule.note)}` : ""}</span>${assumedNote}`;
      } else if (schedule.status === "unverified") {
        details = `<span class="hours-unknown">Hours unverified${schedule.reason ? ` · ${esc(schedule.reason)}` : ""}</span>`;
      } else if (schedule.status === "unpublished") {
        details = `<span class="hours-unknown">Schedule not published for this date.</span>`;
      } else if (schedule.status === "not_applicable") {
        details = `<span class="hours-unknown">Hours unavailable in the provided schedule data.</span>`;
      } else {
        details = schedule.periods.map((period) =>
          `<span class="hours-period"><strong>${esc(f.category === "dining" ? period.label : "Building hours")}:</strong> ${esc(formatPeriod(period))}</span>`,
        ).join("");
        if (schedule.note) details += `<span class="hours-note">${esc(schedule.note)}</span>`;
        details += assumedNote;
      }
      return `<li><button type="button" class="schedule-day${date === today ? " is-today" : ""}${date === selectedScheduleDate ? " is-selected" : ""}" data-schedule-date="${date}"${date === today ? ' aria-current="date"' : ""} aria-pressed="${date === selectedScheduleDate}">
        <span class="schedule-day-name">${esc(dateLabel(date))}${date === today ? " · Today" : ""}</span>
        <span class="schedule-periods${f.category === "dining" ? " schedule-meals" : ""}">${details}</span>
      </button></li>`;
    }).join("");

    const buildingStatus = selectedBuildingStatus(scheduleLocation, selectedScheduleDate, state.minute);
    let statusText = buildingStatus.status === "open" ? "Open at selected time"
      : buildingStatus.status === "closed" ? "Closed at selected time"
      : buildingStatus.status === "unpublished" ? "Building hours not published"
      : "Building hours unverified";
    let mealStatus = "";
    if (!historical && f.category === "dining") {
      const service = serviceAtTime(scheduleLocation, selectedScheduleDate, state.minute);
      mealStatus = `<p><strong>${esc(serviceStatusLabel(service, buildingStatus))}</strong></p>`;
    }
    $view.querySelector("#selected-hours").innerHTML = `<p><strong>${esc(dateLabel(selectedScheduleDate))} · ${esc(fmtTime(state.minute))}</strong></p>
      <p>Building status: <strong>${esc(statusText)}</strong></p>${mealStatus}`;
    const shownSchedule = f.category === "dining" ? scheduleLocation?.serviceHours : scheduleLocation?.buildingHours;
    $view.querySelector("#schedule-note").textContent = shownSchedule?.repeatsWeekly === false
      ? "This schedule applies only to its published dates; other dates are shown as unavailable."
      : "Dates outside the published week repeat its weekly hours and are marked “Assumed” until new hours are published. Special dates always override.";
  };

  $view.querySelector(".schedule-nav").addEventListener("click", (e) => {
    const button = e.target.closest("[data-week]");
    if (!button) return;
    selectedScheduleDate = addDays(selectedScheduleDate, Number(button.dataset.week));
    update();
  });
  $scheduleDays.addEventListener("click", (e) => {
    const button = e.target.closest("[data-schedule-date]");
    if (!button) return;
    selectedScheduleDate = button.dataset.scheduleDate;
    update();
  });

  // Parts that depend on the selected recorded day.
  const renderDay = () => {
    $dayCard.innerHTML = `<div class="card-head"><h2>${esc(hist.day_label)}</h2>
        ${hist.typical ? `<span class="legend"><span class="key-bar"></span>This day <span class="key-line"></span>Typical</span>` : ""}</div>
      <div class="chart" id="chart"></div>
      <details class="table-view"><summary>Show as table</summary>${hourTable(hist)}</details>`;
    chart = barChart($dayCard.querySelector("#chart"), hist);
    const $week = $view.querySelector("#week");
    if ($week) $week.innerHTML = weekHeatmap(hist);
    $view.querySelector("#how").innerHTML = howItWorks(f, hist);
  };

  const update = () => {
    const { o, why } = observationAt(hist, state.minute);
    const buildingStatus = historical ? null : selectedBuildingStatus(scheduleLocation, selectedScheduleDate, state.minute);
    const closedBySchedule = !o && buildingStatus?.status === "closed";
    const closedByDemoHours = !o && !closedBySchedule && (buildingStatus?.status !== "open"
      && buildingStatus?.status !== "unpublished" && buildingStatus?.status !== "unverified"
      && closedAt(hours, state.minute));
    const closed = closedBySchedule || closedByDemoHours;
    const meta = closedBySchedule ? "Closed at selected time"
      : closedByDemoHours ? closedText(closedAt(hours, state.minute), hours)
      : o
      ? historical
        ? `Replay ${fmtTime(state.minute)} · observed ${fmtTime(obsMinute(o))} (${offsetText(o)})`
        : `At ${fmtTime(state.minute)}`
      : why === "before" ? `No data yet: recording starts at ${fmtHHMM(hist.observations[0]?.observed_at.slice(11, 19) ?? hist.coverage_start)}`
      : why === "gap" ? `No data: nothing recorded in the ${hist.max_hold_minutes} min before ${fmtTime(state.minute)}`
      : "Recording has ended for this day";
    $hero.innerHTML = `
      <div class="hero-count">${closed ? `<span class="big">Closed</span>`
        : `<span class="big num">${fmtCount(o?.occupancy_count)}</span><span class="unit">${o ? "people" : ""}</span>`}</div>
      ${closed ? "" : level(o?.busyness ?? "unknown")}
      ${hist.busyness_label && o ? `<p class="meta">${esc(hist.busyness_label)}</p>` : ""}
      <p class="meta">${meta}</p>`;

    const q = quieterTime(hist, state.minute);
    const word = historical ? "Historically quieter" : q.usual ? "Usually quieter" : "Quieter later that day";
    $suggest.innerHTML = `<span class="paw">${paw(18)}</span><div>${
      q.kind === "later"
        ? `<strong>${word} at ${fmtHour(q.hour)}</strong><span>about ${fmtCount(q.value)} people · ${esc(q.basis)}${historical ? " · a past pattern, not a forecast" : ""}</span>`
        : q.kind === "now"
          ? `<strong>${historical ? "Historically no quieter later" : "This is the quietest it gets for the rest of the day"}</strong><span>${esc(q.basis)}</span>`
          : `<strong>No well-recorded hours left${historical ? " to compare" : " today"}</strong><span>${esc(q.basis)}</span>`
    }</div>`;

    chart.mark(Math.floor(state.minute / 60));
    renderSchedule();

    if ($areas) {
      $areas.innerHTML = hist.areas.map((a) => {
        const ao = latestAt(a.observations, state.minute, hist.coverage_end);
        return `<li class="row"><span class="row-main"><span class="row-name">${esc(a.name)}</span></span>
          <span class="row-side"><span class="row-count num">${closed ? "" : fmtCount(ao?.occupancy_count)}</span>${level(ao?.busyness ?? (closed ? "closed" : "unknown"))}</span></li>`;
      }).join("");
    }
  };

  $view.querySelector("#day")?.addEventListener("change", async (e) => {
    const picked = e.target.value;
    e.target.disabled = true;
    try {
      hist = await src.getHistory(id, picked);
      renderDay();
      update();
    } catch (err) {
      $dayCard.innerHTML = failure(err);
    } finally {
      e.target.disabled = false;
    }
  });

  renderDay();
  update();
  return { update, resize: () => { chart.draw(); chart.mark(Math.floor(state.minute / 60)); } };
}

function howItWorks(f, hist) {
  const capacity = hist.capacity
    ? `${hist.capacity.toLocaleString()} (illustrative, not official)`
    : "Unknown. BU-sy doesn't guess it from the highest count, so it never shows “% full”.";
  return `<summary>How this works</summary>
    <dl>
      <dt>Busyness</dt><dd>${esc(hist.busyness_basis)}</dd>
      ${hist.typical_label ? `<dt>Typical</dt><dd>${esc(hist.typical_label)}</dd>` : ""}
      <dt>Capacity</dt><dd>${capacity}</dd>
      <dt>Time</dt><dd>${esc(hist.time_note)}. ${hist.day_label}: recorded ${fmtHHMM(hist.coverage_start)}–${fmtHHMM(hist.coverage_end)}.</dd>
      ${hist.max_hold_minutes ? `<dt>Gaps</dt><dd>A count stands for at most ${hist.max_hold_minutes} minutes and never past midnight; longer gaps show as no data, not zero.</dd>` : ""}
      <dt>Source</dt><dd>${esc(f.source)}</dd>
      ${hist.measurement_note ? `<dt>Counts</dt><dd>${esc(hist.measurement_note)}</dd>` : ""}
      ${f.measurement_method === "estimated" ? `<dt>Counts</dt><dd>Estimated by doorway sensors at each entry or exit, so a count can stay the same for a while when nobody moves.</dd>` : ""}
    </dl>
    <p class="fineprint"><a href="#/about">About this data</a></p>`;
}

/** Typical weekday x hour, as a single-hue grid. Blank = too little recorded time. */
function weekHeatmap(hist) {
  const week = hist.typical_week;
  const ref = hist.busyness_reference || Math.max(1, ...week.flatMap((d) => d.hours.map((h) => h.occupancy ?? 0)));
  const step = (v) => (v == null ? "none" : Math.min(4, Math.floor((v / ref) * 5)));
  const today = new Date(`${hist.day}T12:00:00Z`).getUTCDay();
  const weekdayOfDay = (today + 6) % 7;       // Monday = 0, same as the data
  const hours = week[0].hours.map((h) => h.hour);
  const short = (label) => label.slice(0, 3);
  return `<div class="card-head"><h2>Typical traffic by weekday and hour</h2>
      <span class="legend">Fewer <span class="heat-key">${[0, 1, 2, 3, 4].map((n) => `<i data-step="${n}"></i>`).join("")}</span> more · <i class="heat-none-key"></i> no data</span></div>
    <div class="heat" role="img" aria-label="Typical number of people by weekday and hour. Details in the table below.">
      <span></span>${hours.map((h) => `<span class="heat-hour">${h % 6 === 0 ? fmtHour(h).replace(" ", "") : ""}</span>`).join("")}
      ${week.map((d) => `<span class="heat-day${d.weekday === weekdayOfDay ? " is-today" : ""}">${short(d.label)}</span>
        ${d.hours.map((h) => `<i data-step="${step(h.occupancy)}" title="${esc(d.label)} ${fmtHour(h.hour)}: ${h.occupancy == null ? "not enough data" : `about ${fmtCount(h.occupancy)} people`} (${h.recorded_hours} h recorded)"></i>`).join("")}`).join("")}
    </div>
    <p class="help">Time-weighted over ${week.reduce((n, d) => n + d.days, 0)} recorded days, semesters and breaks together.
      Blank cells had too little recorded time. A past pattern, not a forecast.</p>
    <details class="table-view"><summary>Show as table</summary>
      <div class="table-scroll"><table><thead><tr><th>Hour</th>${week.map((d) => `<th>${short(d.label)}</th>`).join("")}</tr></thead><tbody>
      ${hours.map((h, i) => `<tr><td>${fmtHour(h)}</td>${week.map((d) => `<td class="num">${fmtCount(d.hours[i].occupancy)}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div></details>`;
}

function hourTable(hist) {
  const typical = new Map((hist.typical ?? []).map((b) => [b.hour, b]));
  return `<table><thead><tr><th>Hour</th><th>Avg people</th>${hist.typical ? "<th>Typical</th>" : ""}<th>Level</th></tr></thead><tbody>
    ${hist.hourly.map((b) => `<tr><td>${fmtHour(b.hour)}</td><td class="num">${fmtCount(b.occupancy)}</td>
      ${hist.typical ? `<td class="num">${fmtCount(typical.get(b.hour)?.occupancy)}</td>` : ""}<td>${LEVEL[b.busyness]}</td></tr>`).join("")}
  </tbody></table>`;
}

/** Hourly bars (time-weighted means), the playback hour in red, optional typical line. */
function barChart(el, hist) {
  const H = 168, M = { t: 10, r: 6, b: 24, l: 34 };
  const bars = hist.hourly;
  const typical = hist.typical;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;

  const values = [...bars, ...(typical ?? [])].map((b) => b.occupancy ?? 0);
  const rawMax = Math.max(1, ...values);
  const mag = 10 ** Math.floor(Math.log10(rawMax / 3));
  const step = [1, 2, 2.5, 3, 4, 5, 10].map((k) => k * mag).find((s) => s * 3 >= rawMax);
  const yMax = step * 3;

  function draw() {
    const W = Math.max(280, el.clientWidth);
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    const slot = pw / bars.length;
    const bw = Math.max(4, slot - 3);
    const x = (i) => M.l + i * slot + (slot - bw) / 2;
    const y = (v) => M.t + ph - (v / yMax) * ph;
    const r = Math.min(4, bw / 2);

    const grid = [0, 1, 2, 3].map((k) => {
      const v = step * k;
      return `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtCount(v)}</text>`;
    }).join("");
    const rects = bars.map((b, i) => {
      if (b.occupancy == null || b.occupancy <= 0) return "";
      const top = y(b.occupancy), bottom = y(0), h = bottom - top;
      const rr = Math.min(r, h);
      return `<path class="bar" data-hour="${b.hour}" d="M${x(i)},${bottom}V${top + rr}q0,-${rr} ${rr},-${rr}h${bw - 2 * rr}q${rr},0 ${rr},${rr}V${bottom}Z"/>`;
    }).join("");
    const labels = bars.map((b, i) => (b.hour % 3 === 0
      ? `<text class="axis" x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${fmtHour(b.hour)}</text>` : "")).join("");
    const line = typical
      ? `<polyline class="typical" points="${typical.filter((b) => b.occupancy != null)
          .map((b) => `${x(b.hour - bars[0].hour) + bw / 2},${y(b.occupancy)}`).join(" ")}"/>`
      : "";
    const peak = bars.reduce((a, b) => ((b.occupancy ?? -1) > (a.occupancy ?? -1) ? b : a));
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Average people per hour on ${esc(hist.day_label)}. Busiest at ${fmtHour(peak.hour)} with about ${fmtCount(peak.occupancy)}.">${grid}${rects}${line}${labels}</svg>`;
    el.append(tip);

    const svg = el.querySelector("svg");
    svg.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.floor((e.clientX - box.left - M.l) / slot);
      const b = bars[i];
      if (!b) { tip.hidden = true; return; }
      const t = typical?.find((k) => k.hour === b.hour);
      tip.innerHTML = `<strong>${fmtHour(b.hour)}–${fmtHour(b.hour + 1)}</strong>${fmtCount(b.occupancy)} people · ${LEVEL[b.busyness]}${t ? `<br>Typical ${fmtCount(t.occupancy)}` : ""}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(x(i) + bw / 2, 60), W - 60)}px`;
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  draw();
  return {
    draw,
    mark(hour) {
      for (const p of el.querySelectorAll(".bar")) p.classList.toggle("is-now", Number(p.dataset.hour) === hour);
    },
  };
}

// ---------- screen: about ----------
function aboutView() {
  const doi = `<a href="https://doi.org/10.5281/zenodo.996587" target="_blank" rel="noopener">doi:10.5281/zenodo.996587</a>`;
  const item = (title, body) => `<li class="row about-item"><div class="row-main"><h2 class="row-name">${title}</h2>${body}</div></li>`;
  $view.innerHTML = `
    <div class="page-head"><h1 class="title">About this data</h1>
      <p class="tagline">What's sample, what's real, and how suggestions are worked out.</p></div>
    <ul class="list prose">
      ${item("Sample places", `<p>FitRec, dining and Mugar use synthetic counts from one made-up Monday. They are not BU measurements, and capacities are illustrative.</p>`)}
      ${item("One real room", `<p>The Clemente Room is an office conference room from the public COD dataset (Liu et al., 2017, ${doi}). It shows the app on real sensor data, is never suggested as a place to go, and keeps its unverified source timezone.</p>`)}
      ${item("A real campus gym (not BU)", `<p>Campus Gym — Historical Reference replays <a href="https://www.kaggle.com/datasets/nsrose7224/crowdedness-at-the-campus-gym" target="_blank" rel="noopener">Crowdedness at the Campus Gym</a> (Nick Rose, Kaggle, 2015–2017): head counts about every 10 minutes at an unnamed university gym. It is not BU FitRec, not live, and never suggested. Collection method and capacity aren't documented, so busyness is relative to the gym's own history. Times keep the source's UTC offset. A count stands for at most 30 minutes; longer gaps are no data. Contains information from that dataset, available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">Open Database License</a>; the derived files in BU-sy are shared under the same license.</p>`)}
      ${item("How a place fits", `<p>The walk there, at least your minimum time, the walk to your next stop and your buffer must all fit your free time, and the place must be open. With no starting point, BU-sy only lists places that could work and says travel isn't checked.</p>`)}
      ${item("Walks, hours, amenities", `<p>Illustrative samples, not routed or verified. A missing walking time is unknown, never zero. Places with unknown hours are listed separately, never as confirmed.</p>`)}
      ${item("Busyness", `<p>A count compared with capacity (sample places) or the room's usual high (Clemente): under 40% quiet, under 75% moderate, above that busy. These are demo thresholds. Suggestions use the count at the selected demo time, which is not a forecast for when you arrive, and a building count doesn't show free seats or equipment.</p>`)}
      ${item("Hourly averages", `<p>Time-weighted: each count holds until the next one, and never past the end of the recorded day.</p>`)}
      ${item("Your settings", `<p>Preferences and your last chosen starting point stay in this browser. Reset them under Preferences. BU-sy never detects your location.</p>`)}
      ${item("Clubs", `<p>Sample clubs are labeled and aren't real BU organizations. Signing up stores your name, school email and year (plus anything optional you add) for that club's organizer only; on the built-in demo files that stays in this browser. Organizer access is a device token, not a login. Busyness hints for meeting times are estimates from the simulated campus data.</p>`)}
    </ul>
    <p class="fineprint">BU-sy is an independent student prototype, not affiliated with Boston University. A real version would need verified hours, real walking routes and an authorized, aggregate campus count.</p>`;
  return {};
}

// The planner reads and sets the same demo clock as playback.
const clock = {
  get minute() { return state.minute; },
  set(minute) { state.minute = minute; setPlaying(false); },
};

// ---------- router ----------
async function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [section, id, sub] = hash.split("/");
  const current = section === "" ? "plan" : section === "place" ? "places"
    : ["club", "my-clubs"].includes(section) ? "clubs" : section;
  const clubId = id ? decodeURIComponent(id) : null;
  for (const a of document.querySelectorAll("[data-section]")) a.toggleAttribute("aria-current", a.dataset.section === current);
  view = null;
  window.scrollTo(0, 0);
  const next =
    section === "place" && id ? placeView(decodeURIComponent(id))
    : section === "clubs" && id === "new" ? clubFormView($view)
    : section === "clubs" ? clubsView($view)
    : section === "club" && clubId && sub === "join" ? joinView($view, clubId)
    : section === "club" && clubId && sub === "edit" ? clubFormView($view, clubId)
    : section === "club" && clubId && sub === "manage" ? manageView($view, clubId)
    : section === "club" && clubId ? clubView($view, clubId)
    : section === "my-clubs" ? myClubsView($view)
    : section === "calendar" ? calendarView($view)
    : section === "about" ? aboutView()
    : section === "places" ? placesView()
    : planView($view, clock);
  const mounted = await next;
  if (location.hash.replace(/^#\/?/, "") === hash) view = mounted;
}

// ---------- theme ----------
const root = document.documentElement;
try {
  const saved = localStorage.getItem("busy.theme");
  if (saved) root.dataset.theme = saved;
} catch { /* storage blocked: follow the system theme */ }
document.getElementById("theme").addEventListener("click", () => {
  const dark = (root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("busy.theme", root.dataset.theme); } catch { /* ignore */ }
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => view?.resize?.(), 150);
});
document.querySelector(".brand-mark").innerHTML = terrier({ size: 30 });

// Always say where the data came from. Both sources carry the same demo labels;
// neither is live. If an API was asked for but can't be reached, say so.
src.getMode().then((mode) => {
  document.getElementById("source-mode").textContent = mode === "api"
    ? `Data source: BU-sy API${src.REQUESTED_API ? ` at ${src.REQUESTED_API}` : ""}`
    : "Data source: built-in demo files, no server";
  if (mode === "static" && src.REQUESTED_API) {
    const $notice = document.getElementById("notice");
    $notice.textContent = `Couldn't reach the API at ${src.REQUESTED_API}. Showing the built-in demo files instead: `
      + "the same sample data, but clubs and sign-ups are saved on this device only.";
    $notice.hidden = false;
  }
});
window.addEventListener("hashchange", route);
route();
