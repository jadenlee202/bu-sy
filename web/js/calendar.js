import { daySegments, freeWindows, matchFreeWindows, usableWindows, zonedInstant } from "./availability.js";
import { daySchedule, formatPeriod } from "./hours.js";
import * as src from "./source.js";
import { esc, failure, loading } from "./ui.js";

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
export const MIN_OPTIONS = [15, 30, 45, 60];
const PREFS_KEY = "busy.calendar.prefs.v1";
const SEGMENT_LABELS = { busy: "Busy", available: "Available", short: "Free · too short", past: "Past" };
const dateInputValue = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const plusDays = (isoDate, amount) => {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
};
export const formatInstant = (timestamp, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short",
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

// Settings only, never calendar data: busy times stay in memory for this page.
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

// What a location publishes for one campus date, for the not-connected calendar.
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
  return `<ul class="calendar-matches">${rows.join("")}</ul>`;
}

export async function calendarView($view) {
  const prefs = loadCalendarPrefs();
  const selectedDate = dateInputValue();
  let connected = false;
  let configured = false;
  let backendReachable = false;
  let facilities = [];
  let hours = null;
  let busy = [];
  let requestId = 0;

  $view.innerHTML = `
    <div class="page-head"><h1 class="title">Your availability</h1>
      <p class="tagline">Find real free time and match it with verified campus hours.</p></div>
    <section class="card calendar-connect" aria-live="polite"><div id="calendar-connection">${loading()}</div></section>
    <section class="card calendar-controls" aria-label="Availability settings">
      <div class="calendar-controls-grid">
        <label>Date<div class="calendar-date-controls"><button class="icon-btn" type="button" data-date-step="-1" aria-label="Previous day">‹</button>
          <input id="calendar-date" type="date" value="${selectedDate}">
          <button class="icon-btn" type="button" data-date-step="1" aria-label="Next day">›</button></div></label>
        <label>Calendar timezone<input id="calendar-timezone" value="${esc(prefs.timezone ?? TZ)}" autocomplete="off" aria-describedby="calendar-timezone-help"></label>
        <label>Minimum time<select id="calendar-minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === (prefs.minimum ?? 30) ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
        <label>Available from<input id="calendar-from" type="time" value="${prefs.from ?? "08:00"}"></label>
        <label>Available until<input id="calendar-until" type="time" value="${prefs.until ?? "22:00"}"></label>
        <label>Campus location<select id="calendar-location"></select></label>
      </div>
      <p class="help" id="calendar-timezone-help">Defaulted to your browser timezone. If your Google Calendar uses a different timezone, enter its IANA name (for example, America/New_York). These settings are saved in this browser only.</p>
    </section>
    <section class="card calendar-results" aria-live="polite"><div id="calendar-results">${loading()}</div></section>`;

  const $connection = $view.querySelector("#calendar-connection");
  const $results = $view.querySelector("#calendar-results");
  const $date = $view.querySelector("#calendar-date");
  const $timezone = $view.querySelector("#calendar-timezone");
  const $minimum = $view.querySelector("#calendar-minimum");
  const $from = $view.querySelector("#calendar-from");
  const $until = $view.querySelector("#calendar-until");
  const $location = $view.querySelector("#calendar-location");

  try {
    [facilities, hours] = await Promise.all([src.listFacilities(), src.getHours()]);
    const options = facilities.filter((facility) => facility.data_mode !== "historical_playback");
    $location.innerHTML = options.map((facility) =>
      `<option value="${esc(facility.facility_id)}">${esc(facility.facility_name)}</option>`,
    ).join("");
    const dining = options.find((facility) => facility.category === "dining");
    if (options.some((facility) => facility.facility_id === prefs.location)) $location.value = prefs.location;
    else if (dining) $location.value = dining.facility_id;
  } catch (error) {
    $connection.innerHTML = failure(error);
    $results.textContent = "Campus schedules could not be loaded.";
    return {};
  }

  const savePrefs = () => src.store.set(PREFS_KEY, JSON.stringify({
    timezone: $timezone.value.trim(),
    minimum: Number($minimum.value),
    from: $from.value,
    until: $until.value,
    location: $location.value,
  }));

  const disconnectLocally = () => {
    connected = false;
    busy = [];
    requestId += 1;
    renderConnection();
    renderResults();
  };

  const queryBusy = async (id = ++requestId) => {
    if (!connected) return;
    $results.innerHTML = loading();
    try {
      const result = await src.calendarFreeBusy($date.value, $timezone.value.trim());
      if (id !== requestId) return;
      busy = result.busy;
      renderResults();
    } catch (error) {
      if (id !== requestId) return;
      busy = [];
      if (error.status === 401) {
        disconnectLocally();
        $connection.insertAdjacentHTML("beforeend", `<p class="calendar-error">${esc(error.message || "Reconnect Google Calendar.")}</p>`);
        return;
      }
      $results.innerHTML = `<p class="calendar-error">${esc(error.message || "Calendar availability could not be loaded.")}</p><button class="btn" type="button" data-calendar-retry>Retry</button>`;
    }
  };

  const renderConnection = () => {
    const returnedError = new URLSearchParams(location.search).get("calendar_error");
    if (!backendReachable) {
      $connection.innerHTML = `<h2>Google Calendar isn't available here</h2>
        <p>This version of BU-sy runs without its calendar server, so Google Calendar can't be connected. Campus hours below still work. No calendar data is being accessed.</p>
        <span class="pill">Not connected · no events shown</span>
        <p class="help">Running your own BU-sy server? Open the site with <code>?api=https://your-server</code>.</p>`;
    } else if (!configured) {
      $connection.innerHTML = `<h2>Google Calendar isn't set up on this server</h2>
        <p>The BU-sy server doesn't have Google sign-in configured, so Google Calendar can't be connected. Campus hours below still work. No calendar data is being accessed.</p>
        <span class="pill">Not connected · no events shown</span>`;
    } else if (connected) {
      $connection.innerHTML = `<h2>Google Calendar connected</h2>
        <p>Only busy/free times from your primary calendar are used. Event titles, descriptions, and guests are never requested or stored.</p>
        <div class="calendar-actions"><span class="pill">Connected · primary calendar</span>
          <button class="btn btn-secondary" type="button" data-calendar-disconnect>Disconnect</button></div>`;
    } else {
      const notice = returnedError ? `<p class="calendar-error">${returnedError === "denied"
        ? "Google Calendar access was declined. You can connect whenever you are ready."
        : "Google Calendar could not be connected. Please try again."}</p>` : "";
      $connection.innerHTML = `<h2>Connect Google Calendar</h2>
        <p>BU-sy will request read-only access to free/busy information for your primary calendar only. It will not read event titles or send calendar data to an AI service or other third party. Your authorization can be disconnected here or revoked in your Google Account.</p>
        ${notice}<div class="calendar-actions"><span class="pill">Not connected · no events shown</span>
          <button class="btn" type="button" data-calendar-connect>Connect Google Calendar</button></div>`;
    }
  };

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

    // Empty default calendar: no events at all, and no claim that the day is free.
    if (!connected) {
      $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
        <h3>Your day</h3>
        <ul class="calendar-timeline"><li class="calendar-interval" data-kind="unknown"><strong>No events shown</strong>
          <span>${range}</span><span>Schedule unknown</span></li></ul>
        <p class="help">Google Calendar isn't connected, so BU-sy doesn't know when you're busy or free.</p>
        <h3>Hours at ${locationName}</h3>
        ${locationHours ? hoursSummary(locationHours, matchingLocation?.category, $date.value) : `<p class="help">Hours for this location are unverified.</p>`}
        <p class="help">These are the location's published hours (campus time), not a recommendation for you. ${verifiedNote}</p>`;
      return;
    }

    const now = Date.now();
    const segments = daySegments(busy, start, end, minimum, now);
    const usable = usableWindows(freeWindows(busy, start, end), minimum, now);
    const total = usable.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const match = locationHours
      ? matchFreeWindows(usable, { ...locationHours, category: matchingLocation?.category }, $date.value, minimum)
      : { status: "unverified", matches: [] };
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
          <span>${durationLabel(interval.end - interval.start)} available · ${isDining ? `Serving ${esc(interval.label.toLowerCase())}` : "Location open"}</span></li>`,
      ).join("")}</ul>`;
    }
    $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
      <p class="calendar-total"><strong>${durationLabel(total) || "0 min"}</strong> usable free time (windows of ${minimum}+ min) during ${esc($from.value)}–${esc($until.value)} (${esc(zone)}).</p>
      <h3>Your day</h3>${timelineHtml}
      <p class="help">Events marked "Free" in Google Calendar, declined events, and most all-day events aren't counted as busy.</p>
      <h3>Time at ${locationName}</h3>${matchesHtml}
      <p class="help">Availability is based on free/busy only and does not include travel time. Confirm the trip fits your schedule. ${verifiedNote}</p>`;
  };

  const loadStatus = async () => {
    $connection.innerHTML = loading();
    try {
      const status = await src.calendarStatus();
      backendReachable = true;
      configured = !!status.configured;
      connected = !!status.connected;
      renderConnection();
      if (connected) await queryBusy();
      else renderResults();
    } catch {
      backendReachable = false;
      configured = false;
      connected = false;
      renderConnection();
      renderResults();
    }
  };

  $view.addEventListener("click", async (event) => {
    const connect = event.target.closest("[data-calendar-connect]");
    const disconnect = event.target.closest("[data-calendar-disconnect]");
    if (event.target.closest("[data-calendar-retry]")) {
      await queryBusy();
    } else if (connect) {
      connect.disabled = true;
      connect.textContent = "Connecting…";
      try {
        const result = await src.calendarConnect();
        window.location.assign(result.authorization_url);
      } catch (error) {
        connect.disabled = false;
        connect.textContent = "Connect Google Calendar";
        $connection.insertAdjacentHTML("beforeend", `<p class="calendar-error">${esc(error.message)}</p>`);
      }
    } else if (disconnect) {
      disconnect.disabled = true;
      try {
        await src.calendarDisconnect();
        disconnectLocally();
      } catch (error) {
        disconnect.disabled = false;
        if (error.status === 503 && error.message.startsWith("Disconnected from BU-sy")) disconnectLocally();
        $connection.insertAdjacentHTML("beforeend", `<p class="calendar-error">${esc(error.message)}</p>`);
      }
    } else {
      const step = event.target.closest("[data-date-step]");
      if (step) {
        $date.value = plusDays($date.value, Number(step.dataset.dateStep));
        if (connected) await queryBusy();
        else renderResults();
      }
    }
  });

  const refetch = () => { savePrefs(); if (connected) void queryBusy(); else renderResults(); };
  const rerender = () => { savePrefs(); renderResults(); };
  $date.addEventListener("change", () => { if (connected) void queryBusy(); else renderResults(); });
  $timezone.addEventListener("change", refetch);
  $minimum.addEventListener("change", rerender);
  $from.addEventListener("change", rerender);
  $until.addEventListener("change", rerender);
  $location.addEventListener("change", rerender);
  await loadStatus();
  return {};
}
