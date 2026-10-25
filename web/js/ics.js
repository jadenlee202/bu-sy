// Reads an uploaded .ics (iCalendar) file in the browser and turns it into busy intervals.
// Only start and end instants leave this module: event titles, descriptions, locations and
// attendees are never read. Parsing and recurrence expansion use ical.js (Mozilla, MPL-2.0),
// vendored in web/vendor/ because the site has no build step.
import ICAL from "../vendor/ical.js";
import { zonedInstant } from "./availability.js";

export const CAMPUS_TZ = "America/New_York";
const MAX_OCCURRENCES = 20_000;   // across the whole file, inside the requested range
const MAX_STEPS = 50_000;         // recurrence steps for one event, including ones before the range
const INVALID_RULE = "X-BUSY-INVALID-RRULE";

/** A file that can't be used at all. `code` is one of: empty, not_ics, malformed, too_large. */
export class IcsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class SkipEvent extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * A wall-clock time in an IANA zone as epoch ms. A time skipped by a DST change uses the offset
 * from before the change (RFC 5545), so 2:30 AM on spring-forward day becomes 3:30 AM.
 */
function wallClock(time, zone) {
  const date = `${time.year}-${pad(time.month)}-${pad(time.day)}`;
  const seconds = (time.second ?? 0) * 1000;
  try {
    return zonedInstant(date, `${pad(time.hour)}:${pad(time.minute)}`, zone) + seconds;
  } catch {
    return zonedInstant(date, `${pad(time.hour + 1)}:${pad(time.minute)}`, zone) + seconds;
  }
}

/**
 * Unfolds continuation lines and renames repeat rules ical.js can't read, so one bad RRULE
 * skips its own event instead of failing the whole file.
 */
function prepare(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(RRULE|EXRULE)([;:])/i.exec(line);
      if (!match) return line;
      try {
        ICAL.Recur.fromString(line.slice(line.indexOf(":") + 1));
        return line;
      } catch {
        return `${INVALID_RULE}${line.slice(match[1].length)}`;
      }
    })
    .join("\r\n");
}

function checkFile(text) {
  if (typeof text !== "string" || !text.trim()) throw new IcsError("empty", "The file is empty.");
  if (text.includes("\u0000")) throw new IcsError("not_ics", "This isn't a calendar file: it contains binary data.");
  const first = text.replace(/^﻿/, "").trimStart().split(/\r?\n/, 1)[0].trim();
  if (first.toUpperCase() !== "BEGIN:VCALENDAR") {
    throw new IcsError("not_ics", "This isn't an iCalendar (.ics) file: it doesn't start with BEGIN:VCALENDAR.");
  }
}

