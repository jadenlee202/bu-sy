import { daySchedule } from "./hours.js";

const plusDays = (isoDate, amount) => {
  const day = new Date(`${isoDate}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
};
const clockParts = (isoDate, hhmm) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  return { year, month, day, hour, minute };
};

export function zonedInstant(isoDate, hhmm, timezone) {
  const target = clockParts(isoDate, hhmm);
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let timestamp = targetUtc;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    const representedUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute),
    );
    const difference = targetUtc - representedUtc;
    if (difference === 0) return timestamp;
    timestamp += difference;
  }
  const actual = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  if (Number(actual.year) !== target.year || Number(actual.month) !== target.month
    || Number(actual.day) !== target.day || Number(actual.hour) !== target.hour
    || Number(actual.minute) !== target.minute) {
    throw new RangeError("That local time does not exist because of a daylight-saving change.");
  }
  return timestamp;
}

export function normalizeBusy(busy, start, end) {
  const ranges = busy
    .map(({ start: from, end: to }) => ({
      start: Math.max(start, typeof from === "number" ? from : Date.parse(from)),
      end: Math.min(end, typeof to === "number" ? to : Date.parse(to)),
    }))
    .filter(({ start: from, end: to }) => Number.isFinite(from) && Number.isFinite(to) && from < to)
    .sort((a, b) => a.start - b.start);
  return ranges.reduce((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

export function freeWindows(busy, start, end) {
  let cursor = start;
  const free = [];
  for (const range of normalizeBusy(busy, start, end)) {
    if (cursor < range.start) free.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free;
}

function periodInstants(isoDate, period, timezone) {
  const start = zonedInstant(isoDate, period.start, timezone);
  const endDate = period.end <= period.start ? plusDays(isoDate, 1) : isoDate;
  const end = zonedInstant(endDate, period.end, timezone);
  return end > start ? { start, end } : null;
}

/** Free windows a student can still use: not already past and at least `minimum` minutes long. */
export function usableWindows(free, minimum, notBefore = -Infinity) {
  return free
    .map(({ start, end }) => ({ start: Math.max(start, notBefore), end }))
    .filter(({ start, end }) => end - start >= minimum * 60_000);
}

/**
 * The day's timeline: merged busy blocks plus each gap labelled "available" (usable),
 * "short" (under the minimum) or "past" (already over), in start order.
 */
export function daySegments(busy, start, end, minimum, now = -Infinity) {
  const free = freeWindows(busy, start, end).flatMap(({ start: from, end: to }) => {
    if (to <= now) return [{ start: from, end: to, kind: "past" }];
    const past = from < now ? [{ start: from, end: now, kind: "past" }] : [];
    const rest = { start: Math.max(from, now), end: to };
    return [...past, { ...rest, kind: rest.end - rest.start >= minimum * 60_000 ? "available" : "short" }];
  });
  return [...normalizeBusy(busy, start, end).map((range) => ({ ...range, kind: "busy" })), ...free]
    .sort((a, b) => a.start - b.start);
}

// The selected day plus its neighbours: a period that runs past midnight, or a free window
// in a timezone ahead of or behind campus, can fall on an adjacent campus date.
function scheduledRanges(location, isoDate, kind, campusTimezone) {
  return [-1, 0, 1].flatMap((offset) => {
    const date = plusDays(isoDate, offset);
    const schedule = daySchedule(location, date, kind);
    if (schedule.status !== "scheduled") return [];
    return schedule.periods.map((period) => {
      const range = periodInstants(date, period, campusTimezone);
      return range && { ...range, label: period.label };
    }).filter(Boolean);
  });
}

export function matchFreeWindows(free, location, isoDate, minimum, campusTimezone = "America/New_York") {
  const building = daySchedule(location, isoDate, "building");
  if (building.status !== "scheduled") return { status: building.status, matches: [] };
  const buildingRanges = scheduledRanges(location, isoDate, "building", campusTimezone);
  if (location.category === "dining") {
    const service = daySchedule(location, isoDate, "service");
    if (service.status !== "scheduled") return { status: service.status, matches: [] };
    const services = scheduledRanges(location, isoDate, "service", campusTimezone).flatMap((range) =>
      buildingRanges.map((open) => ({
        start: Math.max(range.start, open.start),
        end: Math.min(range.end, open.end),
        label: range.label,
      })).filter(({ start, end }) => start < end));
    return { status: "scheduled", matches: intersect(free, services, minimum) };
  }
  return {
    status: "scheduled",
    matches: intersect(free, buildingRanges.map((range) => ({ ...range, label: "Open" })), minimum),
  };
}

/**
 * Search `days` local dates from `startDate` for times the student is free and the location is
 * open (and, for dining, serving `meal` when given). Returns every match in order plus each
 * day's outcome, so a caller can explain why nothing was found.
 */
export function findOpportunities(busy, location, startDate, days, options) {
  const { timezone, from, until, minimum, now = -Infinity, meal = null } = options;
  const outcomes = [];
  const matches = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = plusDays(startDate, offset);
    let start;
    let end;
    try {
      start = zonedInstant(date, from, timezone);
      end = zonedInstant(date, until, timezone);
    } catch {
      outcomes.push({ date, reason: "invalid_window" });
      continue;
    }
    const usable = end > start ? usableWindows(freeWindows(busy, start, end), minimum, now) : [];
    if (!usable.length) {
      outcomes.push({ date, reason: end <= now ? "past" : "no_free_time" });
      continue;
    }
    const result = matchFreeWindows(usable, location, date, minimum);
    const found = result.matches.filter(({ label }) => !meal || label.toLowerCase().includes(meal));
    if (result.status !== "scheduled") outcomes.push({ date, reason: result.status });
    else if (!found.length) outcomes.push({ date, reason: meal ? "meal_not_served" : "closed_when_free" });
    else outcomes.push({ date, reason: "match" });
    matches.push(...found.map((match) => ({ ...match, date })));
  }
  return { matches, outcomes };
}

function intersect(free, service, minimum) {
  const matches = [];
  for (const available of free) {
    for (const period of service) {
      const start = Math.max(available.start, period.start);
      const end = Math.min(available.end, period.end);
      if (end - start >= minimum * 60_000) matches.push({ start, end, label: period.label });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
