// People counter app: camera lifecycle, the per-frame loop
// (detect → track → count → draw), and the controls.

import { createPersonDetector } from "./detector.js";
import { Tracker } from "./tracker.js";
import { LineCounter, PRESETS, measure } from "./line.js";
import { draw } from "./render.js";

const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const ui = {
  in: $("c-in"), out: $("c-out"), visible: $("c-visible"), total: $("c-total"), net: $("c-net"),
  toggle: $("toggle"), reset: $("reset"), flip: $("flip"), preset: $("preset"), switch: $("switch"), mirror: $("mirror"),
  placeholder: $("placeholder"), message: $("message"), perf: $("perf"), stage: $("stage"), viewport: $("viewport"),
};

const LINE_KEY = "busy.counter.line";
const FLIP_KEY = "busy.counter.inSide";
const MIRROR_KEY = "busy.counter.mirror";

const tracker = new Tracker();
const counter = new LineCounter();
const flashes = new Map();   // track id -> { dir, t }, for colouring a box right after it counts
let line = loadLine();
let detector = null, detectorLoading = null;
let stream = null, running = false, facing = "environment";
let frameHandle = 0, lastVideoTime = -1, fps = 0, inferMs = 0, lastFrameAt = 0;
let shown = {};
let mirrorChoice = null;   // true/false once the user picks; null = mirror front cameras only
let mirrored = false;
canvas.width = 640; canvas.height = 480;   // until the camera reports its real size

// ---------- theme + brand (same as the main site) ----------
try {
  const saved = localStorage.getItem("busy.theme");
  if (saved) document.documentElement.dataset.theme = saved;
  if (localStorage.getItem(FLIP_KEY) === "1") counter.inSide = 1;
  const m = localStorage.getItem(MIRROR_KEY);
  if (m) mirrorChoice = m === "1";
} catch { /* storage blocked: defaults */ }
document.querySelector(".brand-mark").innerHTML = `<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 61S11 41 11 26a21 21 0 0 1 42 0c0 15-21 35-21 35z" fill="var(--red)"/><circle cx="32" cy="26" r="12" fill="var(--surface)"/><path d="M32 26v-7M32 26l5 3" fill="none" stroke="var(--ink)" stroke-width="3.2" stroke-linecap="round"/></svg>`;

// ---------- camera ----------
async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showMessage("The camera needs a secure page. Open this over https:// or on http://localhost.", true);
  }
  ui.toggle.disabled = true;
  showMessage(detector ? "Opening camera…" : "Loading the person detector and opening the camera…");
  const camera = openCamera(facing);
  try {
    [stream] = await Promise.all([camera, loadDetector()]);
    video.srcObject = stream;
    await video.play();
    fitStage();
    running = true;
    lastVideoTime = -1;
    ui.placeholder.hidden = true;
    ui.perf.hidden = false;
    ui.toggle.textContent = "Stop camera";
    ui.switch.hidden = !(await hasMultipleCameras());
    applyMirror();
    scheduleFrame();
  } catch (err) {
    stopStream();
    camera.then(s => s.getTracks().forEach(t => t.stop()), () => {});   // camera may have opened before the model failed
    showMessage(describeError(err), true);
  } finally {
    ui.toggle.disabled = false;
  }
}

function stop() {
  running = false;
  cancelFrame();
  stopStream();
  tracker.reset();
  flashes.clear();
  ui.perf.hidden = true;
  ui.toggle.textContent = "Start camera";
  showMessage("Camera stopped. Counts are kept until you press Reset.");
  updateCounts();
  redrawIdle();
}

function openCamera(facingMode) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // 640×480 is plenty for the model (it resizes to 320×320) and keeps the frame rate up
    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
}

function stopStream() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

function loadDetector() {
  detectorLoading ??= createPersonDetector()
    .then(d => (detector = d))
    .catch(err => {
      detectorLoading = null;
      throw Object.assign(new Error(err?.message || String(err)), { model: true });
    });
  return detectorLoading;
}

async function hasMultipleCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}

