// "Find a time to eat" / "Find free time here" on a place's detail page. It reads the
// student's free/busy for the next 7 days (only when Google Calendar is connected) and the
// place's verified hours in hours.json, using the window and timezone saved on the Calendar page.
import { findOpportunities } from "./availability.js";
import { durationLabel, formatInstant, loadCalendarPrefs, MIN_OPTIONS, TZ } from "./calendar.js";
import * as src from "./source.js";
import { esc, loading } from "./ui.js";

const DAYS = 7;
const MEALS = [["", "Any meal"], ["breakfast", "Breakfast"], ["brunch", "Brunch"], ["lunch", "Lunch"], ["dinner", "Dinner"]];
const REASONS = {
  match: "Matches found",
  past: "Your window has already passed",
  no_free_time: "No free window long enough",
  closed: "Closed",
  closed_when_free: "Not open while you're free",
  meal_not_served: "That meal isn't served while you're free",
  unpublished: "Hours not published",
  unverified: "Hours unverified",
  not_applicable: "No hours on file",
  invalid_window: "Your availability hours don't exist on this date",
};
const todayIn = (zone) => new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const dayName = (isoDate, today) => {
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (isoDate === today) return "Today";
  if (isoDate === tomorrow.toISOString().slice(0, 10)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" })
    .format(new Date(`${isoDate}T12:00:00Z`));
};

export async function findTimeCard($card, facility, scheduleLocation) {
  const dining = facility.category === "dining";
  const name = esc(facility.facility_name);
  const prefs = loadCalendarPrefs();
  const zone = prefs.timezone ?? TZ;
  const from = prefs.from ?? "08:00";
  const until = prefs.until ?? "22:00";
  let minimum = prefs.minimum ?? 30;
  let meal = "";
  let busy = null;
  let startDate = todayIn(zone);
  const head = `<h2>${dining ? "Find a time to eat" : "Find free time here"}</h2>`;

  $card.innerHTML = head + loading("Checking your calendar connection…");
  let status = null;
  try {
    status = await src.calendarStatus();
  } catch {
    // No calendar API on this deployment: handled below like "not connected".
  }
  if (!status?.connected) {
    $card.innerHTML = `${head}
      <p>Connect Google Calendar to find times in the next ${DAYS} days when you're free and ${name} is ${dining ? "serving a meal" : "open"}.</p>
      <p class="help">${!status ? "Google Calendar isn't available on this version of BU-sy."
        : !status.configured ? "Google Calendar isn't set up on this BU-sy server."
        : "Only free/busy times are used. Event titles and details are never read."}</p>
      ${status?.configured ? `<a class="btn" href="#/calendar">Connect on the Calendar page</a>` : ""}`;
    return;
  }

  $card.innerHTML = `${head}
    <div class="calendar-controls calendar-controls-grid">
      ${dining ? `<label>Meal<select data-find="meal">${MEALS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>` : ""}
      <label>Minimum time<select data-find="minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === minimum ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
    </div>
    <p class="help">Using your availability window ${esc(from)}–${esc(until)} (${esc(zone)}). <a href="#/calendar">Change it on the Calendar page</a>.</p>
    <div data-find="results">${loading()}</div>`;
  const $results = $card.querySelector('[data-find="results"]');

  const render = () => {
    const { matches, outcomes } = findOpportunities(
      busy, { ...scheduleLocation, category: facility.category }, startDate, DAYS,
      { timezone: zone, from, until, minimum, now: Date.now(), meal: meal || null },
    );
    const what = dining ? `serving ${meal || "a meal"}` : "open";
    if (!matches.length) {
      $results.innerHTML = `<p>No time in the next ${DAYS} days when you're free for at least ${minimum} minutes and ${name} is ${esc(what)}.</p>
        <ul class="calendar-matches">${outcomes.map(({ date, reason }) =>
          `<li><strong>${dayName(date, startDate)}</strong><span>${REASONS[reason] ?? "No match"}</span></li>`).join("")}</ul>
        <p class="help">Try a shorter minimum${dining ? ", another meal" : ""}, or wider hours on the Calendar page.</p>`;
      return;
    }
    const [next, ...later] = matches;
    const range = (match) => `${formatInstant(match.start, zone)}–${formatInstant(match.end, zone)}`;
    const assumed = (match) => (match.assumed ? " · assumed hours" : "");
    const detail = (match) => `${durationLabel(match.end - match.start)} free · ${dining ? `Serving ${esc(match.label.toLowerCase())}` : "Open"}${assumed(match)}`;
    $results.innerHTML = `<h3>Your next opportunity${dining ? " to eat" : ""}</h3>
      <p class="calendar-total"><strong>${dayName(next.date, startDate)}, ${range(next)}</strong><br>
        You have ${durationLabel(next.end - next.start)} available. ${name} is open${dining ? ` and serving ${esc(next.label.toLowerCase())}` : ""}${next.assumed ? " (assumed: repeats the published weekly hours)" : ""}.</p>
      ${later.length ? `<h3>Later</h3><ul class="calendar-matches">${later.slice(0, 4).map((match) =>
        `<li><strong>${dayName(match.date, startDate)}, ${range(match)}</strong><span>${detail(match)}</span></li>`).join("")}</ul>` : ""}
      <p class="help">Travel time is not included. Based on your free/busy times and ${name}'s published hours (campus time).</p>`;
  };

  const load = async () => {
    $results.innerHTML = loading();
    startDate = todayIn(zone);
    try {
      busy = (await src.calendarFreeBusy(startDate, zone, DAYS)).busy;
      render();
    } catch (error) {
      busy = null;
      $results.innerHTML = error.status === 401
        ? `<p class="calendar-error">${esc(error.message || "Reconnect Google Calendar.")}</p><a class="btn" href="#/calendar">Reconnect on the Calendar page</a>`
        : `<p class="calendar-error">${esc(error.message || "Calendar availability could not be loaded.")}</p><button class="btn" type="button" data-find="retry">Retry</button>`;
    }
  };

  $card.addEventListener("change", (event) => {
    const field = event.target.dataset.find;
    if (field === "meal") meal = event.target.value;
    else if (field === "minimum") minimum = Number(event.target.value);
    else return;
    if (busy) render();
  });
  $card.addEventListener("click", (event) => {
    if (event.target.closest('[data-find="retry"]')) void load();
  });
  await load();
}
