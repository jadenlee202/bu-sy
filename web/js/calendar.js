import { freeWindows, matchFreeWindows, normalizeBusy, zonedInstant } from "./availability.js";
import * as src from "./source.js";
import { esc, failure, loading } from "./ui.js";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
const MIN_OPTIONS = [15, 30, 45, 60];
const dateInputValue = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const formatInstant = (timestamp, timezone) => new Intl.DateTimeFormat("en-US", {
  timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(timestamp));
const durationLabel = (milliseconds) => {
  const minutes = Math.round(milliseconds / 60_000);
  return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} hr ` : ""}${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
};
const dateLabel = (isoDate) => new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
}).format(new Date(`${isoDate}T12:00:00Z`));

export async function calendarView($view) {
  const timezone = TZ;
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
        <label>Calendar timezone<input id="calendar-timezone" value="${esc(timezone)}" autocomplete="off" aria-describedby="calendar-timezone-help"></label>
        <label>Minimum time<select id="calendar-minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === 30 ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
        <label>Available from<input id="calendar-from" type="time" value="08:00"></label>
        <label>Available until<input id="calendar-until" type="time" value="22:00"></label>
        <label>Campus location<select id="calendar-location"></select></label>
      </div>
      <p class="help" id="calendar-timezone-help">Defaulted to your browser timezone. If your Google Calendar uses a different timezone, enter its IANA name (for example, America/New_York).</p>
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
    if (dining) $location.value = dining.facility_id;
  } catch (error) {
    $connection.innerHTML = failure(error);
    $results.textContent = "Campus schedules could not be loaded.";
    return {};
  }

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
      if (error.status === 401) {
        connected = false;
        renderConnection();
      }
      $results.innerHTML = `<p class="calendar-error">${esc(error.message || "Calendar availability could not be loaded.")}</p><button class="btn" type="button" data-calendar-retry>Retry</button>`;
    }
  };

  const renderConnection = () => {
    const returnedError = new URLSearchParams(location.search).get("calendar_error");
    if (!backendReachable) {
      $connection.innerHTML = `<h2>Calendar service unavailable</h2>
        <p>BU-sy could not reach its calendar API. Set the backend URL with the site's <code>?api=</code> option and check that the server is running.</p>`;
    } else if (!configured) {
      $connection.innerHTML = `<h2>Google Calendar is not connected</h2>
        <p>This page is static. A configured BU-sy API server is required to securely connect Google Calendar. No calendar data is being accessed.</p>
        <span class="pill">Backend not configured</span>`;
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
        ${notice}<button class="btn" type="button" data-calendar-connect>Connect Google Calendar</button>`;
    }
  };

  const renderResults = () => {
    if (!connected) {
      $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2><p>Connect Google Calendar to view your schedule and free-time windows. Without access, no calendar data or availability is displayed.</p>`;
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
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
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
    const mergedBusy = normalizeBusy(busy, start, end);
    const free = freeWindows(busy, start, end);
    const total = free.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const minimum = Number($minimum.value);
    const matchingLocation = facilities.find((facility) => facility.facility_id === $location.value);
    const locationHours = hours.locations[$location.value];
    const match = locationHours
      ? matchFreeWindows(free, { ...locationHours, category: matchingLocation?.category }, $date.value, minimum)
      : { status: "unverified", matches: [] };
    const timeline = [...mergedBusy.map((interval) => ({ ...interval, kind: "Busy" })),
      ...free.map((interval) => ({ ...interval, kind: "Available" }))].sort((a, b) => a.start - b.start);
    const timelineHtml = timeline.length ? `<ul class="calendar-timeline">${timeline.map((interval) =>
      `<li class="calendar-interval" data-kind="${interval.kind.toLowerCase()}"><strong>${interval.kind}</strong>
        <span>${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)}</span>
        <span>${durationLabel(interval.end - interval.start)}</span></li>`,
    ).join("")}</ul>` : `<p>No busy events or free intervals in this preferred availability window.</p>`;
    let matchesHtml;
    if (match.status === "unverified" || match.status === "unpublished" || match.status === "not_applicable") {
      matchesHtml = `<p class="help">Location hours are ${match.status === "unpublished" ? "not published for this date" : "unverified"}; BU-sy will not recommend a visit using unconfirmed hours.</p>`;
    } else if (!match.matches.length) {
      matchesHtml = `<p>No free interval of at least ${minimum} minutes overlaps verified ${matchingLocation?.category === "dining" ? "building and meal-service hours" : "building hours"} for this location.</p>`;
    } else {
      matchesHtml = `<ul class="calendar-matches">${match.matches.map((interval) =>
        `<li><strong>${formatInstant(interval.start, zone)}–${formatInstant(interval.end, zone)}</strong>
          <span>${durationLabel(interval.end - interval.start)} available · ${matchingLocation?.category === "dining" ? `Serving ${esc(interval.label.toLowerCase())}` : "Location open"}</span></li>`,
      ).join("")}</ul>`;
    }
    $results.innerHTML = `<h2>${esc(dateLabel($date.value))}</h2>
      <p class="calendar-total"><strong>${durationLabel(total) || "0 min"}</strong> free during ${esc($from.value)}–${esc($until.value)} (${esc(zone)}).</p>
      <h3>Your day</h3>${timelineHtml}
      <h3>Time at ${esc(matchingLocation?.facility_name ?? "campus location")}</h3>${matchesHtml}
      <p class="help">Availability is based on free/busy only and does not estimate travel time. Confirm the trip fits your schedule. ${locationHours?.lastVerified ? `Location hours last verified ${esc(locationHours.lastVerified)}.` : ""}</p>`;
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
        connected = false;
        busy = [];
        renderConnection();
        renderResults();
      } catch (error) {
        disconnect.disabled = false;
        if (error.status === 503 && error.message.startsWith("Disconnected from BU-sy")) {
          connected = false;
          renderConnection();
          renderResults();
        }
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

  $date.addEventListener("change", () => { if (connected) void queryBusy(); else renderResults(); });
  $timezone.addEventListener("change", () => { if (connected) void queryBusy(); else renderResults(); });
  $minimum.addEventListener("change", renderResults);
  $from.addEventListener("change", renderResults);
  $until.addEventListener("change", renderResults);
  $location.addEventListener("change", renderResults);
  await loadStatus();
  return {};
}
