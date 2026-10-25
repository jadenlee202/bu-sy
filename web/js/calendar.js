import { daySegments, freeWindows, matchFreeWindows, usableWindows, zonedInstant } from "./availability.js";
import { daySchedule, formatPeriod } from "./hours.js";
import { SAMPLE_DATES, SAMPLE_NOTE, SAMPLE_ZONE, sampleBusyForDay, sampleEventsForDay } from "./sample-schedule.js";
import {
  busyOf, clearSchedule, covers, DEFAULT_TZ, importCalendarFile, ImportError, loadSchedule, saveSchedule, skippedText,
} from "./schedule.js";
import * as src from "./source.js";
import { esc, failure, loading } from "./ui.js";

export { DEFAULT_TZ };
export const MIN_OPTIONS = [15, 30, 45, 60];
const PREFS_KEY = "busy.calendar.prefs.v1";
const SEGMENT_LABELS = { busy: "Busy", available: "Available", short: "Free · too short", past: "Past" };
const STORED_IN = {
  local: "Saved in this browser's local storage on this device until you remove it.",
  session: "Kept in this tab only and cleared when you close it.",
  memory: "Kept only while this page is open: this browser blocks storage.",
};
const dateInputValue = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const plusDays = (isoDate, amount) => {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
};
export const formatInstant = (timestamp, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(timestamp));
const formatDay = (timestamp, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, month: "short", day: "numeric", year: "numeric",
}).format(new Date(timestamp));
export const durationLabel = (milliseconds) => {
  const minutes = Math.round(milliseconds / 60_000);
  return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} hr ` : ""}${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
};
const dateLabel = (isoDate) => new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
}).format(new Date(`${isoDate}T12:00:00Z`));
const validZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

// Settings only, never calendar data (that lives in schedule.js).
export function loadCalendarPrefs() {
  try {
    const raw = JSON.parse(src.store.get(PREFS_KEY) ?? "null") ?? {};
    const clock = (value) => typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
    return {
      ...(typeof raw.timezone === "string" && validZone(raw.timezone) ? { timezone: raw.timezone } : {}),
      ...(MIN_OPTIONS.includes(raw.minimum) ? { minimum: raw.minimum } : {}),
      ...(clock(raw.from) ? { from: raw.from } : {}),
      ...(clock(raw.until) ? { until: raw.until } : {}),
      ...(typeof raw.location === "string" ? { location: raw.location } : {}),
    };
  } catch {
    return {};
  }
}

export function saveCalendarPrefs(changes) {
  src.store.set(PREFS_KEY, JSON.stringify({ ...loadCalendarPrefs(), ...changes }));
}

/** "12 events imported (340 times between Sep 24, 2026 and Oct 26, 2027). 1 skipped: …" */
export function importSummary(schedule) {
  const { stats, coverage } = schedule;
  const parts = [`${stats.events} event${stats.events === 1 ? "" : "s"} imported (${stats.occurrences} busy time${stats.occurrences === 1 ? "" : "s"} between ${formatDay(coverage.start, DEFAULT_TZ)} and ${formatDay(coverage.end - 1, DEFAULT_TZ)}).`];
  const skipped = Object.values(stats.skipped).reduce((sum, count) => sum + count, 0);
  if (skipped) parts.push(`${skipped} skipped: ${skippedText(stats.skipped)}.`);
  if (stats.cancelled) parts.push(`${stats.cancelled} cancelled ${stats.cancelled === 1 ? "event or occurrence" : "events or occurrences"} ignored.`);
  if (stats.free) parts.push(`${stats.free} marked free, not counted as busy.`);
  if (stats.truncated) parts.push("Some repeating events had too many occurrences and were cut short.");
  return parts.join(" ");
}

// What a location publishes for one campus date, shown when free time can't be worked out.
function hoursSummary(locationHours, category, isoDate) {
  const building = daySchedule(locationHours, isoDate, "building");
  if (building.status === "closed") return `<p>Closed on this date.</p>`;
  if (building.status === "unpublished") return `<p class="help">Hours for this date are not published yet.</p>`;
  if (building.status !== "scheduled") return `<p class="help">Hours for this location are unverified.</p>`;
  const rows = [`<li><strong>Building open</strong><span>${building.periods.map(formatPeriod).join(" · ")}</span></li>`];
  if (category === "dining") {
    const service = daySchedule(locationHours, isoDate, "service");
    if (service.status === "scheduled") {
      rows.push(...service.periods.map((period) =>
        `<li><strong>${esc(period.label)}</strong><span>${formatPeriod(period)}</span></li>`));
    } else {
      rows.push(`<li><strong>Meal service</strong><span>Not published for this date</span></li>`);
    }
  }
  const assumed = building.assumed ? `<p class="help">Assumed: these repeat the published weekly hours. No hours have been published for this date yet.</p>` : "";
  return `<ul class="calendar-matches">${rows.join("")}</ul>${assumed}`;
}

export async function calendarView($view) {
  const prefs = loadCalendarPrefs();
  let facilities = [];
  let hours = null;
  let schedule = loadSchedule();
  // The supplied sample week drives the page until the student uses their own schedule
  // (an uploaded one that's still kept turns the sample off from the start).
  let sampleMode = !schedule;
  const events = new AbortController();
  const on = { signal: events.signal };

  $view.innerHTML = `
    <div class="page-head"><h1 class="title">Your availability</h1>
      <p class="tagline">Preview a sample week, or upload your class schedule to see your free time and match it with verified campus hours.</p></div>
    <section class="card sample-preview" aria-label="Sample weekly schedule">
      <div class="calendar-actions"><h2>Sample week · October 25–31, 2026</h2>
        <label class="check"><input type="checkbox" id="calendar-sample"${sampleMode ? " checked" : ""}><span>Use sample schedule</span></label></div>
      <p class="help">${esc(SAMPLE_NOTE)}</p>
      <div class="sample-week" id="sample-week"></div>
    </section>
    <section class="card calendar-connect" aria-labelledby="schedule-title">
      <div id="calendar-connection"></div>
      <div id="schedule-card"></div>
      <input id="schedule-file" type="file" accept=".ics,text/calendar" hidden>
      <div id="schedule-status" role="status" aria-live="polite"></div>
    </section>
    <section class="card calendar-controls" aria-label="Availability settings">
      <div class="calendar-controls-grid">
        <label>Date<div class="calendar-date-controls"><button class="icon-btn" type="button" data-date-step="-1" aria-label="Previous day">‹</button>
          <input id="calendar-date" type="date" value="${sampleMode ? SAMPLE_DATES[1] : dateInputValue()}">
          <button class="icon-btn" type="button" data-date-step="1" aria-label="Next day">›</button></div></label>
        <label>Timezone<input id="calendar-timezone" value="${esc(sampleMode ? SAMPLE_ZONE : prefs.timezone ?? DEFAULT_TZ)}"${sampleMode ? " readonly" : ""} autocomplete="off" aria-describedby="calendar-timezone-help"></label>
        <label>Minimum time<select id="calendar-minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === (prefs.minimum ?? 30) ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
        <label>Available from<input id="calendar-from" type="time" value="${prefs.from ?? "08:00"}"></label>
        <label>Available until<input id="calendar-until" type="time" value="${prefs.until ?? "22:00"}"></label>
        <label>Campus location<select id="calendar-location"></select></label>
      </div>
      <p class="help" id="calendar-timezone-help">The sample week uses Boston time (GMT-04). With your own schedule, your day and preferred hours are read in this timezone (Boston time by default; enter an IANA name such as America/Los_Angeles to change it), and event times keep the timezone written in your calendar file. Only your own settings are saved in this browser; the preview saves nothing.</p>
    </section>
    <section class="card calendar-results" aria-live="polite"><div id="calendar-results">${loading()}</div></section>`;

  const $connection = $view.querySelector("#calendar-connection");
  const $sample = $view.querySelector("#calendar-sample");
  const $week = $view.querySelector("#sample-week");
  const $card = $view.querySelector("#schedule-card");
  const $file = $view.querySelector("#schedule-file");
  const $status = $view.querySelector("#schedule-status");
  const $results = $view.querySelector("#calendar-results");
  const $date = $view.querySelector("#calendar-date");
  const $timezone = $view.querySelector("#calendar-timezone");
  const $minimum = $view.querySelector("#calendar-minimum");
  const $from = $view.querySelector("#calendar-from");
  const $until = $view.querySelector("#calendar-until");
  const $location = $view.querySelector("#calendar-location");

  const renderWeek = () => {
    $week.innerHTML = SAMPLE_DATES.map((date) => `<section class="sample-day"${date === $date.value && sampleMode ? ' data-selected="true"' : ""}>
      <button type="button" class="btn btn-small" data-sample-date="${date}" aria-pressed="${date === $date.value && sampleMode}">${esc(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`)))}</button>
      <ul>${sampleEventsForDay(date).map((event) => `<li><strong>${esc(event.title)}</strong>
        <span>${event.allDay ? "All day · doesn't block time" : `${event.start}–${event.end}${event.estimatedEnd ? " · end estimated" : ""}`}</span>
        ${event.location ? `<span>${esc(event.location)}</span>` : ""}</li>`).join("")}</ul></section>`).join("");
  };
  const renderConnection = () => {
    $connection.innerHTML = sampleMode
      ? `<h2>Sample preview · no upload needed</h2><p>The sample week above drives the free-time results below. Turn off “Use sample schedule”, or upload your own calendar file, to use your schedule instead.</p>`
      : "";
  };
  // Switching between the sample week and the student's own schedule.
  const setSampleMode = (value, date) => {
    sampleMode = value;
    $sample.checked = value;
    $timezone.readOnly = value;
    $timezone.value = value ? SAMPLE_ZONE : prefs.timezone ?? DEFAULT_TZ;
    $date.value = date ?? (value ? SAMPLE_DATES[1] : dateInputValue());
    renderWeek();
    renderConnection();
  };

  const renderCard = () => {
    if (!schedule) {
      $card.innerHTML = `<h2 id="schedule-title">Upload your schedule</h2>
        <p>Upload a calendar file (.ics) with your classes. BU-sy reads it in this browser to find your free time: the file isn't sent anywhere, and there's nothing to sign in to.</p>
        <details class="how-export"><summary>How to export your calendar</summary><ul>
          <li><strong>Google Calendar</strong> (on a computer): Settings → Import &amp; export → Export. Unzip the download and choose the .ics file for your class calendar.</li>
          <li><strong>Apple Calendar</strong> (Mac): select the calendar, then File → Export → Export….</li>
          <li><strong>Outlook</strong> (Windows): File → Save Calendar, and save it as an iCalendar (.ics) file.</li>
        </ul></details>
        <label class="check"><input type="checkbox" id="schedule-remember"> Remember my schedule on this device</label>
        <div class="calendar-actions"><span class="pill">No schedule uploaded</span>
          <button class="btn btn-primary" type="button" data-schedule="pick">Upload Calendar File</button></div>`;
      return;
    }
    $card.innerHTML = `<h2 id="schedule-title">Schedule imported</h2>
      <p><strong>${esc(schedule.fileName)}</strong> · imported ${esc(formatDay(schedule.importedAt, DEFAULT_TZ))}</p>
      <p>${esc(importSummary(schedule))}</p>
      <p class="help">Only your merged busy times are kept, not the file or any event titles, descriptions, locations or guests. ${STORED_IN[schedule.storedIn]}</p>
      <label class="check"><input type="checkbox" id="schedule-remember"${schedule.storedIn === "local" ? " checked" : ""}> Remember my schedule on this device</label>
      <div class="calendar-actions">
        <button class="btn" type="button" data-schedule="pick">Replace schedule</button>
        <button class="btn btn-quiet" type="button" data-schedule="remove">Remove schedule</button></div>`;
  };

  try {
    [facilities, hours] = await Promise.all([src.listFacilities(), src.getHours()]);
    facilities = facilities.filter((facility) => facility.data_mode !== "historical_playback");
    $location.innerHTML = facilities.map((facility) =>
      `<option value="${esc(facility.facility_id)}">${esc(facility.facility_name)}</option>`,
    ).join("");
    const dining = facilities.find((facility) => facility.category === "dining");
    if (facilities.some((facility) => facility.facility_id === prefs.location)) $location.value = prefs.location;
    else if (dining) $location.value = dining.facility_id;
  } catch (error) {
    renderCard();
    $results.innerHTML = failure(error);
    return {};
  }

  const savePrefs = () => !sampleMode && saveCalendarPrefs({
    timezone: $timezone.value.trim(),
    minimum: Number($minimum.value),
    from: $from.value,
    until: $until.value,
    location: $location.value,
  });

  const renderResults = () => {
    const zone = $timezone.value.trim();
    if (!$date.value || !$from.value || !$until.value || !$location.value || !zone) {
      $results.innerHTML = `<p class="calendar-error">Choose a date, timezone, availability window, and location.</p>`;
      return;
    }
    let start;
    let end;
    try {
      if (!validZone(zone)) throw new RangeError("invalid timezone");
      start = zonedInstant($date.value, $from.value, zone);
      end = zonedInstant($date.value, $until.value, zone);
    } catch {
      $results.innerHTML = `<p class="calendar-error">Enter a valid IANA timezone and a local time that exists on this date.</p>`;
      return;
    }
    if (end <= start) {
      $results.innerHTML = `<p class="calendar-error">The availability end time must be later than the start time on the selected day.</p>`;
      return;
    }
    const minimum = Number($minimum.value);
    const matchingLocation = facilities.find((facility) => facility.facility_id === $location.value);
    const locationName = esc(matchingLocation?.facility_name ?? "campus location");
    const locationHours = hours.locations[$location.value];
    const isDining = matchingLocation?.category === "dining";
    const verifiedNote = locationHours?.lastVerified ? `Location hours last verified ${esc(locationHours.lastVerified)}.` : "";
    const range = `${formatInstant(start, zone)}–${formatInstant(end, zone)}`;
    const publishedHours = `<h3>Hours at ${locationName}</h3>
      ${locationHours ? hoursSummary(locationHours, matchingLocation?.category, $date.value) : `<p class="help">Hours for this location are unverified.</p>`}
      <p class="help">These are the location's published hours (campus time), not a recommendation for you. ${verifiedNote}</p>`;

    if (sampleMode && !SAMPLE_DATES.includes($date.value)) {
      $results.innerHTML = `<h2>Outside the sample week</h2><p>No sample schedule is provided for this date. Choose October 25–31 above, or turn off sample mode to use your own schedule.</p>
        ${publishedHours}`;
      return;
    }
    // Without a schedule, or outside the dates it covers, there's no claim that the day is free.
    if (!sampleMode && (!schedule || !covers(schedule, start, end))) {
      $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
        <h3>Your day</h3>
        <ul class="calendar-timeline"><li class="calendar-interval" data-kind="unknown"><strong>Schedule unknown</strong>
          <span>${range}</span></li></ul>
        <p class="help">${schedule
          ? `This date is outside the dates your imported calendar covers (${esc(formatDay(schedule.coverage.start, DEFAULT_TZ))}–${esc(formatDay(schedule.coverage.end - 1, DEFAULT_TZ))}). Upload a newer export to see it.`
          : "No schedule uploaded, so BU-sy doesn't know when you're busy or free. Upload an .ics file above."}</p>
        ${publishedHours}`;
      return;
    }

    // The sample replays its whole day regardless of today's clock; a real schedule hides past time.
    const busy = sampleMode ? sampleBusyForDay($date.value) : busyOf(schedule);
    const now = sampleMode ? -Infinity : Date.now();
    const segments = daySegments(busy, start, end, minimum, now);
    const usable = usableWindows(freeWindows(busy, start, end), minimum, now);
    const total = usable.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const match = locationHours
      ? matchFreeWindows(usable, { ...locationHours, category: matchingLocation?.category }, $date.value, minimum)
      : { status: "unverified", matches: [] };
    const assumedNote = match.assumed ? " Hours for this date are assumed to repeat the published weekly schedule." : "";
    const afterLastEvent = !sampleMode && !schedule.openEnded && (schedule.lastBusyEnd == null || start >= schedule.lastBusyEnd)
      ? `<p class="help">Your calendar has no events ${schedule.lastBusyEnd == null ? "in the imported range" : `after ${esc(formatDay(schedule.lastBusyEnd, zone))}`}. If it only covers one semester, this free time may not match your real schedule.</p>`
      : "";
    const timelineHtml = segments.length ? `<ul class="calendar-timeline">${segments.map((interval) =>
      `<li class="calendar-interval" data-kind="${interval.kind}"><strong>${SEGMENT_LABELS[interval.kind]}</strong>
        <span>${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)}</span>
        <span>${durationLabel(interval.end - interval.start)}</span></li>`,
    ).join("")}</ul>` : `<p>No busy events or free intervals in this preferred availability window.</p>`;
    let matchesHtml;
    if (match.status === "closed") {
      matchesHtml = `<p>${locationName} is closed on this date.</p>`;
    } else if (match.status === "unverified" || match.status === "unpublished" || match.status === "not_applicable") {
      matchesHtml = `<p class="help">Location hours are ${match.status === "unpublished" ? "not published for this date" : "unverified"}; BU-sy will not recommend a visit using unconfirmed hours.</p>`;
    } else if (!usable.length) {
      matchesHtml = `<p>You have no remaining free window of at least ${minimum} minutes in ${esc($from.value)}–${esc($until.value)}. Try a shorter minimum, wider hours, or another date.</p>`;
    } else if (!match.matches.length) {
      matchesHtml = `<p>None of your free windows of at least ${minimum} minutes overlaps ${isDining ? "a meal service while the building is open" : "the building's open hours"}. Try a shorter minimum, wider hours, another date, or another location.</p>`;
    } else {
      matchesHtml = `<ul class="calendar-matches">${match.matches.map((interval) =>
        `<li><strong>${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)}</strong>
          <span>${durationLabel(interval.end - interval.start)} available · ${isDining ? `${locationName} is open and serving ${esc(interval.label.toLowerCase())}` : `${locationName} is open`}</span></li>`,
      ).join("")}</ul>`;
    }

    // Every campus place with verified hours that fits one of the free windows.
    const fits = usable.length ? facilities.flatMap((facility) => {
      const location = hours.locations[facility.facility_id];
      if (!location) return [];
      const { status, matches } = matchFreeWindows(usable, { ...location, category: facility.category }, $date.value, minimum);
      return status === "scheduled" && matches.length ? [{ facility, matches }] : [];
    }) : [];
    const fitsHtml = !usable.length ? ""
      : fits.length ? `<ul class="calendar-matches">${fits.map(({ facility, matches }) =>
        `<li><strong><a href="#/place/${encodeURIComponent(facility.facility_id)}">${esc(facility.facility_name)}</a></strong>
          ${matches.map((interval) => `<span>${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)} · ${durationLabel(interval.end - interval.start)}${facility.category === "dining" ? ` · ${esc(interval.label)}` : " · Open"}</span>`).join("")}</li>`,
      ).join("")}</ul>`
      : `<p>No campus place with verified hours is open for ${minimum}+ minutes during your free time on this date.</p>`;

    $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
      <p class="calendar-total"><strong>${durationLabel(total) || "0 min"}</strong> available (free windows of ${minimum}+ min) during ${esc($from.value)}–${esc($until.value)} (${esc(zone)}).</p>
      <h3>Your day</h3>${timelineHtml}
      <p class="help">${sampleMode
        ? "Sample availability from the supplied screenshot, including the labelled estimated ends. Overlapping commitments count once. Halloween does not block time. No calendar file is used."
        : `From ${esc(schedule.fileName)}. Cancelled events, excluded occurrences and events marked free aren't counted as busy.`}</p>${afterLastEvent}
      <h3>Time at ${locationName}</h3>${matchesHtml}
      ${usable.length ? `<h3>Places that fit your free time</h3>${fitsHtml}` : ""}
      <p class="help">Travel time isn't included. Confirm the trip fits your schedule.${assumedNote} ${verifiedNote}</p>`;
  };

  const showStatus = (html) => { $status.innerHTML = html; };

  const upload = async (file) => {
    const remember = $card.querySelector("#schedule-remember")?.checked ?? false;
    const hadSchedule = !!schedule;
    showStatus(loading(`Reading ${esc(file.name)}…`));
    try {
      schedule = await importCalendarFile(file, { remember });
      if (sampleMode) setSampleMode(false);   // an upload means the student wants their own schedule
      renderCard();
      showStatus(`<p class="calendar-ok">Imported ${esc(file.name)}. ${esc(importSummary(schedule))}</p>`);
    } catch (error) {
      const message = error instanceof ImportError ? error.message : "The file couldn't be read.";
      showStatus(`<p class="calendar-error">${esc(message)} ${hadSchedule ? "Your previous schedule is unchanged." : ""}</p>
        <p class="help">Try another .ics file.</p>`);
    }
    renderResults();
  };

  $sample.addEventListener("change", () => {
    setSampleMode($sample.checked);
    renderResults();
  }, on);
  $view.addEventListener("click", (event) => {
    const sampleDate = event.target.closest("[data-sample-date]");
    if (sampleDate) {
      setSampleMode(true, sampleDate.dataset.sampleDate);
      renderResults();
      return;
    }
    const action = event.target.closest("[data-schedule]")?.dataset.schedule;
    if (action === "pick") {
      $file.click();
    } else if (action === "remove") {
      clearSchedule();
      schedule = null;
      renderCard();
      showStatus(`<p class="calendar-ok">Schedule removed. Your busy times were deleted from this browser.</p>`);
      renderResults();
      $card.querySelector("[data-schedule]")?.focus();
    } else {
      const step = event.target.closest("[data-date-step]");
      if (step) {
        $date.value = plusDays($date.value, Number(step.dataset.dateStep));
        renderWeek();
        renderResults();
      }
    }
  }, on);
  $card.addEventListener("change", (event) => {
    if (event.target.id !== "schedule-remember" || !schedule) return;
    schedule = { ...schedule, storedIn: saveSchedule(schedule, event.target.checked) };
    renderCard();
    $card.querySelector("#schedule-remember")?.focus();
  }, on);
  $file.addEventListener("change", () => {
    const [file] = $file.files;
    $file.value = "";
    if (file) void upload(file);
  }, on);

  const rerender = () => { savePrefs(); renderResults(); };
  $date.addEventListener("change", () => { renderWeek(); renderResults(); }, on);
  for (const $input of [$timezone, $minimum, $from, $until, $location]) $input.addEventListener("change", rerender, on);
  renderWeek();
  renderConnection();
  renderCard();
  renderResults();
  return { dispose() { events.abort(); } };
}
