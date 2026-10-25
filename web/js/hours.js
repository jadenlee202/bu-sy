const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_ZONE = "America/New_York";

function dateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

export function campusDateTime(date = new Date()) {
  const parts = dateParts(date);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toLowerCase(),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekStart(isoDate) {
  const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return addDays(isoDate, -((weekday + 6) % 7));
}

export function dateLabel(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function scheduleFor(location, kind) {
  return kind === "service" ? location?.serviceHours : location?.buildingHours;
}

export function daySchedule(location, isoDate, kind = "building") {
  const schedule = scheduleFor(location, kind);
  if (!schedule || schedule.status === "not_applicable") {
    return { status: "not_applicable", periods: [] };
  }
  if (schedule.status !== "verified" || !schedule.weeklyHours) {
    return { status: "unverified", periods: [], reason: schedule.unverifiedReason };
  }

  const special = (schedule.specialHours ?? []).find((item) => item.date === isoDate);
  if (special) {
    return {
      status: special.status === "open" ? "scheduled" : special.status,
      periods: special.periods ?? [],
      note: special.note,
      special: true,
    };
  }
  // Outside the published dates the weekly pattern is assumed to repeat, unless the schedule
  // says it doesn't (repeatsWeekly: false). Special hours above still override any date.
  const assumed = isoDate < schedule.effectiveFrom || isoDate > schedule.effectiveThrough;
  if (assumed && schedule.repeatsWeekly === false) {
    return { status: "unpublished", periods: [] };
  }

  const weekday = DAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
  const periods = schedule.weeklyHours[weekday];
  if (!periods) return { status: "unverified", periods: [] };
  return { status: periods.length ? "scheduled" : "closed", periods, ...(assumed ? { assumed: true } : {}) };
}

export function displaySchedule(location, isoDate, category) {
  return daySchedule(location, isoDate, category === "dining" ? "service" : "building");
}

function timeValue(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

function periodIsActive(period, minute) {
  const start = timeValue(period.start);
  const end = timeValue(period.end);
  return end > start ? minute >= start && minute < end : minute >= start;
}

function overnightPeriodFrom(scheduleLocation, date, minute, kind) {
  const previous = daySchedule(scheduleLocation, addDays(date, -1), kind);
  return previous.periods.find((period) =>
    timeValue(period.end) <= timeValue(period.start) && minute < timeValue(period.end));
}

export function openStatus(location, now = new Date()) {
  const { date, minute } = campusDateTime(now);
  const today = daySchedule(location, date);
  if (today.status === "closed" && today.special) return { status: "closed" };
  const yesterdayOpen = today.special ? null : overnightPeriodFrom(location, date, minute, "building");
  if (yesterdayOpen) return { status: "open", period: yesterdayOpen };
  if (today.status !== "scheduled" && today.status !== "closed") return { status: today.status };

  const active = today.periods.find((period) => periodIsActive(period, minute));
  if (active) return { status: "open", period: active };

  const next = today.periods.find((period) => timeValue(period.start) > minute);
  return next ? { status: "opens", period: next } : { status: "closed" };
}

export function selectedBuildingStatus(location, date, minute) {
  const today = daySchedule(location, date);
  if (today.status === "closed") return { status: "closed" };
  if (today.status !== "scheduled") return { status: today.status };
  if (!today.special && overnightPeriodFrom(location, date, minute, "building")) return { status: "open" };
  return today.periods.some((period) => periodIsActive(period, minute))
    ? { status: "open" }
    : { status: "closed" };
}

export function serviceAtTime(location, date, minute) {
  const today = daySchedule(location, date, "service");
  if (today.status === "not_applicable") return { status: "not_applicable", periods: [] };
  // A meal status needs published meal hours for that date: an assumed repeat of the weekly
  // pattern is never shown as "Serving ...".
  if (today.status === "unverified" || today.status === "unpublished" || today.assumed) {
    return { status: today.assumed ? "unpublished" : today.status, periods: [] };
  }
  const yesterday = today.special ? null : overnightPeriodFrom(location, date, minute, "service");
  const periods = [
    ...(yesterday ? [yesterday] : []),
    ...(today.status === "scheduled" ? today.periods.filter((period) => periodIsActive(period, minute)) : []),
  ];
  return { status: periods.length ? "serving" : "none", periods };
}

export function formatClock(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatPeriod(period) {
  const start = timeValue(period.start);
  const end = timeValue(period.end);
  const overnight = end <= start;
  const ending = `${formatClock(period.end)}${overnight ? end === 0 ? " (midnight)" : " (next day)" : ""}`;
  return `${formatClock(period.start)}–${ending}`;
}

export function buildingHoursSummary(location, date) {
  const schedule = daySchedule(location, date);
  if (schedule.status === "unverified") return "Hours unverified";
  if (schedule.status === "unpublished") return "Today's hours not published";
  if (schedule.status === "closed") return "Closed today";
  if (schedule.status !== "scheduled") return "Hours unverified";
  const summary = schedule.periods.map((period) => formatPeriod(period)).join(" · ");
  return schedule.assumed ? `${summary} (assumed)` : summary;
}

export function todayBuildingHoursSummary(location, now = new Date()) {
  return buildingHoursSummary(location, campusDateTime(now).date);
}

// Status labels, the same on every screen:
//   "Open now" / "Closed now" / "Closed today" / "Hours unverified" describe the real current time;
//   "Open" / "Closed" describe a chosen time (the replay slider or a selected date), never "now";
//   meal service is separate: "Serving lunch", "No meal service currently scheduled", ….

/** Building status at a chosen date and time, e.g. the replay slider: "Open" or "Closed". */
export function selectedStatusLabel(status) {
  if (status.status === "open") return "Open";
  if (status.status === "closed") return "Closed";
  if (status.status === "unpublished") return "Building hours not published";
  return "Building hours unverified";
}

/** Meal service at the same moment as `buildingStatus`. Dining halls between meals stay open. */
export function serviceStatusLabel(service, buildingStatus) {
  if (["closed", "closed_today"].includes(buildingStatus.status)) return "No meal service — building closed";
  if (service.status === "unverified" || service.status === "unpublished") return "Meal hours unverified";
  if (service.status === "not_applicable") return "Food service not applicable";
  if (service.status === "serving") {
    // The meal's own published name (Breakfast, Brunch, Light lunch...), never relabelled.
    const labels = [...new Set(service.periods.map((period) => period.label.trim().toLowerCase()))];
    return `Serving ${labels.join(", ")}`;
  }
  return "No meal service currently scheduled";
}

/**
 * Building status at the real current time in Boston, from verified hours only. Days whose hours
 * are just the weekly pattern projected forward (`assumed`) are "unverified", never "Open now".
 * { status: "open" | "closed" | "closed_today" | "unverified", label, detail? }
 */
export function nowStatus(location, now = new Date()) {
  const { date } = campusDateTime(now);
  const today = daySchedule(location, date);
  if (today.assumed) return { status: "unverified", label: "Hours unverified", detail: "today's hours aren't published yet" };
  const current = openStatus(location, now);
  if (current.status === "open") return { status: "open", label: "Open now", detail: `until ${formatClock(current.period.end)}` };
  if (current.status === "opens") return { status: "closed", label: "Closed now", detail: `opens at ${formatClock(current.period.start)}` };
  if (current.status === "closed") {
    return today.status === "closed"
      ? { status: "closed_today", label: "Closed today" }
      : { status: "closed", label: "Closed now", detail: "closed for the rest of the day" };
  }
  return { status: "unverified", label: "Hours unverified" };
}

/** Meal service at the real current time, from verified service hours only (see nowStatus). */
export function nowServiceLabel(location, now = new Date()) {
  const { date, minute } = campusDateTime(now);
  const building = nowStatus(location, now);
  if (daySchedule(location, date, "service").assumed) return serviceStatusLabel({ status: "unpublished", periods: [] }, building);
  return serviceStatusLabel(serviceAtTime(location, date, minute), building);
}

/** "Open now · until 9:00 PM" */
export const nowText = (status) => (status.detail ? `${status.label} · ${status.detail}` : status.label);

export function weekRangeLabel(startDate) {
  const endDate = addDays(startDate, 6);
  const start = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" })
    .format(new Date(`${startDate}T12:00:00Z`));
  const end = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  }).format(new Date(`${endDate}T12:00:00Z`));
  return `${start}–${end}`;
}