function describeError(err) {
  if (err.model) return `Couldn't load the person detector (${err.message || err}). Check your connection, or run get_model.py to serve it locally.`;
  switch (err.name) {
    case "NotAllowedError": return "Camera permission was denied. Allow camera access for this site in the browser's address bar or settings, then press Start.";
    case "NotFoundError": return "No camera was found on this device.";
    case "NotReadableError": return "The camera is busy in another app or tab. Close it and try again.";
    case "OverconstrainedError": return "This camera doesn't support the requested mode. Try Switch camera.";
    default: return `Couldn't start the camera: ${err.message || err.name || err}`;
  }
}

// ---------- frame loop ----------
// requestVideoFrameCallback fires once per new camera frame; rAF is the fallback.
const hasRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
function scheduleFrame() {
  frameHandle = hasRVFC ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame(onFrame);
}
function cancelFrame() {
  if (!frameHandle) return;
  hasRVFC ? video.cancelVideoFrameCallback(frameHandle) : cancelAnimationFrame(frameHandle);
  frameHandle = 0;
}

function onFrame() {
  if (!running) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processFrame();
  }
  scheduleFrame();
}

function processFrame() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; fitStage(); }

  const t0 = performance.now();
  let detections;
  try {
    detections = detector.detect(video, t0);
    // Mirrored view: flip the boxes too, so tracking, the line and the drawing all use what's on screen.
    if (mirrored) for (const d of detections) d.x = w - d.x - d.w;
  } catch (err) {
    console.error(err);
    return;
  }
  const now = performance.now();
  inferMs = inferMs ? inferMs * 0.9 + (now - t0) * 0.1 : now - t0;
  if (lastFrameAt) fps = fps ? fps * 0.9 + (1000 / (now - lastFrameAt)) * 0.1 : 1000 / (now - lastFrameAt);
  lastFrameAt = now;

  const tracks = tracker.update(detections, now);
  for (const e of counter.update(tracks, line, w, h, now)) {
    if (e.undo) flashes.delete(e.track.id);
    else flashes.set(e.track.id, { dir: e.dir, t: now });
    bump(e.dir);
  }
  for (const [id, f] of flashes) if (now - f.t > 2000) flashes.delete(id);

  draw(ctx, { w, h, line, band: counter.band(w, h), inSide: counter.inSide, tracks, flashes, now });
  updateCounts(tracks.filter(t => t.confirmed && t.misses === 0).length);
  ui.perf.textContent = `${fps.toFixed(0)} fps · ${inferMs.toFixed(0)} ms · ${detector.delegate}`;
}

// ---------- counters ----------
function updateCounts(visible = 0) {
  const { in: i, out: o } = counter.counts;
  const next = { in: i, out: o, visible, total: i + o, net: `net ${i - o > 0 ? "+" : ""}${i - o}` };
  for (const k in next) if (shown[k] !== next[k]) ui[k].textContent = next[k];   // touch the DOM only on change
  shown = next;
}

function bump(dir) {
  const el = ui[dir].parentElement;
  el.classList.add("bump");
  setTimeout(() => el.classList.remove("bump"), 400);
}

// ---------- layout ----------
// Size the stage to the video's aspect ratio inside the viewport, so video and
// canvas line up exactly with no letterboxing to correct for.
function fitStage() {
  const vw = video.videoWidth || canvas.width, vh = video.videoHeight || canvas.height;
  const box = ui.viewport.getBoundingClientRect();
  const availW = box.width - 32, availH = box.height;
  const scale = Math.min(availW / vw, availH / vh);
  ui.stage.style.width = `${Math.floor(vw * scale)}px`;
  ui.stage.style.height = `${Math.floor(vh * scale)}px`;
  if (!running) redrawIdle();
}
new ResizeObserver(fitStage).observe(ui.viewport);

function redrawIdle() {
  if (running) return;
  draw(ctx, { w: canvas.width, h: canvas.height, line, band: counter.band(canvas.width, canvas.height), inSide: counter.inSide });
}

function showMessage(text, isError = false) {
  ui.placeholder.hidden = false;
  ui.placeholder.classList.toggle("error", isError);
  ui.message.textContent = text;
}

