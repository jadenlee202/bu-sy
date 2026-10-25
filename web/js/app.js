import { clockSec, fmtHHMM, fmtHour, fmtShort, fmtTime, latestAt, obsMinute, obsOffset } from "./clock.js";
import { icon, paw, terrier } from "./icons.js";
import { campusImage, getImages } from "./image.js";
import { planView } from "./plan.js";
import { hoursText, openSegments, periodAt } from "./recommend.js";
import {
  addDays, campusDateTime, dateLabel, daySchedule, displaySchedule, formatPeriod,
  selectedBuildingStatus, serviceAtTime, serviceStatusLabel, weekRangeLabel, weekStart,
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
const TICK_MS = 300;

const CATEGORY = { fitness: "Fitness", dining: "Dining", library: "Library", office: "Office" };
const FILTERS = [["all", "All"], ["fitness", "Fitness"], ["dining", "Dining"], ["library", "Library"], ["historical", "Historical"]];

const state = { minute: FIRST_VIEW, playing: false, timer: null, filter: "all", query: "" };
const $view = document.getElementById("view");
let view = null; // the mounted screen: { update?(), resize?() }

// ---------- helpers ----------
const isHistorical = (f) => f.data_mode === "historical_playback";
const tag = (f) => (isHistorical(f)
  ? `<span class="tag tag-real" title="Real recorded data from elsewhere, replayed. Not live, not BU.">Historical</span>`
  : `<span class="tag tag-sim" title="${esc(f.simulation?.label ?? "Simulated")}. Not a BU measurement.">Simulated</span>`);
const backToPlaces = `<a class="back" href="#/">${icon("back", 16)} All places</a>`;
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
  return p ? { segs: openSegments(p), text: hoursText(p), basis: p.hours_basis } : null;
}

/**
 * Verified BU building hours (web/data/hours.json) for the replayed day, not today: the busyness
 * values are a sample Monday, so open/closed must describe that same date. null = no entry.
 */
function replayHours(location, date, minute) {
  if (!location) return null;
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const s = daySchedule(location, date);
  const text = s.status === "scheduled" ? `${day}: ${s.periods.map(formatPeriod).join(" · ")}`
    : s.status === "closed" ? `Closed ${day}`
    : s.status === "unpublished" ? `${day} hours not published` : "Hours unverified";
  return { text, status: selectedBuildingStatus(location, date, minute).status };
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
      <div class="pb-row"><span class="pb-time num"></span><span class="pb-status"></span></div>
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
    el.textContent = state.playing ? "Replay running" : ended ? "End of replay" : "Replay paused";
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
    }, TICK_MS);
  }
  syncPlayback();
}

