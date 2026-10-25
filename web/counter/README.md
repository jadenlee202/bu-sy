# BU-sy people counter

Counts people walking past a camera, live, entirely in the browser. It finds each person, follows them
from frame to frame, and counts them once when they cross a line you can drag.
**No video leaves the device.** Frames go straight from the camera into the model and are never saved or uploaded.
The only things downloaded are the detector library and model files.

Open it at `/counter/` on the site (for example `http://localhost:8000/counter/`).

## How it works

```
camera (getUserMedia, 640×480)
  └─ <video> ──► detector.js   MediaPipe ObjectDetector, EfficientDet-Lite0, WebAssembly + WebGL
                   │            "person" only, score ≥ 0.3
                   ▼
                 tracker.js     IoU / centre-distance matching, two passes by confidence → stable IDs
                   ▼
                 line.js        side of the line + dead band + confirm frames → In / Out
                   ▼
                 render.js      canvas overlay: line, IN/OUT arrows, boxes, IDs, trails
```

- **One loop per camera frame.** `requestVideoFrameCallback` fires once for each new frame (with
  `requestAnimationFrame` as a fallback), so frames are never processed twice and never copied. If the
  model is slower than the camera, frames are skipped and nothing queues up.
- **Detector.** EfficientDet-Lite0 is trained on COCO, so it recognises people in many poses and
  sizes. It runs on the GPU through WebGL when it can, otherwise on the CPU through WebAssembly.
  `categoryAllowlist: ["person"]` drops every other class inside the model call.
- **Tracker** (ByteTrack-style, simplified):
  1. Each track's box is moved forward by its recent speed, so fast walkers still overlap their next detection.
  2. Confident detections (≥ 0.5) are matched to tracks by IoU. If boxes don't overlap, a nearby
     detection of similar size (centre distance under 0.8 box-sizes) is matched instead. Matching is
     greedy, best match first, and IoU matches always beat distance matches.
  3. Tracks still unmatched get a second chance against weak detections (0.3–0.5), by IoU only. This keeps an ID
     through partial occlusion without letting weak boxes start new tracks.
  4. Leftover confident detections start *tentative* tracks. A track gets an ID once it has been
     matched in 3 frames. A tentative track unseen for more than 2 frames is dropped as noise.
     A confirmed track can go unseen for up to 1 s before it's dropped.