// ---------- moving the line ----------
// Drag either end to move that end; drag elsewhere near the line to move the whole line.
let drag = null;
function toFrame(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

canvas.addEventListener("pointerdown", e => {
  const p = toFrame(e), r = canvas.getBoundingClientRect();
  const near = (q, radius) => Math.hypot((q.x - p.x) * r.width, (q.y - p.y) * r.height) < radius;
  const grab = e.pointerType === "touch" ? 32 : 18;
  if (near(line.a, grab)) drag = { end: "a" };
  else if (near(line.b, grab)) drag = { end: "b" };
  else {
    const { dist, t } = measure(line, r.width, r.height, { x: p.x * r.width, y: p.y * r.height });
    if (Math.abs(dist) > grab || t < 0 || t > 1) return;
    drag = { end: null, from: p, a: { ...line.a }, b: { ...line.b } };
  }
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
  e.preventDefault();
});

canvas.addEventListener("pointermove", e => {
  if (!drag) return;
  const p = toFrame(e), clamp = v => Math.min(0.99, Math.max(0.01, v));
  if (drag.end) {
    line = { ...line, [drag.end]: { x: clamp(p.x), y: clamp(p.y) } };
  } else {
    // move both ends together, stopping at the frame edge
    const dx = Math.min(0.99 - Math.max(drag.a.x, drag.b.x), Math.max(0.01 - Math.min(drag.a.x, drag.b.x), p.x - drag.from.x));
    const dy = Math.min(0.99 - Math.max(drag.a.y, drag.b.y), Math.max(0.01 - Math.min(drag.a.y, drag.b.y), p.y - drag.from.y));
    line = { a: { x: drag.a.x + dx, y: drag.a.y + dy }, b: { x: drag.b.x + dx, y: drag.b.y + dy } };
  }
  lineMoved();
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  canvas.classList.remove("dragging");
  saveLine();
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function lineMoved() {
  counter.lineChanged(tracker.tracks);
  ui.preset.textContent = `Line: ${isHorizontal() ? "horizontal" : "vertical"}`;
  redrawIdle();
}

function isHorizontal() {
  return Math.abs(line.b.x - line.a.x) > Math.abs(line.b.y - line.a.y);
}

function loadLine() {
  try {
    const l = JSON.parse(localStorage.getItem(LINE_KEY));
    if ([l.a.x, l.a.y, l.b.x, l.b.y].every(v => typeof v === "number" && v >= 0 && v <= 1)) return l;
  } catch { /* none saved, or storage blocked */ }
  return structuredClone(PRESETS.vertical);
}

function saveLine() {
  try { localStorage.setItem(LINE_KEY, JSON.stringify(line)); } catch { /* ignore */ }
}

// ---------- controls ----------
ui.toggle.addEventListener("click", () => (running ? stop() : start()));

ui.reset.addEventListener("click", () => {
  counter.reset(tracker.tracks);
  flashes.clear();
  updateCounts(shown.visible);
});

ui.flip.addEventListener("click", () => {
  counter.flip();
  try { localStorage.setItem(FLIP_KEY, counter.inSide === 1 ? "1" : "0"); } catch { /* ignore */ }
  redrawIdle();
});

ui.preset.addEventListener("click", () => {
  line = structuredClone(isHorizontal() ? PRESETS.vertical : PRESETS.horizontal);
  lineMoved();
  saveLine();
});

ui.switch.addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  if (!running) return;
  stop();
  await start();
});

// Mirror like a selfie view. By default only cameras facing the user (laptop
// webcams, phone front cameras) are mirrored; the back camera shows the real scene.
function applyMirror() {
  const facingMode = stream?.getVideoTracks()[0]?.getSettings().facingMode;
  const next = mirrorChoice ?? facingMode !== "environment";
  if (next !== mirrored) tracker.reset();   // positions just flipped: start tracks fresh
  mirrored = next;
  ui.stage.classList.toggle("mirrored", mirrored);
  ui.mirror.textContent = `Mirror: ${mirrored ? "on" : "off"}`;
}

ui.mirror.addEventListener("click", () => {
  mirrorChoice = !mirrored;
  try { localStorage.setItem(MIRROR_KEY, mirrorChoice ? "1" : "0"); } catch { /* ignore */ }
  applyMirror();
});

// The browser pauses the camera in background tabs; drop stale tracks on return
// so a person who moved meanwhile doesn't produce a phantom crossing.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) {
    tracker.reset();
    lastFrameAt = 0;
  }
});

ui.preset.textContent = `Line: ${isHorizontal() ? "horizontal" : "vertical"}`;
applyMirror();
fitStage();
redrawIdle();
