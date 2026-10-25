import { daySegments, freeWindows, matchFreeWindows, usableWindows, zonedInstant } from "./availability.js";
import { daySchedule, formatClock, formatPeriod } from "./hours.js";
import {
  addDays, eventsByDay, monthCells, monthTitle, rangeText, shiftMonth, timeOnDay, WEEK_STARTS, weekdayNames,
} from "./monthview.js";
import {
  busyOf, clearSchedule, covers, DEFAULT_TZ, eventsOf, importCalendarFile, ImportError, loadSchedule, saveSchedule, skippedText,
} from "./schedule.js";
import { clubBusy, clubEventItems, loadClubEvents, reconcile, removeClubEvent } from "./clubevents.js";
import { icon } from "./icons.js";
import * as src from "./source.js";
import { esc, failure, infoTip, loading } from "./ui.js";

export { DEFAULT_TZ };
export const MIN_OPTIONS = [15, 30, 45, 60];
const PREFS_KEY = "busy.calendar.prefs.v1";
const SEGMENT_LABELS = { busy: "Busy", available: "Available", short: "Free · too short", past: "Past" };
const STORED_IN = {
  local: "Saved in this browser's local storage on this device until you remove it.",
  session: "Kept in this tab only and cleared when you close it.",
  memory: "Kept only while this page is open: this browser blocks storage.",
};
const todayIn = (zone) => new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const MAX_IN_CELL = 3;   // events listed in a day cell before "+N more"
// "9:00 AM" → "9:00a", so event times fit in a day cell.
const compactTime = (label) => label.replace(/ ([AP])M/g, (_, x) => x.toLowerCase());
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
      ...(WEEK_STARTS.some(([day]) => day === raw.weekStart) ? { weekStart: raw.weekStart } : {}),
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
  let clubEvents = loadClubEvents();   // club meetings added from the Clubs tab, stored apart from the file
  const events = new AbortController();
  const on = { signal: events.signal };

  $view.innerHTML = `
    <div class="page-head"><h1 class="title">Your availability</h1>
      <p class="tagline">Upload your class schedule, see your free time, and match it with verified campus hours.</p></div>
    <section class="card calendar-connect" aria-labelledby="schedule-title">
      <div id="schedule-card"></div>
      <input id="schedule-file" type="file" accept=".ics,text/calendar" hidden>
      <div id="schedule-status" role="status" aria-live="polite"></div>
    </section>
    <section class="card month-card" aria-labelledby="month-title"><div id="month"></div></section>
    <section class="card calendar-controls" aria-label="Availability settings">
      <div class="avail-head"><span>Availability settings</span>${infoTip("About these settings",
        "Your day and preferred hours are read in this timezone (Boston time by default; enter an IANA name such as America/Los_Angeles to change it). Event times keep the timezone written in your calendar file. These settings are saved in this browser only.")}</div>
      <div class="calendar-controls-grid">
        <label>Date<div class="calendar-date-controls"><button class="icon-btn" type="button" data-date-step="-1" aria-label="Previous day">‹</button>
          <input id="calendar-date" type="date" value="${todayIn(DEFAULT_TZ)}">
          <button class="icon-btn" type="button" data-date-step="1" aria-label="Next day">›</button></div></label>
        <label>Timezone<input id="calendar-timezone" value="${esc(prefs.timezone ?? DEFAULT_TZ)}" autocomplete="off"></label>
        <label>Minimum time<select id="calendar-minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === (prefs.minimum ?? 30) ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
        <label>Available from<input id="calendar-from" type="time" value="${prefs.from ?? "08:00"}"></label>
        <label>Available until<input id="calendar-until" type="time" value="${prefs.until ?? "22:00"}"></label>
        <label>Campus location<select id="calendar-location"></select></label>
      </div>
    </section>
    <section class="card calendar-results" aria-live="polite"><div id="calendar-results">${loading()}</div></section>`;

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
  const $month = $view.querySelector("#month");
  let viewMonth = $date.value.slice(0, 7);   // the month on screen; the selected day is $date
  let focusEvent = null;                     // event to highlight after clicking it in the grid
  let weekStart = prefs.weekStart ?? 0;      // first column of the month grid: Sunday unless changed

  // The upload card: heading, status and upload/replace/clear always visible; the explanation and
  // instructions collapse (collapsed by default, and kept as the user left it while on this page).
  let uploadOpen = false;
  const renderCard = () => {
    const status = schedule
      ? `<p><strong>${esc(schedule.fileName)}</strong> · imported ${esc(formatDay(schedule.importedAt, DEFAULT_TZ))}</p>`
      : `<span class="pill">No schedule uploaded</span>`;
    const actions = schedule
      ? `<button class="btn" type="button" data-schedule="pick">Replace schedule</button>
        <button class="btn btn-quiet" type="button" data-schedule="remove">Clear imported calendar</button>`
      : `<button class="btn btn-primary" type="button" data-schedule="pick">Upload Calendar File</button>`;
    const details = schedule
      ? `<p>${esc(importSummary(schedule))}</p>
        <p class="help">Kept: each event's title and times (for your calendar below) and your merged busy times. Never kept: the file, descriptions, locations or guests. ${STORED_IN[schedule.storedIn]}</p>
        <label class="check"><input type="checkbox" id="schedule-remember"${schedule.storedIn === "local" ? " checked" : ""}> Remember my schedule on this device</label>`
      : `<p>Upload a calendar file (.ics) with your classes. BU-sy reads it in this browser to find your free time: the file isn't sent anywhere, and there's nothing to sign in to.</p>
        <details class="how-export"><summary>How to export your calendar</summary><ul>
          <li><strong>Google Calendar</strong> (on a computer): Settings → Import &amp; export → Export. Unzip the download and choose the .ics file for your class calendar.</li>
          <li><strong>Apple Calendar</strong> (Mac): select the calendar, then File → Export → Export….</li>
          <li><strong>Outlook</strong> (Windows): File → Save Calendar, and save it as an iCalendar (.ics) file.</li>
        </ul></details>
        <label class="check"><input type="checkbox" id="schedule-remember"> Remember my schedule on this device</label>`;
    $card.innerHTML = `<div class="upload-head">
        <h2 id="schedule-title"><button type="button" class="collapse-toggle" aria-expanded="${uploadOpen}" aria-controls="schedule-details">${schedule ? "Schedule imported" : "Upload your schedule"}${icon("down", 16)}</button></h2>
        <div class="calendar-actions">${status}${actions}</div>
      </div>
      <div class="collapse${uploadOpen ? " is-open" : ""}" id="schedule-details"${uploadOpen ? "" : " inert"}><div class="collapse-inner">${details}</div></div>`;
  };
  const setUploadOpen = (open) => {
    uploadOpen = open;
    $card.querySelector(".collapse-toggle").setAttribute("aria-expanded", open);
    const $details = $card.querySelector(".collapse");
    $details.classList.toggle("is-open", open);
    $details.inert = !open;   // collapsed content is skipped by Tab and screen readers
  };

  // ---------- month grid + the selected day's events (reads the same stored schedule) ----------
  const displayZone = () => (validZone($timezone.value.trim()) ? $timezone.value.trim() : DEFAULT_TZ);
  const renderMonth = () => {
    const zone = displayZone();
    const cells = monthCells(viewMonth, weekStart);
    // Two sources, shown together but stored apart: the imported .ics file and saved club meetings.
    const imported = schedule ? eventsOf(schedule) : null;   // null: no file, or one saved before event details
    const events = [...(imported ?? []), ...clubEventItems(clubEvents)];
    const byDay = eventsByDay(events, cells[0].date, cells[cells.length - 1].date, zone);
    const today = todayIn(zone);
    const selected = $date.value;
    const cell = ({ date, inMonth }) => {
      const entries = byDay.get(date) ?? [];
      const label = `${dateLabel(date)}${date === today ? ", today" : ""}: ${entries.length ? `${entries.length} event${entries.length === 1 ? "" : "s"}` : "no events"}`;
      return `<button type="button" class="day-cell${inMonth ? "" : " is-outside"}${date === today ? " is-today" : ""}${entries.length ? " has-events" : ""}"
        data-day="${date}" aria-pressed="${date === selected}" aria-label="${esc(label)}"${date === today ? ' aria-current="date"' : ""}>
        <span class="day-num num">${Number(date.slice(8))}</span>
        <span class="day-events" aria-hidden="true">${entries.slice(0, MAX_IN_CELL).map((entry) =>
          `<span class="day-event${entry.event.allDay ? " is-allday" : ""}${entry.event.free ? " is-free" : ""}${entry.event.source === "club" ? " is-club" : ""}" data-event="${entry.index}">${entry.event.allDay
            ? "" : `<span class="day-event-time num">${esc(compactTime(timeOnDay(entry, zone)))}</span> `}${esc(entry.event.title || "Untitled event")}</span>`).join("")}
          ${entries.length > MAX_IN_CELL ? `<span class="day-more">+${entries.length - MAX_IN_CELL} more</span>` : ""}</span>
        ${entries.length ? `<span class="day-count num" aria-hidden="true">${entries.length}</span>` : ""}
      </button>`;
    };

    // The selected day can be outside the month on screen after browsing other months.
    const shown = selected >= cells[0].date && selected <= cells[cells.length - 1].date;
    const dayEntries = (shown ? byDay : eventsByDay(events, selected, selected, zone)).get(selected) ?? [];
    // A few zones skip midnight on DST days; the day then starts at 1 AM.
    const dayStart = (date) => { try { return zonedInstant(date, "00:00", zone); } catch { return zonedInstant(date, "01:00", zone); } };
    const inRange = schedule && covers(schedule, dayStart(selected), dayStart(addDays(selected, 1)));
    // About the imported file for this day (club meetings are listed either way).
    const importNote = !schedule
      ? `<div class="month-empty"><p>No schedule imported yet. Upload your ICS file to display your events.</p>
        <button class="btn btn-primary" type="button" data-schedule="pick">Upload Calendar</button></div>`
      : !imported ? `<p class="help">This schedule was saved before BU-sy kept event details, so only your busy times are known. Upload the file again to see your events here.</p>`
      : !inRange ? `<p class="help">This date is outside the dates your imported calendar covers (${esc(formatDay(schedule.coverage.start, DEFAULT_TZ))}–${esc(formatDay(schedule.coverage.end - 1, DEFAULT_TZ))}).</p>`
      : "";
    const row = ({ event, index }) => {
      const club = event.source === "club";
      return `<li class="row${club ? " is-club" : ""}${index === focusEvent ? " is-featured" : ""}" id="event-${index}" tabindex="-1">
        <div class="row-main"><span class="row-name">${esc(event.title || "Untitled event")}</span>
          <span class="row-sub num">${esc(rangeText(event, zone))}</span>
          ${club ? `<span class="row-sub">Club: <a href="#/club/${encodeURIComponent(event.clubId)}">${esc(event.clubName)}</a></span>
          ${event.location ? `<span class="row-sub">${esc(event.location)}</span>` : ""}
          <span class="row-sub">${esc(event.note)}</span>
          ${event.issue ? `<span class="row-issue">${esc(event.issue)}</span>` : ""}` : ""}</div>
        <div class="row-side">${club ? `<span class="tag tag-club">Club event</span>` : ""}<span class="tag${event.free ? "" : " tag-busy"}">${event.free ? "Marked free · not counted as busy" : "Busy"}</span>${club
          ? `<button class="btn btn-small btn-quiet" type="button" data-remove-club="${esc(event.id)}" aria-label="Remove ${esc(event.title)} on ${esc(dateLabel(selected))} from your calendar">Remove</button>` : ""}</div></li>`;
    };
    const dayList = `${dayEntries.length ? `<ul class="list day-list">${dayEntries.map(row).join("")}</ul>`
      : schedule && imported && inRange ? `<p class="muted">No events on this day.</p>` : ""}${importNote}`;

    $month.innerHTML = `<div class="month-head">
        <h2 id="month-title">${esc(monthTitle(viewMonth))}</h2>
        <div class="month-nav">
          <label class="month-week-start">Week starts<select data-week-start>${WEEK_STARTS.map(([day, name]) =>
            `<option value="${day}"${day === weekStart ? " selected" : ""}>${name}</option>`).join("")}</select></label>
          <span class="month-step">
            <button class="icon-btn" type="button" data-month="-1" aria-label="Previous month">‹</button>
            <button class="btn btn-small" type="button" data-month="today">Today</button>
            <button class="icon-btn" type="button" data-month="1" aria-label="Next month">›</button>
          </span>
        </div>
      </div>
      <div class="month-weekdays" aria-hidden="true">${weekdayNames(weekStart).map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="month-grid">${cells.map(cell).join("")}</div>
      <section class="day-detail" aria-live="polite">
        <h3>${esc(dateLabel(selected))}</h3>
        ${dayList}
      </section>`;
    if (focusEvent != null) {
      const $row = $month.querySelector(`#event-${focusEvent}`);
      $row?.scrollIntoView({ block: "nearest" });
      $row?.focus({ preventScroll: true });
      focusEvent = null;
    }
  };
  // The calendar, the date control and the availability results always show the same day.
  const selectDay = (date) => {
    $date.value = date;
    viewMonth = date.slice(0, 7);
    renderMonth();
    if (ready) renderResults();   // before campus data loads, the results catch up once it does
  };
  $month.addEventListener("change", (event) => {
    if (!event.target.matches("[data-week-start]")) return;
    weekStart = Number(event.target.value);
    saveCalendarPrefs({ weekStart });
    renderMonth();
    $month.querySelector("[data-week-start]")?.focus();
  }, on);
  $month.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-club]");
    if (remove) {
      try {
        const title = clubEvents.find((saved) => saved.id === remove.dataset.removeClub)?.clubName ?? "Club";
        clubEvents = removeClubEvent(remove.dataset.removeClub);
        $status.innerHTML = `<p class="calendar-ok">Removed the ${esc(title)} meeting from your calendar.</p>`;
      } catch {
        $status.innerHTML = `<p class="calendar-error">This browser couldn't save the change, so the club event is still in your calendar.</p>`;
      }
      renderMonth();
      if (ready) renderResults();
      return;
    }
    const step = event.target.closest("[data-month]")?.dataset.month;
    if (step === "today") {
      selectDay(todayIn(displayZone()));
    } else if (step) {
      viewMonth = shiftMonth(viewMonth, Number(step));
      renderMonth();
    } else {
      const day = event.target.closest("[data-day]")?.dataset.day;
      if (!day) return;
      const chip = event.target.closest("[data-event]");
      focusEvent = chip ? Number(chip.dataset.event) : null;
      selectDay(day);
    }
  }, on);

  // The upload card and the calendar don't depend on campus data, so they show at once.
  let ready = false;
  renderCard();
  renderMonth();
  // Saved club meetings are checked against the clubs' current data: a changed time is updated,
  // a meeting the club no longer has is flagged. Offline, they're shown as saved.
  src.clubs.list().then((clubs) => {
    clubEvents = reconcile(clubEvents, clubs);
    renderMonth();
    if (ready) renderResults();
  }).catch(() => {});
  let loadError = null;
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
    loadError = error;   // only the free-time results need campus hours; everything else keeps working
  }

  const savePrefs = () => saveCalendarPrefs({
    timezone: $timezone.value.trim(),
    minimum: Number($minimum.value),
    from: $from.value,
    until: $until.value,
    location: $location.value,
  });

  const renderResults = () => {
    if (loadError) {
      $results.innerHTML = failure(loadError);
      return;
    }
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
    const publishedHours = `<h3 class="with-info">Hours at ${locationName}${infoTip("About these hours",
        `These are the location's published hours (campus time), not a recommendation for you. ${verifiedNote}`)}</h3>
      ${locationHours ? hoursSummary(locationHours, matchingLocation?.category, $date.value) : `<p class="help">Hours for this location are unverified.</p>`}`;

    // Outside the dates an uploaded calendar covers, there's no claim that the day is free.
    if (schedule && !covers(schedule, start, end)) {
      $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
        <h3>Your day</h3>
        <ul class="calendar-timeline"><li class="calendar-interval" data-kind="unknown"><strong>Schedule unknown</strong>
          <span>${range}</span></li></ul>
        <p class="help">This date is outside the dates your imported calendar covers (${esc(formatDay(schedule.coverage.start, DEFAULT_TZ))}–${esc(formatDay(schedule.coverage.end - 1, DEFAULT_TZ))}). Upload a newer export to see it.</p>
        ${publishedHours}`;
      return;
    }

    // No upload counts as an empty schedule: free for the whole preferred window.
    // Busy = the imported file's busy times plus every saved club meeting; free time is what's
    // left around both (overlaps merge). Each event is still listed on its own in "Your day".
    const fileBusy = schedule ? busyOf(schedule) : [];
    const busy = [...fileBusy, ...clubBusy(clubEvents)];
    const now = Date.now();
    const importedEvents = schedule ? eventsOf(schedule) : null;
    const listed = [...(importedEvents ?? []), ...clubEventItems(clubEvents)]
      .filter((event) => !event.free && event.start < end && event.end > start)
      .map((event) => ({
        start: Math.max(event.start, start),
        end: Math.min(event.end, end),
        kind: "busy",
        title: event.source === "club" ? `${event.title} (club event)` : event.title || "Untitled event",
      }));
    // A file saved before event details has busy times without titles: shown as merged blocks.
    const untitled = schedule && importedEvents === null
      ? daySegments(fileBusy, start, end, minimum, now).filter((interval) => interval.kind === "busy") : [];
    const segments = [
      ...daySegments(busy, start, end, minimum, now).filter((interval) => interval.kind !== "busy"),
      ...untitled,
      ...listed,
    ].sort((a, b) => a.start - b.start
      || (a.kind === "busy" && b.kind !== "busy" ? -1 : a.kind !== "busy" && b.kind === "busy" ? 1 : 0));
    const usable = usableWindows(freeWindows(busy, start, end), minimum, now);
    const total = usable.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const match = locationHours
      ? matchFreeWindows(usable, { ...locationHours, category: matchingLocation?.category }, $date.value, minimum)
      : { status: "unverified", matches: [] };
    const assumedNote = match.assumed ? " Hours for this date are assumed to repeat the published weekly schedule." : "";
    const afterLastEvent = schedule && !schedule.openEnded && (schedule.lastBusyEnd == null || start >= schedule.lastBusyEnd)
      ? `<p class="help">Your calendar has no events ${schedule.lastBusyEnd == null ? "in the imported range" : `after ${esc(formatDay(schedule.lastBusyEnd, zone))}`}. If it only covers one semester, this free time may not match your real schedule.</p>`
      : "";
    const timelineHtml = segments.length ? `<ul class="calendar-timeline">${segments.map((interval) =>
      `<li class="calendar-interval" data-kind="${interval.kind}"><strong>${SEGMENT_LABELS[interval.kind]}</strong>
        ${interval.kind === "busy" && interval.title ? `<span class="calendar-event-title">${esc(interval.title)}</span>` : ""}
        <span class="calendar-interval-time">${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)}</span>
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
      <h3 class="with-info">Your day${infoTip("About availability assumptions", schedule
        ? `From ${esc(schedule.fileName)}. Cancelled events, excluded occurrences and events marked free aren't counted as busy; club events you added are. Travel time is not included.`
        : `No schedule uploaded. Availability assumes you're free from ${esc(formatClock($from.value))} to ${esc(formatClock($until.value))} in the ${esc(zone)} timezone. Upload your class schedule (.ics) above to calculate availability using your actual events. Club events you added count as busy. Travel time is not included.`)}</h3>${timelineHtml}${afterLastEvent}
      <h3 class="with-info">Time at ${locationName}${infoTip("About these times",
        `Free windows that overlap ${isDining ? "a meal service while the building is open" : "the building's open hours"}, from the same verified hours as the place pages. Travel time isn't included. Confirm the trip fits your schedule. ${verifiedNote}`)}</h3>${matchesHtml}
      ${usable.length ? `<h3>Places that fit your free time</h3>${fitsHtml}` : ""}
      ${assumedNote ? `<p class="help">${assumedNote.trim()}</p>` : ""}`;
  };

  const showStatus = (html) => { $status.innerHTML = html; };

  const upload = async (file) => {
    const remember = $card.querySelector("#schedule-remember")?.checked ?? false;
    const hadSchedule = !!schedule;
    showStatus(loading(`Reading ${esc(file.name)}…`));
    try {
      schedule = await importCalendarFile(file, { remember });
      renderCard();
      renderMonth();
      showStatus(`<p class="calendar-ok">Imported ${esc(file.name)}. ${esc(importSummary(schedule))}</p>`);
    } catch (error) {
      const message = error instanceof ImportError ? error.message : "The file couldn't be read.";
      showStatus(`<p class="calendar-error">${esc(message)} ${hadSchedule ? "Your previous schedule is unchanged." : ""}</p>
        <p class="help">Try another .ics file.</p>`);
    }
    renderResults();
  };

  $view.addEventListener("click", (event) => {
    const action = event.target.closest("[data-schedule]")?.dataset.schedule;
    if (action === "pick") {
      $file.click();
    } else if (action === "remove") {
      if (!confirm(`Clear your imported calendar? Its events and busy times will be deleted from this browser.${clubEvents.length
        ? (clubEvents.length === 1
          ? " The club event you added stays; remove it in the calendar."
          : ` The ${clubEvents.length} club events you added stay; remove them one by one in the calendar.`) : ""}`)) return;
      clearSchedule();
      schedule = null;
      renderCard();
      showStatus(`<p class="calendar-ok">Imported calendar cleared. Its events and busy times were deleted from this browser.${clubEvents.length ? " Club events you added are still in your calendar." : ""}</p>`);
      renderMonth();
      renderResults();
      $card.querySelector("[data-schedule]")?.focus();
    } else {
      const step = event.target.closest("[data-date-step]");
      if (step) selectDay(addDays($date.value, Number(step.dataset.dateStep)));
    }
  }, on);
  $card.addEventListener("click", (event) => {
    if (event.target.closest(".collapse-toggle")) setUploadOpen(!uploadOpen);
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
  $date.addEventListener("change", () => { if ($date.value) selectDay($date.value); }, on);
  for (const $input of [$minimum, $from, $until, $location]) $input.addEventListener("change", rerender, on);
  $timezone.addEventListener("change", () => { rerender(); renderMonth(); }, on);
  ready = true;
  renderResults();
  return { dispose() { events.abort(); } };
}
