"""Download the person detector so the counter runs without any CDN.

    python web/counter/get_model.py            # EfficientDet-Lite0 (default)
    python web/counter/get_model.py --lite2    # also fetch the larger, more accurate model

Saves into web/counter/vendor/ (git-ignored). detector.js uses these files
automatically when they exist and falls back to the CDN when they don't.
"""
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

MP_VERSION = "0.10.14"   # keep in sync with MP_VERSION in js/detector.js
CDN = f"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{MP_VERSION}"
MODELS = "https://storage.googleapis.com/mediapipe-models/object_detector"
VENDOR = Path(__file__).resolve().parent / "vendor"

FILES = {
    # .js, not .mjs: simple static servers (python -m http.server) may serve .mjs
    # with a MIME type browsers refuse for modules.
    "tasks-vision/vision_bundle.js": f"{CDN}/vision_bundle.mjs",
    "tasks-vision/wasm/vision_wasm_internal.js": f"{CDN}/wasm/vision_wasm_internal.js",
    "tasks-vision/wasm/vision_wasm_internal.wasm": f"{CDN}/wasm/vision_wasm_internal.wasm",
    "tasks-vision/wasm/vision_wasm_nosimd_internal.js": f"{CDN}/wasm/vision_wasm_nosimd_internal.js",
    "tasks-vision/wasm/vision_wasm_nosimd_internal.wasm": f"{CDN}/wasm/vision_wasm_nosimd_internal.wasm",
    "efficientdet_lite0.tflite": f"{MODELS}/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
}
if "--lite2" in sys.argv:
    FILES["efficientdet_lite2.tflite"] = f"{MODELS}/efficientdet_lite2/float16/1/efficientdet_lite2.tflite"


def download(url, dest):
    try:
        urllib.request.urlretrieve(url, dest)
    except urllib.error.URLError as err:
        # python.org builds on macOS ship without CA certificates until you run
        # "Install Certificates.command"; curl uses the system store instead.
        if not isinstance(err.reason, ssl.SSLError) or not shutil.which("curl"):
            raise
        subprocess.run(["curl", "-fsSL", "-o", str(dest), url], check=True)


def main():
    for rel, url in FILES.items():
        dest = VENDOR / rel
        if dest.exists() and dest.stat().st_size > 0:
            print(f"ok    {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"get   {rel}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        download(url, tmp)
        tmp.replace(dest)
    print(f"\nDone. Files are in {VENDOR}")


if __name__ == "__main__":
    main()