- **Line crossing** (`line.js`). Each track has a *side*: the sign of the cross product of the line
  direction and the box centre. A crossing counts only when **all** of these are true:
  - the track is confirmed and was detected this frame (never from a guessed position),
  - its side was already known (someone who appears on the line isn't counted),
  - its centre is outside a dead band (3% of the frame) on the other side,
  - it has stayed there for 2 frames in a row,
  - it crossed between the line's two ends, not around them.

  Then: arrow side = **In**, the other way = **Out**. Each crossing is counted exactly once, because
  the side flips right away and another count needs a full crossing back. If the same person crosses
  back within 1.5 s, the first count is **undone**, so someone hovering on the line counts as nothing,
  not as one in and one out. Moving the line resets every track's side, so dragging the line never counts anyone.
- **Counters.** *Total* = In + Out (crossings), with *net* (In − Out) underneath. *Visible now* = confirmed
  people detected in the current frame. Reset sets the counts to zero but keeps everyone's side, so
  nobody already past the line is counted again.

Pure logic (`tracker.js`, `line.js`) has no DOM code, so it can be tested with simulated detections.

## Setup

No build step and no npm. Any static server works.

```bash
# from the repo root
python web/counter/get_model.py       # optional: self-host the model + runtime (~25 MB), see below
python -m http.server 8000 -d web
# open http://localhost:8000/counter/  → Start camera → allow camera access
```

Or run the FastAPI server as in the main README. It serves `web/` too.

### The detection model

`js/detector.js` looks for files in `web/counter/vendor/` and falls back to the CDN for anything missing:

| File | Local (after `get_model.py`) | Fallback |
|---|---|---|
| MediaPipe Tasks Vision 0.10.14 | `vendor/tasks-vision/vision_bundle.js` + `wasm/` | cdn.jsdelivr.net |
| EfficientDet-Lite0 float16 (~4.6 MB) | `vendor/efficientdet_lite0.tflite` | storage.googleapis.com |

`vendor/` is git-ignored, so GitHub Pages uses the CDN. To self-host there too, remove `web/counter/vendor/`
from `.gitignore` and commit the files. After the first load the browser caches them either way.

To trade speed for accuracy, run `python web/counter/get_model.py --lite2`, then change
`createPersonDetector()` in `main.js` to `createPersonDetector({ model: "lite2" })`.

## Camera permissions

- Browsers only give camera access on a **secure page**: `https://…` or `http://localhost`. A LAN address like
  `http://192.168.1.20:8000` won't work on a phone. Use GitHub Pages (HTTPS), or a tunnel such as
  `npx localtunnel --port 8000` / `cloudflared tunnel --url http://localhost:8000`.
- The first **Start camera** shows the browser's permission prompt. Nothing needs to go in a manifest.
- iOS Safari needs iOS 14.3+. The `<video>` already has `playsinline` and `muted`, which iOS requires.
- The page asks for the back camera (`facingMode: environment`) and shows **Switch camera** when the device has more than one.

## Controls

- **Start / Stop camera:** stopping releases the camera (the light goes off) but keeps the counts.
- **Reset:** sets all counters to zero.
- **Flip In/Out:** swaps which direction counts as In. The green arrow on the line points In.
- **Line: vertical / horizontal:** snaps the line to a preset. Use vertical for people walking across the
  view, horizontal for people walking toward or away from the camera.
- **Drag the line:** drag an end to move it, or drag the middle to move the whole line. Shorten it to
  just cover a doorway. The position is saved in this browser.

## Tuning

| Want | Change |
|---|---|
| Fewer false people | `highScore` ↑ in `tracker.js` (e.g. 0.6) |
| Keep people through longer occlusions | `maxAgeMs` ↑ in `tracker.js` |
| Less sensitive to jitter at the line | `bandFraction` or `confirmFrames` ↑ in `line.js` |
| Different "hover" undo window | `reversalMs` in `line.js` |
| Faster on weak devices | lower `width`/`height` in `openCamera()` (e.g. 480×360) |

## Troubleshooting

**Camera**
- *"needs a secure page"*: you're on plain HTTP over a LAN address. See *Camera permissions*.
- *Permission denied*: click the camera icon in the address bar (Chrome/Edge), go to Settings → Websites → Camera
  (Safari), or turn on the browser in System Settings → Privacy & Security → Camera (macOS), then reload.
- *Camera busy*: another app or tab (Zoom, FaceTime, another copy of this page) is using it.
- *Black preview on iPhone*: make sure the page is HTTPS and not inside an in-app browser (Instagram, etc.).
  Open it in Safari.

**Model**
- *Couldn't load the person detector*: the CDN is blocked or you're offline. Run `get_model.py` and serve locally.
- *Self-hosted files 404*: `vendor/` must sit inside `web/counter/` and the server must serve `web/`.
  `.wasm` must be served as `application/wasm` (Python's `http.server` does this).
- *"GPU delegate unavailable"* in the console: WebGL is off or blocked, so the CPU is used. It's slower but works.
  In Chrome, check `chrome://gpu`.

**Performance**
- The corner badge shows frames per second, model time per frame, and GPU/CPU. Expect 15–30 fps on recent
  laptops and phones.
- Slow: close other camera tabs, lower the capture size (see *Tuning*), keep the default Lite0 model,
  and plug in laptops (battery saver throttles the GPU).
- Counts look off: mount the camera higher and looking down at an angle, so people overlap less.
  Put the line where people are fully in view, away from the frame edges. Make sure the IN arrow points the way you expect.
- Double counts: usually the line sits where people stop (a doorway or a queue). Move it a step past where they
  stop, or raise `confirmFrames`.

## Limits

This is a prototype, not a certified counter. Large crowds, people pressed close together, and people
fully hidden for over a second can still be missed or get a new ID. A new ID only matters if it
appears on the other side of the line, and it never counts on its own, because its side has to be known first.
