// Data adapter. Two interchangeable backends with the same response shapes:
//   api    - server/main.py (same origin, or ?api=https://host for another one)
//   static - web/data/*.json written by server/export_static.py (GitHub Pages);
//            community events, clubs and club sign-ups are then kept in this
//            browser's localStorage (this device only).
// Swap in a real campus feed by changing the server, not the screens.
// Both modes serve the same synthetic/historical data with its own labels;
// neither is ever presented as live.
import { THRESHOLD_NOTE, classify, meanOver } from "./clock.js";

/** The API asked for with ?api=https://host, or null for "same origin if present". */
export const REQUESTED_API = new URLSearchParams(location.search).get("api")?.replace(/\/$/, "") || null;
const API_BASE = REQUESTED_API ? `${REQUESTED_API}/api` : "api";
const CALENDAR_API = `${API_BASE}/calendar`;

export class SourceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJSON(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new SourceError(0, "Can't reach the data source. Check your connection.");
  }
  if (res.status === 404) {
    const path = new URL(url, location.href).pathname;
    const dataPath = path.slice(path.lastIndexOf("/data/") + 1);
    const isDataFile = dataPath !== path;
    throw new SourceError(
      404,
      `${isDataFile ? "Required data file" : "Data endpoint"} not found: ${isDataFile ? dataPath : path}`,
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = typeof body.detail === "string" ? body.detail
      : Array.isArray(body.detail) ? String(body.detail[0]?.msg ?? "Invalid input").replace(/^Value error, /, "")
      : "Request failed";
    throw new SourceError(res.status, detail);
  }
  return res.status === 204 ? null : res.json();
}

let modePromise;
export function getMode() {
  modePromise ??= fetch(`${API_BASE}/facilities?at=12:00`, { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? "api" : "static"))
    .catch(() => "static");
  return modePromise;
}

// ---------- facilities ----------
const historyCache = new Map();

export async function listFacilities() {
  return (await getMode()) === "api"
    ? getJSON(`${API_BASE}/facilities?at=12:00`)
    : getJSON("data/facilities.json");
}

/** One recorded day; `day` ("YYYY-MM-DD") must be one of the history's playback_days. */
export async function getHistory(id, day = null) {
  const key = `${id}|${day ?? ""}`;
  if (!historyCache.has(key)) {
    const path = encodeURIComponent(id);
    const url = (await getMode()) === "api"
      ? `${API_BASE}/facilities/${path}/history${day ? `?date=${encodeURIComponent(day)}` : ""}`
      : `data/history/${path}${day ? `/${encodeURIComponent(day)}` : ""}.json`;  // only exported playback days
    historyCache.set(key, getJSON(url).catch((e) => {
      historyCache.delete(key);
      throw e;
    }));
  }
  return historyCache.get(key);
}

// ---------- simulation provenance (Sources & Simulation page) ----------
let sourcesPromise;
export function getSources() {
  sourcesPromise ??= getMode()
    .then((mode) => getJSON(mode === "api" ? `${API_BASE}/sources` : "data/sources.json"))
    .catch((e) => {
      sourcesPromise = null;
      throw e;
    });
  return sourcesPromise;
}

// ---------- planner data ----------
// Same normalized payload in both modes (server/campus.py), so the planner
// engine (recommend.js) sees identical input with or without a server.
let campusPromise;
export function getCampus() {
  campusPromise ??= getMode()
    .then((mode) => getJSON(mode === "api" ? `${API_BASE}/campus` : "data/campus.json"))
    .catch((e) => {
      campusPromise = null;
      throw e;
    });
  return campusPromise;
}

let hoursPromise;
export function getHours() {
  hoursPromise ??= getJSON("data/hours.json").catch((e) => {
    hoursPromise = null;
    throw e;
  });
  return hoursPromise;
}

export async function calendarStatus() {
  return getJSON(`${CALENDAR_API}/status`, { credentials: "include" });
}

export async function calendarConnect() {
  return getJSON(`${CALENDAR_API}/connect`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ return_url: location.href }),
  });
}

export async function calendarFreeBusy(date, timezone, days = 1) {
  return getJSON(`${CALENDAR_API}/freebusy`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, timezone, days }),
  });
}

