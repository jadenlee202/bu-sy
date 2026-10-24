// Data adapter. Two interchangeable backends with the same response shapes:
//   api    - server/main.py (same origin, or ?api=https://host for another one)
//   static - web/data/*.json written by server/export_static.py (GitHub Pages);
//            community events are then kept in this browser's localStorage.
// Swap in a real campus feed by changing the server, not the screens.

const API_BASE = (() => {
  const custom = new URLSearchParams(location.search).get("api");
  return custom ? `${custom.replace(/\/$/, "")}/api` : "api";
})();

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

export async function getHistory(id) {
  if (!historyCache.has(id)) {
    const url = (await getMode()) === "api"
      ? `${API_BASE}/facilities/${encodeURIComponent(id)}/history`
      : `data/history/${encodeURIComponent(id)}.json`;
    historyCache.set(id, getJSON(url).catch((e) => {
      historyCache.delete(id);
      throw e;
    }));
  }
  return historyCache.get(id);
}

// ---------- per-device identity (anonymous) ----------
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: keep in memory only */ }
  },
};

const memoryToken = crypto.randomUUID();
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
const inviteCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

// Mirrors server/community_events.py for the no-server demo.
const local = {
  key: "busy.events.v1",
  async load() {
    const raw = store.get(this.key);
    if (raw) return JSON.parse(raw);
    const seeds = await getJSON("data/community_events_seed.json");
    const today = campusNow().date;
    const events = seeds.map((s, i) => ({
      id: `example-${i + 1}`, title: s.title, place: s.place, note: s.note,
      date: addDays(today, s.day_offset), start: s.start, end: s.end, host: "Example host",
      spots: s.spots, invite_only: s.invite_only, invite_code: s.invite_only ? inviteCode() : null,
      host_token: "example", example: true,
      going: Array.from({ length: s.going }, (_, k) => ({ token: `example-${k}`, name: "Example" })),
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
      return getJSON(`${API_BASE}/community-events?token=${encodeURIComponent(token)}`);
    }
    const now = campusNow();
    const events = await local.load();
    return events
      .filter((e) => `${e.date}T${e.end}` > `${now.date}T${now.time}`)
      .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`))
      .map((e) => local.public(e, token));
  },

  async create(data) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post("community-events", { ...data, token });
    const events = await local.load();
    const e = {
      ...data, id: crypto.randomUUID().slice(0, 8), example: false, host_token: token,
      invite_code: data.invite_only ? inviteCode() : null, going: [{ token, name: data.host }],
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
      if (e.invite_only && (code || "").trim().toUpperCase() !== e.invite_code) {
        throw new SourceError(403, "Wrong invite code");
      }
      if (e.spots && e.going.length >= e.spots) throw new SourceError(409, "Event is full");
      e.going.push({ token, name });
      local.save(events);
    }
    return local.public(e, token);
  },

  async leave(id) {
    const token = deviceToken();
    if ((await getMode()) === "api") return post(`community-events/${id}/leave`, { token });
    const [events, e] = await local.find(id);
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
