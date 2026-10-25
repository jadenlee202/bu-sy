// Data adapter. Two interchangeable backends with the same response shapes:
//   api    - server/main.py (same origin, or ?api=https://host for another one)
//   static - web/data/*.json written by server/export_static.py (GitHub Pages);
//            community events are then kept in this browser's localStorage.
// Swap in a real campus feed by changing the server, not the screens.
// Both modes serve the same synthetic/historical data with its own labels;
// neither is ever presented as live.

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

export async function calendarFreeBusy(date, timezone) {
  return getJSON(`${CALENDAR_API}/freebusy`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, timezone }),
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