export async function calendarDisconnect() {
  return getJSON(`${CALENDAR_API}/disconnect`, {
    method: "DELETE",
    credentials: "include",
  });
}

// ---------- per-device identity (anonymous) ----------
// crypto.randomUUID only exists on https or localhost; a phone opening the demo
// at http://<laptop-ip> still needs an ID, so fall back to getRandomValues.
const uuid = () => crypto.randomUUID?.()
  ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
    .replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");

export const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: keep in memory only */ }
  },
};

const memoryToken = uuid();
export function deviceToken() {
  let token = store.get("busy.token");
  if (!token) {
    token = memoryToken;
    store.set("busy.token", token);
  }
  return token;
}
export const savedName = () => store.get("busy.name") || "";
export const saveName = (name) => store.set("busy.name", name);

// ---------- community events ----------
const TZ = "America/New_York";
export function campusNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map(({ type, value }) => [type, value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// ---------- meetup rules (mirrors server/community_events.py) ----------
// Static mode keeps meetups in this browser only: nobody else can see or join
// them, so invite codes there are a local simulation, not access control.
export const LIMITS = { title: 60, place: 60, note: 80, host: 30, name: 30, code: 16, minSpots: 2, maxAttendees: 200, daysAhead: 60 };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const inviteCode = () => {
  const c = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % 32]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const ended = (e, now) => `${e.date}T${e.end}` <= `${now.date}T${now.time}`;

/** Same checks as the server's NewEvent; returns a message or null. */
export function eventProblem(d, now = campusNow()) {
  for (const k of ["title", "place", "host"]) if (!String(d[k] ?? "").trim()) return "Please fill in what, where and your name.";
  for (const k of ["title", "place", "note", "host"]) {
    const v = String(d[k] ?? "").trim();
    if (v.length > LIMITS[k]) return `${k[0].toUpperCase()}${k.slice(1)} is too long (max ${LIMITS[k]}).`;
    if (CONTROL.test(v)) return "Please remove line breaks and special characters.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date ?? "") || !HHMM.test(d.start ?? "") || !HHMM.test(d.end ?? "")) return "Please pick a date, start and end.";
  if (d.end <= d.start) return "End time needs to be after the start.";
  if (`${d.date}T${d.end}` <= `${now.date}T${now.time}`) return "That time has already passed.";
  if (d.date > addDays(now.date, LIMITS.daysAhead)) return `Events can be at most ${LIMITS.daysAhead} days ahead.`;
  if (d.spots != null && !(Number.isInteger(d.spots) && d.spots >= LIMITS.minSpots && d.spots <= LIMITS.maxAttendees)) {
    return `Spots should be between ${LIMITS.minSpots} and ${LIMITS.maxAttendees}.`;
  }
  return null;
}

const local = {
  key: "busy.events.v1",
  async load() {
    const raw = store.get(this.key);
    if (raw) {
      try {
        const events = JSON.parse(raw);
        if (Array.isArray(events)) return events;
      } catch { /* unreadable: start again from the examples */ }
    }
    const seeds = await getJSON("data/community_events_seed.json");
    const today = campusNow().date;
    const events = seeds.map((s, i) => ({
      id: `example-${i + 1}`, title: s.title, place: s.place, note: s.note,
      date: addDays(today, s.day_offset), start: s.start, end: s.end, host: "Example host",
      spots: s.spots, invite_only: s.invite_only, invite_code: s.invite_only ? inviteCode() : null,
      host_token: "example", example: true,
      going: Array.from({ length: s.going }, (_, k) => ({ token: `ex${k}`, name: "Example" })),
    }));
    this.save(events);
    return events;
  },
  save(events) {
    store.set(this.key, JSON.stringify(events));
  },
  public(e, token) {
    const isHost = e.host_token === token;
    return {
      id: e.id, title: e.title, place: e.place, note: e.note, date: e.date, start: e.start,
      end: e.end, host: e.host, spots: e.spots, invite_only: e.invite_only, example: !!e.example,
      going_count: e.going.length, joined: e.going.some((g) => g.token === token),
      is_host: isHost, invite_code: isHost ? e.invite_code : null,
    };
  },
  async find(id) {
    const events = await this.load();
    const e = events.find((x) => x.id === id);
    if (!e) throw new SourceError(404, "Event not found");
    return [events, e];
  },
};

export const communityEvents = {
  async list() {
    const token = deviceToken();
    if ((await getMode()) === "api") {
      // Header, not query string: the token is this device's key, so keep it out of URLs and logs.
      return getJSON(`${API_BASE}/community-events`, { headers: { "X-BUsy-Device": token } });
    }
    const now = campusNow();
    const events = await local.load();
    return events
      .filter((e) => !ended(e, now))
      .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`))
      .map((e) => local.public(e, token));
  },

  async create(data) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post("community-events", { ...data, token });
    const problem = eventProblem(data);
    if (problem) throw new SourceError(422, problem);
    const events = await local.load();
    const trimmed = Object.fromEntries(["title", "place", "note", "host"].map((k) => [k, String(data[k] ?? "").trim()]));
    const e = {
      ...data, ...trimmed, id: uuid().slice(0, 8), example: false, host_token: token,
      invite_code: data.invite_only ? inviteCode() : null, going: [{ token, name: trimmed.host }],
    };
    events.push(e);
    local.save(events);
    return local.public(e, token);
  },

  async join(id, { name, code }) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`community-events/${id}/join`, { token, name, code });
    const [events, e] = await local.find(id);
    if (!e.going.some((g) => g.token === token)) {
      if (ended(e, campusNow())) throw new SourceError(410, "This event has already ended");
      if (e.invite_only && normCode(code) !== normCode(e.invite_code)) throw new SourceError(403, "Wrong invite code");
      if (e.going.length >= (e.spots || LIMITS.maxAttendees)) throw new SourceError(409, "Event is full");
      e.going.push({ token, name: String(name).trim() });
      local.save(events);
    }
    return local.public(e, token);
  },

  async leave(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`community-events/${id}/leave`, { token });
    const [events, e] = await local.find(id);
    if (e.host_token === token) throw new SourceError(400, "Hosts cancel instead of leaving");
    e.going = e.going.filter((g) => g.token !== token);
    local.save(events);
    return local.public(e, token);
  },

  async cancel(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`community-events/${id}/cancel`, { token });
    const [events, e] = await local.find(id);
    if (e.host_token !== token) throw new SourceError(403, "Only the host can cancel");
    local.save(events.filter((x) => x !== e));
    return null;
  },
};

function post(path, body) {
  return getJSON(`${API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- club directory (mirrors server/clubs.py) ----------
// Static mode keeps clubs and sign-ups in this browser only. The sample clubs come
// from data/clubs_seed.json; clubs you create and your applications stay on this
// device, so nobody else can see, join or review them. The rules (validation,
// capacity, waitlist, organizer gating) and error codes match the server's.
// Organizer gating is demo-grade in both modes: a device token, not a login.
let clubSeedPromise;
function clubSeed() {
  clubSeedPromise ??= getJSON("data/clubs_seed.json").catch((e) => { clubSeedPromise = null; throw e; });
  return clubSeedPromise;
}
/** Categories, days, years, campus places and limits (exported by the server, same in both modes). */
export const clubOptions = async () => (await clubSeed()).options;

const SCHOOL_EMAIL = /^[A-Za-z0-9._%+-]+@bu\.edu$/i;
const LINE = /[\x00-\x1f\x7f]/;
const TEXT = /[\x00-\x09\x0b-\x1f\x7f]/;
const HOLDS_SPOT = ["approved", "pending"];
const half = (x) => Math.floor(x + 0.5);
export const CLUB_MAX_MEMBERS = 500;   // server: MAX_MEMBERS (also the cap when capacity is empty)
export const CLUB_MAX_WAITLIST = 100;  // server: MAX_WAITLIST
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Same checks as the server's ClubFields; returns { field, message } or null. */
export function clubProblem(d, o, now = campusNow()) {
  const L = o.limits;
  const t = (v) => String(v ?? "").trim();
  const bad = (field, message) => ({ field, message });
  if (!t(d.name)) return bad("name", "Please give the club a name.");
  if (!o.categories.includes(d.category)) return bad("category", "Please choose a category.");
  if (!t(d.description)) return bad("description", "Please add a short description.");
  for (const [k, max, label] of [["name", L.name, "Name"], ["description", L.description, "Description"],
    ["activities", L.activities, "Activities"], ["location_text", L.location_text, "Location details"],
    ["contact", L.contact, "Contact"], ["requirements", L.requirements, "Requirements"]]) {
    if (t(d[k]).length > max) return bad(k, `${label} is too long (max ${max}).`);
  }
  for (const k of ["name", "location_text", "contact"]) if (LINE.test(t(d[k]))) return bad(k, "Please remove line breaks and special characters.");
  for (const k of ["description", "activities", "requirements"]) if (TEXT.test(t(d[k]))) return bad(k, "Please remove special characters.");
  if (d.meeting_day != null && !o.days.includes(d.meeting_day)) return bad("meeting_day", "Please choose a meeting day.");
  if ((d.meeting_start == null) !== (d.meeting_end == null)) return bad(d.meeting_start == null ? "meeting_start" : "meeting_end", "Give both a start and an end time, or neither.");
  if (d.meeting_start != null && (!HHMM.test(d.meeting_start) || !HHMM.test(d.meeting_end))) return bad("meeting_start", "Please use valid times.");
  if (d.meeting_start != null && d.meeting_end <= d.meeting_start) return bad("meeting_end", "End time needs to be after the start.");
  if (d.location_id != null && !o.locations.some((l) => l.id === d.location_id)) return bad("location_id", "Pick a listed campus place, or none.");
  if (d.capacity != null && !(Number.isInteger(d.capacity) && d.capacity >= 1 && d.capacity <= L.capacity)) {
    return bad("capacity", `Capacity should be between 1 and ${L.capacity}, or left empty.`);
  }
  if ((d.officers ?? []).length > L.officers) return bad("officers", `At most ${L.officers} officers.`);
  for (const x of d.officers ?? []) {
    if (!t(x.role) || !t(x.name)) return bad("officers", "Each officer needs a role and a name.");
    if (t(x.role).length > L.officer_role || t(x.name).length > L.officer_name) return bad("officers", "An officer's role or name is too long.");
    if (LINE.test(t(x.role)) || LINE.test(t(x.name))) return bad("officers", "Please remove line breaks and special characters.");
  }
  if ((d.upcoming ?? []).length > L.upcoming) return bad("upcoming", `At most ${L.upcoming} upcoming meetings.`);
  for (const m of d.upcoming ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? "") || m.date < now.date || m.date > addDays(now.date, L.upcoming_days)) {
      return bad("upcoming", `Upcoming meetings must be between today and ${L.upcoming_days} days ahead.`);
    }
    if (t(m.note).length > L.note || LINE.test(t(m.note))) return bad("upcoming", `Meeting notes: one line, at most ${L.note} characters.`);
  }
  return null;
}

/** Same checks as the server's Application; returns { field, message } or null. */
export function applicationProblem(d, o) {
  const L = o.limits;
  const t = (v) => String(v ?? "").trim();
  const bad = (field, message) => ({ field, message });
  if (!t(d.name)) return bad("name", "Please enter your full name.");
  if (t(d.name).length > L.applicant_name) return bad("name", `Name is too long (max ${L.applicant_name}).`);
  if (t(d.email).length > L.email || !SCHOOL_EMAIL.test(t(d.email))) return bad("email", "Use your school email (name@bu.edu).");
  if (!o.years.includes(d.year)) return bad("year", "Please choose your year.");
  for (const [k, max, label] of [["contact", L.contact, "Other contact"], ["reason", L.reason, "Reason"], ["availability", L.availability, "Availability"]]) {
    if (t(d[k]).length > max) return bad(k, `${label} is too long (max ${max}).`);
  }
  for (const k of ["name", "email", "contact", "availability"]) if (LINE.test(t(d[k]))) return bad(k, "Please remove line breaks and special characters.");
  if (TEXT.test(t(d.reason))) return bad("reason", "Please remove special characters.");
  return null;
}

/** Busyness estimate for a meeting place and time. Mirrors server/clubs.py meeting_busyness(). */
export async function meetingBusyness(locationId, start, end) {
  const o = await clubOptions();
  const place = o.locations.find((l) => l.id === locationId);
  if (!place || !start || !end) return null;
  const hist = await getHistory(locationId);
  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const [a, b] = [toMinutes(start), toMinutes(end)];
  const { mean, covered } = meanOver(hist.observations, a, b, hist.coverage_end, hist.max_hold_minutes);
  const share = covered / ((b - a) * 60);
  const when = `${start}–${end}`;
  const coverage = half(share * 100) / 100;
  if (mean == null || share < 0.5) {
    return { level: "unknown", estimate: null, capacity: hist.capacity, coverage, label: "No estimate",
      basis: `Not enough simulated data at ${place.name}, ${when}.` };
  }
  const level = classify(mean / hist.capacity);
  return {
    level, estimate: half(mean), capacity: hist.capacity, coverage, label: `Usually ${level} then (estimate)`,
    basis: `Estimate: about ${half(mean).toLocaleString("en-US")} people on average at ${place.name}, ${when}, on the simulated `
      + `demo Monday (${half((mean / hist.capacity) * 100)}% of an illustrative capacity of ${hist.capacity.toLocaleString("en-US")}). `
      + `Time-weighted, ${half(share * 100)}% of the meeting covered; ${THRESHOLD_NOTE}. `
      + "Simulated, not a BU measurement, and the meeting's weekday isn't modeled.",
  };
}

// One mutation at a time, so two quick taps can't both take the last spot.
let clubQueue = Promise.resolve();
function exclusive(fn) {
  const run = clubQueue.then(fn);
  clubQueue = run.catch(() => {});
  return run;
}

const clubLocal = {
  key: "busy.clubs.v1",
  memory: null,        // used when the browser blocks storage, for this tab only
  persistent: true,
  async load() {
    const raw = store.get(this.key) ?? this.memory;
    if (raw) {
      try {
        const clubs = JSON.parse(raw);
        if (Array.isArray(clubs)) return clubs;
      } catch { /* unreadable: start again from the sample clubs */ }
    }
    const seed = await clubSeed();
    const holders = (prefix, n, status) => Array.from({ length: n }, (_, k) => ({
      id: `${prefix}${k}`, token: `${prefix}${k}`, status, example: true, created_at: `2026-01-01T00:00:${String(k % 60).padStart(2, "0")}`,
    }));
    const clubs = seed.clubs.map(({ members, waitlisted, ...s }, i) => ({
      ...s, id: `example-${i + 1}`, upcoming: [], organizer_token: null, example: true,
      applications: [...holders("m", members, "approved"), ...holders("w", waitlisted, "waitlisted")],
    }));
    this.save(clubs);
    return clubs;
  },
  save(clubs) {
    this.memory = JSON.stringify(clubs);
    store.set(this.key, this.memory);
    this.persistent = store.get(this.key) === this.memory;
  },
  async find(id) {
    const clubs = await this.load();
    const c = clubs.find((x) => x.id === id);
    if (!c) throw new SourceError(404, "Club not found");
    return [clubs, c];
  },
};

const limitOf = (c) => c.capacity || CLUB_MAX_MEMBERS;
const takenOf = (c) => c.applications.filter((a) => HOLDS_SPOT.includes(a.status)).length;
const waitlistOf = (c) => c.applications.filter((a) => a.status === "waitlisted").sort((a, b) => a.created_at.localeCompare(b.created_at));
const isOrganizer = (c, token) => !!token && token.length >= 8 && !!c.organizer_token && token === c.organizer_token;
function promote(c) {
  for (const a of waitlistOf(c)) {
    if (takenOf(c) >= limitOf(c)) break;
    a.status = c.requires_approval ? "pending" : "approved";
  }
}
let stamp = 0;
const createdAt = () => `${new Date().toISOString().slice(0, 23)}${String(stamp++ % 1000).padStart(3, "0")}`;

function clubStatus(c) {
  if (takenOf(c) < limitOf(c)) return "Open";
  return c.waitlist && waitlistOf(c).length < CLUB_MAX_WAITLIST ? "Waitlist" : "Full";
}

function publicClub(c, token, locations) {
  const today = campusNow().date;
  const waitlist = waitlistOf(c);
  const mine = c.applications.find((a) => token && a.token === token);
  const keep = ["id", "name", "category", "description", "activities", "meeting_day", "meeting_start", "meeting_end",
    "location_id", "location_text", "officers", "contact", "requirements", "requires_approval", "capacity", "waitlist"];
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;     // Monday = 0, like the server
  return {
    ...Object.fromEntries(keep.map((k) => [k, c[k]])),
    example: !!c.example,
    location_name: locations.find((l) => l.id === c.location_id)?.name ?? null,
    upcoming: c.upcoming.filter((m) => m.date >= today),
    next_meeting: c.meeting_day ? addDays(today, (WEEK.indexOf(c.meeting_day) - weekday + 7) % 7) : null,
    members: c.applications.filter((a) => a.status === "approved").length,
    spots_left: c.capacity == null ? null : Math.max(0, c.capacity - takenOf(c)),
    waitlist_count: waitlist.length,
    status: clubStatus(c),
    is_organizer: isOrganizer(c, token),
    my_application: mine ? { id: mine.id, status: mine.status, created_at: mine.created_at,
      position: mine.status === "waitlisted" ? waitlist.indexOf(mine) + 1 : null } : null,
    busyness_hint: c.busyness_hint ?? null,
  };
}

const clubFields = (d) => ({
  name: String(d.name).trim(), category: d.category, description: String(d.description).trim(),
  activities: String(d.activities ?? "").trim(), meeting_day: d.meeting_day ?? null,
  meeting_start: d.meeting_start ?? null, meeting_end: d.meeting_end ?? null, location_id: d.location_id ?? null,
  location_text: String(d.location_text ?? "").trim(),
  officers: (d.officers ?? []).map((x) => ({ role: String(x.role).trim(), name: String(x.name).trim() })),
  contact: String(d.contact ?? "").trim(), requirements: String(d.requirements ?? "").trim(),
  requires_approval: !!d.requires_approval, capacity: d.capacity ?? null, waitlist: d.waitlist !== false,
  upcoming: (d.upcoming ?? []).map((m) => ({ date: m.date, note: String(m.note ?? "").trim() })),
});

export const clubs = {
  /** False when this browser blocks storage: static-mode changes last only until the tab closes. */
  get persistent() { return clubLocal.persistent; },

  async list() {
    const token = deviceToken();
    if ((await getMode()) === "api") return getJSON(`${API_BASE}/clubs`, { headers: { "X-BUsy-Device": token } });
    const { locations } = await clubOptions();
    return (await clubLocal.load()).map((c) => publicClub(c, token, locations))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  },

  async get(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") return getJSON(`${API_BASE}/clubs/${encodeURIComponent(id)}`, { headers: { "X-BUsy-Device": token } });
    const [, c] = await clubLocal.find(id);
    return publicClub(c, token, (await clubOptions()).locations);
  },

  async create(data) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post("clubs", { ...data, token });
    const o = await clubOptions();
    const problem = clubProblem(data, o);
    if (problem) throw new SourceError(422, problem.message);
    const fields = clubFields(data);
    const hint = await meetingBusyness(fields.location_id, fields.meeting_start, fields.meeting_end);
    return exclusive(async () => {
      const all = await clubLocal.load();
      if (all.length >= o.limits.clubs) throw new SourceError(503, "Too many clubs right now. Try again later.");
      const c = { ...fields, busyness_hint: hint, id: uuid().slice(0, 8), organizer_token: token, example: false, applications: [] };
      all.push(c);
      clubLocal.save(all);
      return publicClub(c, token, o.locations);
    });
  },

  async edit(id, data) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`clubs/${encodeURIComponent(id)}/edit`, { ...data, token });
    const o = await clubOptions();
    const problem = clubProblem(data, o);
    if (problem) throw new SourceError(422, problem.message);
    const fields = clubFields(data);
    const hint = await meetingBusyness(fields.location_id, fields.meeting_start, fields.meeting_end);
    return exclusive(async () => {
      const [all, c] = await clubLocal.find(id);
      if (!isOrganizer(c, token)) throw new SourceError(403, "Only this club's organizer can do that");
      const approved = c.applications.filter((a) => a.status === "approved").length;
      if (fields.capacity != null && fields.capacity < approved) {
        throw new SourceError(409, `${approved} members are already approved; capacity can't be lower`);
      }
      Object.assign(c, fields, { busyness_hint: hint });
      promote(c);
      clubLocal.save(all);
      return publicClub(c, token, o.locations);
    });
  },

  /** `join_waitlist: true` only after the student chose the waitlist for a full club. */
  async apply(id, data) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`clubs/${encodeURIComponent(id)}/apply`, { ...data, token });
    const o = await clubOptions();
    const problem = applicationProblem(data, o);
    if (problem) throw new SourceError(422, problem.message);
    return exclusive(async () => {
      const [all, c] = await clubLocal.find(id);
      if (isOrganizer(c, token)) throw new SourceError(400, "You run this club");
      const mine = c.applications.find((a) => a.token === token);
      if (mine) throw new SourceError(409, mine.status === "rejected" ? "Your application to this club was declined" : "You already applied to this club");
      let status;
      if (takenOf(c) < limitOf(c)) status = c.requires_approval ? "pending" : "approved";
      else if (!c.waitlist || waitlistOf(c).length >= CLUB_MAX_WAITLIST) throw new SourceError(409, "This club is full and isn't taking waitlist sign-ups");
      else if (!data.join_waitlist) throw new SourceError(409, "This club is full. You can join the waitlist instead");
      else status = "waitlisted";
      const t = (k) => String(data[k] ?? "").trim();
      c.applications.push({
        id: uuid().slice(0, 8), token, status, created_at: createdAt(),
        name: t("name"), email: t("email").toLowerCase(), year: data.year, contact: t("contact"),
        reason: t("reason").replace(/\r\n/g, "\n"), availability: t("availability"),
      });
      clubLocal.save(all);
      return publicClub(c, token, o.locations);
    });
  },

  async withdraw(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`clubs/${encodeURIComponent(id)}/withdraw`, { token });
    const { locations } = await clubOptions();
    return exclusive(async () => {
      const [all, c] = await clubLocal.find(id);
      const mine = c.applications.find((a) => a.token === token);
      if (!mine) throw new SourceError(404, "You haven't applied to this club");
      c.applications = c.applications.filter((a) => a !== mine);
      promote(c);
      clubLocal.save(all);
      return publicClub(c, token, locations);
    });
  },

  /** Organizer only. */
  async applications(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") {
      return getJSON(`${API_BASE}/clubs/${encodeURIComponent(id)}/applications`, { headers: { "X-BUsy-Device": token } });
    }
    const [, c] = await clubLocal.find(id);
    if (!isOrganizer(c, token)) throw new SourceError(403, "Only this club's organizer can do that");
    const waitlist = waitlistOf(c);
    return [...c.applications].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((a) => ({
      id: a.id, status: a.status, created_at: a.created_at, example: !!a.example,
      position: a.status === "waitlisted" ? waitlist.indexOf(a) + 1 : null,
      ...Object.fromEntries(["name", "email", "year", "contact", "reason", "availability"].map((k) => [k, a[k] ?? ""])),
    }));
  },

  /** Organizer only: decision is "approve" or "reject". */
  async decide(id, appId, decision) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`clubs/${encodeURIComponent(id)}/applications/${encodeURIComponent(appId)}/decide`, { token, decision });
    const { locations } = await clubOptions();
    return exclusive(async () => {
      const [all, c] = await clubLocal.find(id);
      if (!isOrganizer(c, token)) throw new SourceError(403, "Only this club's organizer can do that");
      const a = c.applications.find((x) => x.id === appId);
      if (!a) throw new SourceError(404, "Application not found");
      if (decision === "approve") {
        if (a.status === "pending") a.status = "approved";
        else if (a.status === "waitlisted") {
          if (takenOf(c) >= limitOf(c)) throw new SourceError(409, "No spot is free. Raise the capacity or decline someone first");
          a.status = "approved";
        } else if (a.status === "rejected") throw new SourceError(409, "This application was already declined");
      } else if (decision === "reject") {
        a.status = "rejected";
        promote(c);
      } else throw new SourceError(422, "Unknown decision");
      clubLocal.save(all);
      return publicClub(c, token, locations);
    });
  },
};
