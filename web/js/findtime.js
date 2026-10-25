// "Find a time to eat" / "Find free time here" on a place's detail page. It reads the busy
// times from the schedule the student uploaded on the Calendar page (kept in this browser) and
// the place's verified hours in hours.json, for 7 days from a chosen date.
import { findOpportunities } from "./availability.js";
import { DEFAULT_TZ, durationLabel, formatInstant, loadCalendarPrefs, MIN_OPTIONS, saveCalendarPrefs } from "./calendar.js";
import { busyOf, loadSchedule } from "./schedule.js";
import { esc } from "./ui.js";

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
  not_covered: "Outside the dates your calendar covers",
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
  const head = `<h2>${dining ? "Find a time to eat" : "Find free time here"}</h2>`;
  const schedule = loadSchedule();
  if (!schedule) {
    $card.innerHTML = `${head}
      <p>Upload your class schedule (.ics) to find times in the next ${DAYS} days when you're free and ${name} is ${dining ? "serving a meal" : "open"}.</p>
      <p class="help">Your calendar file is read in this browser and never uploaded. No sign-in needed.</p>
      <a class="btn" href="#/calendar">Upload on the Calendar page</a>`;
    return;
  }

  const prefs = loadCalendarPrefs();
  const zone = prefs.timezone ?? DEFAULT_TZ;
  const today = todayIn(zone);
  let { from = "08:00", until = "22:00", minimum = 30 } = prefs;
  let startDate = today;
  let meal = "";

  $card.innerHTML = `${head}
    <div class="calendar-controls calendar-controls-grid">
      <label>Starting<input type="date" data-find="date" value="${startDate}"></label>
      ${dining ? `<label>Meal<select data-find="meal">${MEALS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>` : ""}
      <label>Minimum time<select data-find="minimum">${MIN_OPTIONS.map((minutes) => `<option value="${minutes}"${minutes === minimum ? " selected" : ""}>${minutes} minutes</option>`).join("")}</select></label>
      <label>Available from<input type="time" data-find="from" value="${from}"></label>
      <label>Available until<input type="time" data-find="until" value="${until}"></label>
    </div>
    <p class="help">Using your schedule from ${esc(schedule.fileName)} (${esc(zone)}). <a href="#/calendar">Replace or remove it on the Calendar page</a>.</p>
    <div data-find="results"></div>`;
  const $results = $card.querySelector('[data-find="results"]');

  const render = () => {
    if (!from || !until || until <= from) {
      $results.innerHTML = `<p class="calendar-error">Choose an "available until" time later than "available from".</p>`;
      return;
    }
    const { matches, outcomes } = findOpportunities(
      busyOf(schedule), { ...scheduleLocation, category: facility.category }, startDate, DAYS,
      { timezone: zone, from, until, minimum, now: Date.now(), meal: meal || null, coverage: schedule.coverage },
    );
    const what = dining ? `serving ${meal || "a meal"}` : "open";
    if (!matches.length) {
      $results.innerHTML = `<p>No time in these ${DAYS} days when you're free for at least ${minimum} minutes and ${name} is ${esc(what)}.</p>
        <ul class="calendar-matches">${outcomes.map(({ date, reason }) =>
          `<li><strong>${dayName(date, today)}</strong><span>${REASONS[reason] ?? "No match"}</span></li>`).join("")}</ul>
        <p class="help">Try another starting date, a shorter minimum${dining ? ", another meal" : ""}, wider hours, or another place.</p>`;
      return;
    }
    const [next, ...later] = matches;
    const range = (match) => `${formatInstant(match.start, zone)}–${formatInstant(match.end, zone)}`;
    const detail = (match) => `${durationLabel(match.end - match.start)} free · ${dining ? `Serving ${esc(match.label.toLowerCase())}` : "Open"}${match.assumed ? " · assumed hours" : ""}`;
    $results.innerHTML = `<h3>Your next opportunity${dining ? " to eat" : ""}</h3>
      <p class="calendar-total"><strong>${dayName(next.date, today)}, ${range(next)}</strong><br>
        ${durationLabel(next.end - next.start)} available. ${name} is open${dining ? ` and serving ${esc(next.label.toLowerCase())}` : ""} during this period${next.assumed ? " (assumed: repeats the published weekly hours)" : ""}.</p>
      ${later.length ? `<h3>Later</h3><ul class="calendar-matches">${later.slice(0, 4).map((match) =>
        `<li><strong>${dayName(match.date, today)}, ${range(match)}</strong><span>${detail(match)}</span></li>`).join("")}</ul>` : ""}
      <p class="help">Travel time isn't included. Based on your uploaded schedule and ${name}'s published hours (campus time).</p>`;
  };

  $card.addEventListener("change", (event) => {
    const field = event.target.dataset.find;
    const value = event.target.value;
    if (field === "date" && value) startDate = value;
    else if (field === "meal") meal = value;
    else if (field === "minimum") minimum = Number(value);
    else if (field === "from" && value) from = value;
    else if (field === "until" && value) until = value;
    else return;
    if (["minimum", "from", "until"].includes(field)) saveCalendarPrefs({ minimum, from, until });
    render();
  });
  render();
}
