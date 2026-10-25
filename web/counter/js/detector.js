// Person detector: MediaPipe Tasks ObjectDetector running EfficientDet-Lite0
// (COCO classes, filtered to "person") in WebAssembly, on the GPU when it can.
// Frames go straight from the <video> element into the model: nothing is
// saved or sent anywhere. Only the library and model files are downloaded.
//
// Files are loaded from ../vendor/ when present (run get_model.py once to
// fetch them; then the page works offline), otherwise from public CDNs.

const MP_VERSION = "0.10.14";
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const VENDOR = new URL("../vendor/", import.meta.url).href;

export const MODELS = {
  // ~4.6 MB, good balance for phones and laptops
  lite0: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
  // ~7 MB, more accurate on small/far people, roughly half the frame rate
  lite2: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite",
};

async function exists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function createPersonDetector({ model = "lite0", minScore = 0.3, maxResults = 25 } = {}) {
  const localLib = await exists(`${VENDOR}tasks-vision/vision_bundle.js`);
  const libUrl = localLib ? `${VENDOR}tasks-vision/vision_bundle.js` : `${CDN}/vision_bundle.mjs`;
  const wasmBase = localLib ? `${VENDOR}tasks-vision/wasm` : `${CDN}/wasm`;
  const { FilesetResolver, ObjectDetector } = await import(libUrl);
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);

  const fileName = MODELS[model].split("/").pop();
  const localModel = await exists(VENDOR + fileName);
  const modelAssetPath = localModel ? VENDOR + fileName : MODELS[model];

  const options = delegate => ({
    baseOptions: { modelAssetPath, delegate },
    runningMode: "VIDEO",
    scoreThreshold: minScore,
    maxResults,
    categoryAllowlist: ["person"],
  });

  let detector, delegate = "GPU";
  try {
    detector = await ObjectDetector.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("GPU delegate unavailable, using CPU:", err);
    delegate = "CPU";
    detector = await ObjectDetector.createFromOptions(fileset, options("CPU"));
  }

  let lastTs = 0;
  return {
    delegate,
    source: localLib && localModel ? "local files" : "CDN",
    /** @returns {{x:number,y:number,w:number,h:number,score:number}[]} pixel boxes in video coordinates */
    detect(video, now) {
      const ts = Math.max(now, lastTs + 1);   // VIDEO mode needs strictly increasing timestamps
      lastTs = ts;
      const vw = video.videoWidth, vh = video.videoHeight;
      return detector.detectForVideo(video, ts).detections.map(d => {
        const b = d.boundingBox;
        const x = Math.max(0, b.originX), y = Math.max(0, b.originY);
        return {
          x, y,
          w: Math.min(vw, b.originX + b.width) - x,
          h: Math.min(vh, b.originY + b.height) - y,
          score: d.categories[0]?.score ?? 0,
        };
      }).filter(d => d.w > 4 && d.h > 4);
    },
    close() {
      detector.close();
    },
  };
}
