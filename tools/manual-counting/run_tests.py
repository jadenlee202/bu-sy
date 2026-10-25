"""Run the pilot counter's browser tests in headless Chrome.

    python tools/manual-counting/run_tests.py

Serves this folder on a free localhost port, opens tests.html, and exits non-zero on any failure.
Set CHROME=/path/to/chrome if Chrome or Chromium is not found automatically.
"""
import functools
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
]


def find_chrome():
    for c in [os.environ.get("CHROME"), *CANDIDATES]:
        if c and (Path(c).exists() or shutil.which(c)):
            return shutil.which(c) or c
    return None


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    chrome = find_chrome()
    if not chrome:
        sys.exit("Chrome/Chromium not found. Set CHROME=/path/to/chrome, or open tests.html in any browser.")
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(HERE)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/tests.html"
    with tempfile.TemporaryDirectory() as profile:
        dom = subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={profile}",
             "--virtual-time-budget=20000", "--dump-dom", url],
            capture_output=True, text=True, timeout=120,
        ).stdout
    server.shutdown()

    lines = [html.unescape(re.sub(r"<[^>]+>", "", li)) for li in re.findall(r"<li class=\"(?:pass|fail)\">.*?</li>", dom)]
    for line in lines:
        print(line)
    m = re.search(r"RESULT pass=(\d+) fail=(\d+)", dom)
    if not m:
        sys.exit("Tests did not finish (no RESULT line).")
    print(m.group(0))
    sys.exit(1 if int(m.group(2)) or not lines else 0)


if __name__ == "__main__":
    main()