const isFree = (component) =>
  String(component.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT"
  || String(component.getFirstPropertyValue("x-microsoft-cdo-busystatus") ?? "").toUpperCase() === "FREE";
const isCancelled = (component) => String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

/**
 * Parses calendar text and returns the busy intervals that overlap [from, until) (epoch ms).
 * Times with a TZID use that zone (an IANA name, or the file's own VTIMEZONE definition),
 * UTC times stay UTC, and floating times and all-day dates use `defaultZone`.
 * Cancelled events, cancelled or excluded occurrences, and events marked free aren't busy.
 * Events without a usable start, end or timezone are skipped and counted in `skipped` by reason
 * (see SKIP_REASONS in schedule.js), never guessed.
 * Throws IcsError when the file itself can't be used.
 */
export function parseIcs(text, { from, until, defaultZone = CAMPUS_TZ }) {
  checkFile(text);
  let roots;
  try {
    const jcal = ICAL.parse(prepare(text));
    roots = (Array.isArray(jcal[0]) ? jcal : [jcal]).map((data) => new ICAL.Component(data));
  } catch {
    throw new IcsError("malformed", "The calendar file is malformed and couldn't be read.");
  }
  if (!roots.length || roots.some((root) => root.name !== "vcalendar")) {
    throw new IcsError("not_ics", "This isn't an iCalendar (.ics) file.");
  }

  const zones = new Map();
  for (const component of roots.flatMap((root) => root.getAllSubcomponents("vtimezone"))) {
    const tzid = component.getFirstPropertyValue("tzid");
    if (tzid) zones.set(tzid, new ICAL.Timezone({ component, tzid }));
  }
  const vevents = roots.flatMap((root) => root.getAllSubcomponents("vevent"));
  const result = {
    vevents: vevents.length, events: 0, occurrences: 0, cancelled: 0, free: 0,
    skipped: {}, truncated: false, openEnded: false, busy: [],
  };
  const skip = (reason) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };

  const toMs = (time, tzid) => {
    if (time.isDate) return zonedInstant(`${time.year}-${pad(time.month)}-${pad(time.day)}`, "00:00", defaultZone);
    if (time.zone === ICAL.Timezone.utcTimezone) return time.toUnixTime() * 1000;
    if (!tzid) return wallClock(time, defaultZone);
    if (validTimeZone(tzid)) return wallClock(time, tzid);
    const vtimezone = zones.get(tzid);
    if (vtimezone) {
      const local = time.clone();
      local.zone = vtimezone;
      return local.toUnixTime() * 1000;
    }
    // Some exporters prefix an IANA name, e.g. "/mozilla.org/20050126_1/America/New_York".
    const parts = tzid.split("/").filter(Boolean);
    const tail = parts.map((_, index) => parts.slice(index).join("/")).find((name) => name.includes("/") && validTimeZone(name));
    if (tail) return wallClock(time, tail);
    throw new SkipEvent("timezone");
  };
  const tzidOf = (component, name) => component.getFirstProperty(name)?.getParameter("tzid") ?? null;
  // Where an item's end is written: its own DTEND, or (with DURATION) its start's zone.
  const endZone = (component) => (component.hasProperty("dtend") ? tzidOf(component, "dtend") : tzidOf(component, "dtstart"));
  const checkTimes = (component) => {
    if (!component.hasProperty("dtstart")) throw new SkipEvent("no_start");
    if (!component.hasProperty("dtend") && !component.hasProperty("duration")) throw new SkipEvent("no_end");
  };

  // Recurrence exceptions (RECURRENCE-ID) belong to the series with the same UID.
  const exceptions = new Map();
  const series = [];
  for (const component of vevents) {
    const uid = component.getFirstPropertyValue("uid");
    if (component.hasProperty("recurrence-id") && uid) {
      if (!exceptions.has(uid)) exceptions.set(uid, []);
      exceptions.get(uid).push(component);
    } else {
      series.push(component);
    }
  }
  const masters = new Set(series.map((component) => component.getFirstPropertyValue("uid")).filter(Boolean));
  // An exception whose series isn't in the file is a one-off event of its own.
  for (const [uid, list] of exceptions) if (!masters.has(uid)) series.push(...list);

  // Registered only while parsing, so ical.js can match exceptions and exclusions written in
  // another zone. Any definition already registered under the same name is put back afterwards.
  const replaced = new Map();
  for (const [tzid, zone] of zones) {
    replaced.set(tzid, ICAL.TimezoneService.get(tzid));
    ICAL.TimezoneService.register(zone, tzid);
  }
  try {
    for (const component of series) {
      if (isCancelled(component)) { result.cancelled += 1; continue; }
      if (isFree(component)) { result.free += 1; continue; }
      const found = [];
      try {
        checkTimes(component);
        if (component.hasProperty(INVALID_RULE.toLowerCase())) throw new SkipEvent("recurrence");
        const uid = component.getFirstPropertyValue("uid");
        const related = component.hasProperty("recurrence-id") ? [] : exceptions.get(uid) ?? [];
        related.forEach(checkTimes);
        const event = new ICAL.Event(component, { strictExceptions: true, exceptions: related });
        const startZone = tzidOf(component, "dtstart");
        const add = (start, end) => {
          if (end <= start) throw new SkipEvent("bad_range");
          if (end > from && start < until) found.push({ start, end });
        };

        if (!event.isRecurring()) {
          add(toMs(event.startDate, startZone), toMs(event.endDate, endZone(component)));
        } else {
          const rules = component.getAllProperties("rrule").map((prop) => prop.getFirstValue());
          if (rules.some((rule) => !rule.until && !rule.count)) result.openEnded = true;
          const iterator = event.iterator();
          let steps = 0;
          for (let next = iterator.next(); next; next = iterator.next()) {
            if (toMs(next, startZone) >= until) break;
            if ((steps += 1) > MAX_STEPS) { result.truncated = true; break; }
            const details = event.getOccurrenceDetails(next);
            const item = details.item.component;
            if (isCancelled(item)) { result.cancelled += 1; continue; }
            if (item !== component && isFree(item)) continue;
            // A plain occurrence is the series start moved by the rule, so its end is in the start's zone.
            add(
              toMs(details.startDate, tzidOf(item, "dtstart")),
              toMs(details.endDate, item === component ? startZone : endZone(item)),
            );
          }
        }
      } catch (error) {
        skip(error instanceof SkipEvent ? error.reason
          : /recur|BYDAY|BYMONTHDAY|BYYEARDAY|BYWEEKNO|occurrence/i.test(error?.message ?? "") ? "recurrence" : "unreadable");
        continue;
      }
      result.events += 1;
      for (const range of found) {
        if (result.occurrences >= MAX_OCCURRENCES) { result.truncated = true; break; }
        result.busy.push(range);
        result.occurrences += 1;
      }
    }
  } finally {
    for (const [tzid, previous] of replaced) {
      ICAL.TimezoneService.remove(tzid);
      if (previous) ICAL.TimezoneService.register(previous, tzid);
    }
  }
  result.busy.sort((a, b) => a.start - b.start);
  return result;
}