document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-pb]")?.dataset.pb;
  if (action === "toggle") setPlaying(!state.playing);
  if (action === "reset") { state.minute = DAY_START; setPlaying(false); }
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
      <p class="tagline">Campus places on a simulated demo Monday, plus recorded references. <a href="#/sources">Sources &amp; Simulation</a></p></div>
    ${playbackBar()}
    <label class="search">${icon("search")}<input type="search" placeholder="Search places" aria-label="Search places" value="${esc(state.query)}"></label>
    <div class="chips" role="group" aria-label="Filter places">
      ${FILTERS.map(([id, label]) => `<button class="chip" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join("")}
    </div>
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

  const visible = () => {
    const q = state.query.trim().toLowerCase();
    return facilities.filter((f) =>
      (state.filter === "all" || (state.filter === "historical" ? isHistorical(f) : f.category === state.filter)) &&
      (!q || `${f.facility_name} ${CATEGORY[f.category] ?? ""}`.toLowerCase().includes(q)));
  };

  const update = () => {
    const rows = visible();
    if (!rows.length) {
      $list.innerHTML = `<div class="state">${terrier({ size: 44, sleepy: true })}<p>No places match.</p></div>`;
      return;
    }
    const row = (f) => {
      const h = histories[f.facility_id];
      const { o } = observationAt(h, state.minute);
      const vh = isHistorical(f) ? null : replayHours(hours.locations[f.facility_id], h.day, state.minute);
      // Verified hours for the replayed day win over a simulated count; without them, sample hours
      // may still say closed when there is no count. Historical references are never called closed.
      const closed = vh?.status === "closed"
        || (!o && !["open", "closed"].includes(vh?.status) && !!closedAt(openingHours(campus, f.facility_id), state.minute));
      const hoursSummary = vh ? `<span class="row-hours">${esc(vh.text)}</span>` : "";
      const statusText = vh && ["open", "closed"].includes(vh.status)
        ? `<span class="row-hours-status" data-status="${vh.status}">${vh.status === "open" ? "Open" : "Closed"} at ${esc(fmtTime(state.minute))}</span>`
        : "";
      return `<li><a class="row" href="#/place/${encodeURIComponent(f.facility_id)}">
        <span class="row-main"><span class="row-name">${esc(f.facility_name)}</span>
          <span class="row-sub">${CATEGORY[f.category] ?? esc(f.category)} ${tag(f)}${isHistorical(f) ? ` <span>${esc(h.day_label)}</span>` : ""}</span>
          ${hoursSummary}${statusText}</span>
        <span class="row-count num">${closed ? "" : fmtCount(o?.occupancy_count)}</span>
        ${level(closed ? "closed" : o?.busyness ?? "unknown")}
        ${icon("chevron", 16)}
      </a></li>`;
    };
    const places = rows.filter((f) => !isHistorical(f));
    const refs = rows.filter(isHistorical);
    $list.innerHTML = `${places.length ? `<ul class="list list-card">${places.map(row).join("")}</ul>` : ""}
      ${refs.length ? `<section class="refs"><h2 class="section-title">Historical references</h2>
        <p class="help">Real recordings from outside BU, replayed for comparison. Never suggested as places to go.</p>
        <ul class="list list-card">${refs.map(row).join("")}</ul></section>` : ""}`;
  };

  $view.querySelector(".search input").addEventListener("input", (e) => { state.query = e.target.value; update(); });
  $view.querySelector(".chips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    for (const c of $view.querySelectorAll(".chip")) c.setAttribute("aria-pressed", c === chip);
    update();
  });
  update();
  return { update };
}

// ---------- screen: one place ----------
async function placeView(id) {
  $view.innerHTML = `${backToPlaces}${loading()}`;
  let f, hist, hours, campus, images, scheduleLocation;
  try {
    let facilities, allHours;
    [facilities, campus, allHours, images] = await Promise.all([src.listFacilities(), src.getCampus(), src.getHours(), getImages()]);
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
  // A campus photo for real BU places only. Historical references are NOT BU,
  // so they never get a BU building photo. Keyed by the place's location_id.
  const locId = campus.places.find((p) => p.facility_id === id)?.location_id;
  const photo = !historical && locId ? (images?.images?.[locId] ?? null) : null;
  const showPhoto = !historical && locId;
  const office = f.category === "office";
  const days = hist.playback_days ?? [];
  let selectedScheduleDate = campusDateTime().date;
  const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  $view.innerHTML = `
    ${backToPlaces}
    ${showPhoto ? `<div class="place-photo">${campusImage(photo, f.facility_name, "21 / 9")}</div>` : ""}
    <div class="page-head"><h1 class="title">${esc(f.facility_name)}</h1>
      <p class="sub">${CATEGORY[f.category] ?? esc(f.category)} ${tag(f)} ${historical ? `<span class="muted">${office ? "Office room, not BU" : "Not BU"} · never suggested</span>`
        : f.simulation ? `<span class="muted">${esc(f.simulation.label)}</span> <a class="sub-link" href="#/sources/${encodeURIComponent(f.simulation.id)}">How it's simulated</a>` : ""}</p></div>
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
    <div class="place-grid">
      <div class="place-now">
        <section class="hero" id="hero" aria-live="polite"></section>
        <section class="suggest" id="suggest"></section>
      </div>
      <section class="card place-chart" id="day-card"></section>
      ${hist.typical_week ? `<section class="card place-week" id="week"></section>` : ""}
    </div>
    <details class="about" id="how"></details>`;
  syncPlayback();

  const $hero = $view.querySelector("#hero");
  const $suggest = $view.querySelector("#suggest");
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
      if (schedule.status === "closed") {
        details = `<span class="hours-closed">Closed${schedule.note ? ` · ${esc(schedule.note)}` : ""}</span>`;
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
    $view.querySelector("#schedule-note").textContent =
      "Schedules are date-specific; dates without a published schedule are shown as unavailable.";
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
    // Open/closed for the replayed day (the sample Monday), like the Places list. The weekly card
    // below keeps its own selected date.
    const replay = historical ? null : selectedBuildingStatus(scheduleLocation, hist.day, state.minute);
    const closedBySchedule = replay?.status === "closed";
    const closedByDemoHours = !o && !closedBySchedule && replay?.status !== "open" && closedAt(hours, state.minute);
    const closed = closedBySchedule || !!closedByDemoHours;
    const period = periodAt(f.simulation, state.minute);   // dataset-derived, modeled or not simulated
    const meta = closedBySchedule ? `Closed at ${fmtTime(state.minute)} · BU hours for ${dateLabel(hist.day)}`
      : closedByDemoHours ? closedText(closedAt(hours, state.minute), hours)
      : o
      ? historical
        ? `Replay ${fmtTime(state.minute)} · observed ${fmtTime(obsMinute(o))} (${offsetText(o)})`
        : `At ${fmtTime(state.minute)}${period ? ` · ${period.label}` : ""}`
      : f.simulation
      ? period?.basis === "unavailable" ? period.label : "No simulated value at this time"
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
      <dt>Source</dt><dd>${esc(f.source)}${f.simulation ? ` · <a href="#/sources/${encodeURIComponent(f.simulation.id)}">Sources &amp; Simulation</a>` : ""}</dd>
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

// ---------- screen: events ----------
const dayLabel = (iso) => {
  const today = src.campusNow().date;
  const d = new Date(`${iso}T12:00:00Z`);
  const diff = Math.round((d - new Date(`${today}T12:00:00Z`)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

async function eventsView() {
  const mode = await src.getMode();
  $view.innerHTML = `
    <div class="title-row"><h1 class="title">Meetups</h1>
      <a class="btn btn-primary" href="#/events/new">${icon("plus", 16)} New</a></div>
    <p class="hint">Unofficial and student-run, not FitRec programming. ${mode === "static"
      ? "<strong>Demo mode:</strong> events are saved in this browser only. Nobody else can see or join them."
      : "Shared with everyone using this server: anyone can see each event's time and place."}</p>
    <div id="events" aria-live="polite">${loading()}</div>`;
  const $list = $view.querySelector("#events");
  let open = null; // id of the event whose join form is showing

  async function render() {
    let events;
    try {
      events = await src.communityEvents.list();
    } catch (err) {
      $list.innerHTML = failure(err);
      return;
    }
    if (!events.length) {
      $list.innerHTML = `<div class="state">${terrier({ size: 52, sleepy: true })}<p>Nothing planned yet.</p>
        <a class="btn btn-primary" href="#/events/new">Start a run</a></div>`;
      return;
    }
    let lastDay = "";
    $list.innerHTML = `<ul class="events">${events.map((e) => {
      const header = e.date !== lastDay ? `<li class="day">${dayLabel(e.date)}</li>` : "";
      lastDay = e.date;
      const full = e.spots && e.going_count >= e.spots;
      const action = e.is_host ? `<span class="pill">Hosting</span>`
        : e.joined ? `<span class="going"><button class="link" data-act="leave" data-id="${esc(e.id)}">Leave</button><span class="pill pill-going">${icon("check", 14)} Going</span></span>`
        : full ? `<span class="pill">Full</span>`
        : `<button class="btn" data-act="open" data-id="${esc(e.id)}">Join</button>`;
      return `${header}<li class="event">
        <div class="event-time num">${fmtHHMM(e.start)} – ${fmtHHMM(e.end)}</div>
        <div class="event-title">${esc(e.title)}${e.invite_only ? ` <span class="lock" title="A code is needed to join. The time and place are visible to everyone.">${icon("lock", 13)} Invite only</span>` : ""}</div>
        <div class="event-place">${esc(e.place)}${e.note ? ` · ${esc(e.note)}` : ""}</div>
        <div class="event-foot"><span class="muted">${e.going_count}${e.spots ? `/${e.spots}` : ""} going · ${esc(e.host)}</span>${action}</div>
        ${open === e.id ? joinForm(e) : ""}
        ${e.is_host ? `<div class="host-box">${e.invite_code ? `<span>Invite code <code>${esc(e.invite_code)}</code></span>
          <button class="link" data-act="copy" data-code="${esc(e.invite_code)}">Copy</button>` : "<span>Open to anyone</span>"}
          <button class="link danger" data-act="cancel" data-id="${esc(e.id)}">Cancel event</button></div>` : ""}
      </li>`;
    }).join("")}</ul>`;
    $list.querySelector(".join-form input")?.focus();
  }

  const joinForm = (e) => `<form class="join-form" data-id="${esc(e.id)}">
    <input name="name" required maxlength="${src.LIMITS.name}" placeholder="Your first name or nickname" aria-label="Your name" value="${esc(src.savedName())}">
    ${e.invite_only ? `<input name="code" required maxlength="${src.LIMITS.code}" placeholder="Invite code" aria-label="Invite code" autocapitalize="characters">` : ""}
    <button class="btn btn-primary">Join</button>
    <p class="form-error" role="alert"></p>
  </form>`;

  $list.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === "open") { open = id; await render(); }
      if (act === "leave") { await src.communityEvents.leave(id); await render(); }
      if (act === "cancel" && confirm("Cancel this event for everyone?")) { await src.communityEvents.cancel(id); await render(); }
      if (act === "copy") {
        await navigator.clipboard?.writeText(btn.dataset.code);
        btn.textContent = "Copied";
      }
    } catch (err) {
      alert(err.message);
    }
  });
  $list.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = new FormData(form);
    const name = data.get("name").trim();
    try {
      await src.communityEvents.join(form.dataset.id, { name, code: data.get("code") });
      src.saveName(name);
      open = null;
      await render();
    } catch (err) {
      form.querySelector(".form-error").textContent = err.message;
    }
  });
  await render();
  return {};
}

async function newEventView() {
  $view.innerHTML = `<a class="back" href="#/events">${icon("back", 16)} Meetups</a>${loading()}`;
  let places;
  try {
    const facilities = await src.listFacilities();
    places = [...facilities.filter((f) => f.campus_eligible).map((f) => f.facility_name), "Somewhere else on campus"];
  } catch (err) {
    $view.innerHTML = `<a class="back" href="#/events">${icon("back", 16)} Meetups</a>${failure(err)}`;
    return {};
  }
  const mode = await src.getMode();
  const now = src.campusNow();
  const nextHour = Math.min(22, Number(now.time.slice(0, 2)) + 1);
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.parse(`${now.date}T12:00:00Z`) + src.LIMITS.daysAhead * 864e5).toISOString().slice(0, 10);
  const L = src.LIMITS;

  $view.innerHTML = `
    <a class="back" href="#/events">${icon("back", 16)} Meetups</a>
    <h1 class="title">New meetup</h1>
    <p class="hint">Unofficial: you host it and nothing is booked with FitRec. ${mode === "static"
      ? "<strong>Demo mode:</strong> this event is saved in this browser only. Nobody else will see it."
      : "Everyone using this server will see it."}</p>
    <form class="form panel" id="new-event" novalidate>
      <label>What<input name="title" required maxlength="${L.title}" placeholder="Basketball run"></label>
      <label>Where<select name="place" required>
        ${places.map((p) => `<option>${esc(p)}</option>`).join("")}
      </select></label>
      <label><span>Details <span class="opt">optional</span></span><input name="note" maxlength="${L.note}" placeholder="Floor 2 courts, bring a ball"></label>
      <div class="form-row">
        <label>Date<input name="date" type="date" required min="${now.date}" max="${lastDay}" value="${now.date}"></label>
        <label>Start<input name="start" type="time" required value="${pad(nextHour)}:00"></label>
        <label>End<input name="end" type="time" required value="${pad(nextHour + 1)}:00"></label>
      </div>
      <label><span>Spots <span class="opt">optional</span></span><input name="spots" type="number" min="${L.minSpots}" max="${L.maxAttendees}" inputmode="numeric" placeholder="10"></label>
      <fieldset class="segmented"><legend>Who can join</legend>
        <label><input type="radio" name="visibility" value="open" checked><span>Anyone</span></label>
        <label><input type="radio" name="visibility" value="invite"><span>${icon("lock", 14)} Invite only</span></label>
      </fieldset>
      <p class="help">Invite only means people need a code to join. Everyone can still see the time and place,
        so don't use it for anything private.${mode === "static" ? " In demo mode the code only works in this browser." : ""}</p>
      <label>Your name<input name="host" required maxlength="${L.host}" placeholder="First name or nickname" value="${esc(src.savedName())}"></label>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block">Create event</button>
    </form>`;

  const form = $view.querySelector("#new-event");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const d = new FormData(form);
    const $err = form.querySelector(".form-error");
    const get = (k) => String(d.get(k) ?? "").trim();
    const data = {
      title: get("title"), place: get("place"), note: get("note"), date: get("date"),
      start: get("start"), end: get("end"), host: get("host"), spots: get("spots") ? Number(get("spots")) : null,
      invite_only: d.get("visibility") === "invite",
    };
    const problem = src.eventProblem(data);  // same rules as the server
    if (problem) { $err.textContent = problem; return; }
    try {
      const e = await src.communityEvents.create(data);
      src.saveName(get("host"));
      if (!e.invite_code) { location.hash = "#/events"; return; }
      $view.innerHTML = `<div class="state">${terrier({ size: 52 })}
        <h1 class="title">You're hosting</h1>
        <p>${mode === "static"
          ? "Demo mode: this code only works in this browser, because the event isn't shared."
          : "Share this code with the people you invite. Anyone who has it can join."}</p>
        <p class="code-big">${esc(e.invite_code)}</p>
        <a class="btn btn-primary" href="#/events">Done</a></div>`;
    } catch (err) {
      $err.textContent = err.message;
    }
  });
  return {};
}

// ---------- screen: about ----------
function aboutView() {
  const doi = `<a href="https://doi.org/10.5281/zenodo.996587" target="_blank" rel="noopener">doi:10.5281/zenodo.996587</a>`;
  const item = (title, body) => `<section class="about-item"><h2>${title}</h2>${body}</section>`;
  $view.innerHTML = `
    <div class="page-head"><h1 class="title">About this data</h1>
      <p class="tagline">What's sample, what's real, and how suggestions are worked out.</p></div>
    <div class="about-grid prose">
      ${item("Simulated campus places", `<p>Busyness at FitRec, the dining halls and Mugar is simulated on one demo Monday: FitRec follows a real campus gym elsewhere; Mugar follows people counts in a small library room in Singapore; dining halls follow canteen purchases in Switzerland at lunch, with breakfast and dinner modeled. All of it is rescaled. None of it measures BU. Datasets, mappings and steps: <a href="#/sources">Sources &amp; Simulation</a>.</p>`)}
      ${item("One real room", `<p>The Clemente Room is an office conference room from the public COD dataset (Liu et al., 2017, ${doi}). It shows the app on real sensor data, is never suggested as a place to go, and keeps its unverified source timezone.</p>`)}
      ${item("A real campus gym (not BU)", `<p>Campus Gym — Historical Reference replays head counts taken about every 10 minutes at an unnamed university gym, 2015–2017, as recorded. It is not BU FitRec, not live, and never suggested. Capacity and counting method aren't documented, so busyness is relative to the gym's own history; a count stands for at most 30 minutes. Citation and license (ODbL): <a href="#/sources">Sources &amp; Simulation</a>.</p>`)}
      ${item("How a place fits", `<p>The walk there, at least your minimum time, the walk to your next stop and your buffer must all fit your free time, and the place must be open. With no starting point, BU-sy only lists places that could work and says travel isn't checked.</p>`)}
      ${item("Walks, hours, amenities", `<p>Illustrative samples, not routed or verified. A missing walking time is unknown, never zero. Places with unknown hours are listed separately, never as confirmed.</p>`)}
      ${item("Busyness", `<p>A count compared with illustrative capacity (campus places) or a place's usual high (historical references): under 40% quiet, under 75% moderate, above that busy. These are demo thresholds. Suggestions use the count at the selected demo time, which is not a forecast for when you arrive, and a building count doesn't show free seats or equipment.</p>`)}
      ${item("Hourly averages", `<p>Time-weighted: each count holds until the next one, and never past the end of the recorded day.</p>`)}
      ${item("Your settings", `<p>Preferences and your last chosen starting point stay in this browser. Reset them under Preferences. BU-sy never detects your location.</p>`)}
      ${item("Meetups", `<p>Created by students and unofficial. We store only a nickname and a random device ID.</p>`)}
    </div>
    <p class="fineprint">BU-sy is an independent student prototype, not affiliated with Boston University. A real version would need verified hours, real walking routes and an authorized, aggregate campus count.</p>`;
  return {};
}

// ---------- screen: sources & simulation ----------
async function sourcesView(openId) {
  $view.innerHTML = `<div class="page-head"><h1 class="title">Sources &amp; Simulation</h1></div>${loading()}`;
  let p;
  try {
    p = await src.getSources();
  } catch (err) {
    $view.innerHTML = `<div class="page-head"><h1 class="title">Sources &amp; Simulation</h1></div>${failure(err)}`;
    return {};
  }
  const datasets = Object.fromEntries(p.datasets.map((d) => [d.id, d]));
  const BASIS = { reference_dataset: "Reference dataset", mixed: "Dataset + modeled", modeled: "Modeled (no dataset)",
    unavailable: "Not simulated" };
  const STATUS = { used: "Used", evaluated_not_used: "Evaluated, not used", reference_only: "Shown as a reference only" };
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const list = (items, tag = "ul") => `<${tag}>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</${tag}>`;
  const facts = (rows) => `<dl class="facts">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

  const mapRow = (s, name) => {
    const d = datasets[s.dataset_id];
    return `<tr><td>${name}</td><td><span class="basis basis-${esc(s.basis)}">${BASIS[s.basis]}</span></td>
      <td>${d ? `${link(d.url, d.title)}<span class="cell-note">${esc(d.measures)}</span>` : "—"}</td><td>${d ? esc(d.original_location) : "—"}</td>
      <td><a href="#/sources/${encodeURIComponent(s.id)}">Steps</a></td></tr>`;
  };
  const mapping = p.simulations.flatMap((s) => s.targets.map((t) => mapRow(s, esc(t.name)))).join("");

  const sim = (s) => {
    const d = datasets[s.dataset_id];
    return `<details class="src-item" id="sim-${esc(s.id)}"${s.id === openId ? " open" : ""}>
      <summary><span>${esc(s.targets.map((t) => t.name).join(", "))}</span>
        <span class="basis basis-${esc(s.basis)}">${BASIS[s.basis]}</span></summary>
      <div class="src-body">
        ${facts([
          ["Source", d ? `${link(d.url, d.title)} (${esc(d.creators)}): ${esc(d.original_location)}` : "No dataset. A documented model."],
          ["Fields", s.source_fields.length ? esc(s.source_fields.join(", ")) : null],
          ["Source days", s.source_period ? esc(s.source_period) : null],
          ["Metric", s.metric ? esc(s.metric) : null],
          ["Periods", `<ul class="periods">${s.periods.map((x) => `<li><span class="num">${esc(x.start)}–${esc(x.end)}</span>
            <span class="basis basis-${esc(x.basis)}">${BASIS[x.basis]}</span> ${esc(x.label)}</li>`).join("")}</ul>`],
          ["Gaps", s.gap_handling ? esc(s.gap_handling) : null],
          ["Units", esc(s.units)],
          ["Parameters", `<code>${esc(JSON.stringify(s.parameters))}</code>`],
        ])}
        <h3>Steps</h3>${list(s.transformations, "ol")}
        <h3>Assumptions</h3>${list(s.assumptions)}
        <h3>Limits</h3>${list(s.limits)}
      </div></details>`;
  };

  const dataset = (d) => `<details class="src-item" id="data-${esc(d.id)}"${d.id === openId ? " open" : ""}>
    <summary><span>${esc(d.title)}</span><span class="basis status-${esc(d.status)}">${STATUS[d.status] ?? esc(d.status)}</span></summary>
    <div class="src-body">${facts([
      ["Creators", esc(d.creators)], ["Publisher", esc(d.publisher)], ["Link", link(d.url, d.url)],
      ["Version", esc(d.version)], ["Retrieved", esc(d.retrieved)],
      ["License", d.license_url ? link(d.license_url, d.license) : esc(d.license)], ["Obligations", esc(d.obligations)],
      ["Cite", d.citation ? esc(d.citation) : null], ["Paper", d.paper ? esc(d.paper) : null],
      ["Location", esc(d.original_location)], ["Metric", esc(d.metric)], ["Measures", esc(d.measures)],
      ["Sampling", esc(d.sampling)], ["Time", esc(d.timezone)], ["Method", esc(d.measurement)],
      ["Changes", d.modifications ? esc(d.modifications) : null], ["Notes", esc(d.notes)],
    ])}</div></details>`;

  $view.innerHTML = `
    <div class="page-head"><h1 class="title">Sources &amp; Simulation</h1>
      <p class="tagline">Where campus busyness comes from, and how it's simulated.</p></div>
    <p class="banner" role="note">${icon("info", 16)}<span>${esc(p.summary)}</span></p>
    <section class="card src-card"><h2>Which data drives each place</h2>
      <div class="table-scroll"><table class="map-table"><thead><tr><th>Place</th><th>Basis</th><th>Dataset</th><th>Original location</th><th></th></tr></thead>
        <tbody>${mapping}</tbody></table></div>
      <p class="help">A reference dataset gives a real time-of-day pattern from somewhere else; it is not a measurement of the BU place. ${esc(p.measures_note)} ${esc(p.demo_clock)}</p>
    </section>
    <section class="src-section"><h2 class="section-title">How each simulation is made</h2>${p.simulations.map(sim).join("")}</section>
    <section class="src-section"><h2 class="section-title">Datasets</h2>${p.datasets.map(dataset).join("")}</section>
    <div class="src-grid">
      <section class="card src-card"><h2>Still illustrative</h2>${list(p.illustrative)}</section>
      <section class="card src-card"><h2>Historical references</h2>
        <ul>${p.historical_references.map((r) => `<li><a href="#/place/${encodeURIComponent(r.facility_id)}">${esc(r.facility_id === "COD_Bosch_Office_1_Clemente" ? "Clemente Room — COD demo" : "Campus Gym — Historical Reference")}</a>: ${esc(r.note)}</li>`).join("")}</ul></section>
    </div>
    <details class="src-item"><summary><span>Reproduce the data</span></summary>
      <div class="src-body"><pre class="code">${esc(p.reproduce.join("\n"))}</pre>
      <p class="help">Downloads happen only when you ask (<code>--download</code>); the app and tests never fetch data. Generated by <code>${esc(p.generated_by)}</code>.</p></div></details>`;
  if (openId) $view.querySelector(`#sim-${CSS.escape(openId)}, #data-${CSS.escape(openId)}`)?.scrollIntoView({ block: "start" });
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
  const [section, id] = hash.split("/");
  const current = section === "" || section === "place" ? "places" : section;
  for (const a of document.querySelectorAll("[data-section]")) a.toggleAttribute("aria-current", a.dataset.section === current);
  view = null;
  window.scrollTo(0, 0);
  const next =
    section === "place" && id ? placeView(decodeURIComponent(id))
    : section === "events" && id === "new" ? newEventView()
    : section === "events" ? eventsView()
    : section === "about" ? aboutView()
    : section === "sources" ? sourcesView(id ? decodeURIComponent(id) : null)
    : section === "plan" ? planView($view, clock)
    : placesView();
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
      + "the same sample data, but meetups are saved on this device only.";
    $notice.hidden = false;
  }
});
// Version note in the corner. version.json is written by server/write_version.py on every
// deploy (each merge to main), so it updates by itself; a local copy without it shows nothing.
const fmtStamp = (iso, withTime = false) => new Date(iso).toLocaleString("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York",
  ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
});
fetch("version.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => {
  if (!v?.history?.length) return;
  const $v = document.getElementById("version");
  $v.innerHTML = `<summary title="Version history">v${v.version} · Updated ${esc(fmtStamp(v.date))}</summary>
    <div class="version-panel"><p class="version-head">Version history</p>
      <ol class="version-list">${v.history.map((h) => `<li><span class="version-num num">v${h.version}</span>
        <span><span class="version-title">${esc(h.title)}</span>
        <span class="version-meta">${esc(fmtStamp(h.date, true))} ET · ${h.url
          ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.commit)}</a>` : esc(h.commit)}</span></span></li>`).join("")}</ol></div>`;
  $v.hidden = false;
  // Close on Escape or a click elsewhere, like other popovers.
  document.addEventListener("click", (e) => { if ($v.open && !$v.contains(e.target)) $v.open = false; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $v.open) { $v.open = false; $v.querySelector("summary").focus(); }
  });
}).catch(() => {});

window.addEventListener("hashchange", route);
route();
