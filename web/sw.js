// BU-sy service worker — makes the installed app load fast and work offline.
//
// Strategy, kept deliberately simple and honest:
//   - App shell (HTML, CSS, JS, fonts, icons): precached on install so the
//     installed app opens offline. Deploys stamp CSS and JS with ?v=<commit>;
//     those URLs change every deploy, so they are served cache-first.
//   - Same-origin data files (web/data/*.json) and other unversioned files:
//     stale-while-revalidate — serve the cached copy at once, refresh it in the
//     background. The data is the built-in demo snapshot, so a slightly stale
//     copy offline is fine and clearly labelled "built-in demo files" in the UI.
//   - Navigations to the app (index.html): network first, cached copy offline,
//     so a new deploy shows up without anyone bumping CACHE. Other pages under
//     this scope (counter/) are left to the browser.
//   - The API (cross-origin or /api/*) and version.json are NEVER cached: live
//     data must stay live, and we never want to serve stale API data as if it were fresh.
//
// Bumping CACHE busts the old one on activate.
const CACHE = "busy-v11";
const SCOPE = new URL("./", self.location).pathname;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/availability.js",
  "./js/calendar.js",
  "./js/clock.js",
  "./js/clubs.js",
  "./js/findtime.js",
  "./js/hours.js",
  "./js/ics.js",
  "./js/icons.js",
  "./js/monthview.js",
  "./js/plan.js",
  "./js/plan-session.js",
  "./js/prefs.js",
  "./js/recommend.js",
  "./js/schedule.js",
  "./js/skyline.js",
  "./js/source.js",
  "./js/ui.js",
  "./assets/terrier.svg",
  "./assets/icon-maskable.svg",
  "./assets/campus/boston-hero.jpg",
  "./assets/fonts/IBMPlexSans-Variable.woff2",
  "./assets/fonts/SourceSerif4-Variable.woff2",
  "./data/facilities.json",
  "./data/campus.json",
  "./data/hours.json",
  "./data/sources.json",
  "./data/clubs_seed.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fails if any file 404s; add individually so one miss (e.g. a
      // renamed module) doesn't break the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never touch the live API — let it hit the network so data stays live.
  if (!sameOrigin || url.pathname.includes("/api/")) return;
  // The version note must describe what is actually deployed.
  if (url.pathname.endsWith("/version.json")) return;

  // Navigations: only the app's own document. Network first, so a new deploy's
  // index.html (and the asset versions it names) arrives at once; the cached
  // copy is the offline fallback. Other pages, like counter/, load normally.
  if (request.mode === "navigate") {
    if (url.pathname !== SCOPE && url.pathname !== `${SCOPE}index.html`) return;
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((cache) => cache.put("./index.html", copy)); }
          return res;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // Data snapshots and unversioned files: stale-while-revalidate, so they are
  // never more than one visit behind.
  if (url.pathname.includes("/data/") || !url.searchParams.has("v")) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
            .catch(() => cached);
          return cached || network;
        }),
      ),
    );
    return;
  }

  // Versioned files (?v=<commit>, stamped at deploy): a new deploy changes the
  // URL, so these are safe to serve cache-first.
  event.respondWith(
    caches.match(request).then((cached) =>
      cached
      || fetch(request).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      }).catch(() => cached),
    ),
  );
});
