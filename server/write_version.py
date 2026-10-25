"""Write web/version.json: the site's version history, read from main's git history.

The GitHub Pages workflow runs this on every deploy (every push or merge to main), so the
version note in the page's corner updates by itself. Each commit on main's first-parent line
is one version: a merge brings in a whole branch, a direct commit is one change. v1 is the
oldest; the newest is the version being deployed.

    python server/write_version.py            # optional locally, to preview the note

web/version.json is generated, not committed (.gitignore); without it the note stays hidden.
Standard library only.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "version.json"
FIELD, RECORD = "\x1f", "\x1e"
MERGE_BRANCH = re.compile(r"^Merge (?:remote-tracking )?branch '([^']+)'(?: into \S+)?(?::\s*(.*))?$")
MERGE_PR = re.compile(r"^Merge pull request #(\d+) from (\S+)$")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                          check=True).stdout


def repo_url() -> str | None:
    """https://github.com/owner/repo, from the Actions environment or the origin remote."""
    if os.environ.get("GITHUB_REPOSITORY"):
        return f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ['GITHUB_REPOSITORY']}"
    try:
        url = git("remote", "get-url", "origin").strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    m = re.match(r"^(?:https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(?:\.git)?$", url)
    return f"https://github.com/{m.group(1)}" if m else None


def describe(subject: str, body: str) -> tuple[str, str | None]:
    """(title, branch) for one commit. Merges are named after what they bring in."""
    m = MERGE_BRANCH.match(subject)
    if m:
        return (m.group(2) or f"Merged {m.group(1)}"), m.group(1)
    m = MERGE_PR.match(subject)
    if m:
        first = next((line.strip() for line in body.splitlines() if line.strip()), "")
        return (first or f"Pull request #{m.group(1)}"), m.group(2)
    return subject, None


def parse(log: str) -> list[dict]:
    """Records from `git log --first-parent --format=%H<US>%cI<US>%s<US>%b<RS>`, newest first."""
    out = []
    for record in log.split(RECORD):
        record = record.strip("\n")
        if not record:
            continue
        sha, date, subject, body = (record.split(FIELD) + ["", "", "", ""])[:4]
        title, branch = describe(subject.strip(), body)
        title = title[:1].upper() + title[1:]
        out.append({"commit": sha[:7], "sha": sha, "date": date, "title": title, "branch": branch})
    return out


def build(entries: list[dict], repo: str | None) -> dict:
    total = len(entries)
    history = [{**e, "version": total - i, "url": f"{repo}/commit/{e['sha']}" if repo else None}
               for i, e in enumerate(entries)]
    for h in history:
        del h["sha"]
    return {"version": total, "commit": history[0]["commit"], "date": history[0]["date"],
            "title": history[0]["title"], "repo": repo, "history": history}


def stamp_assets(web: Path, revision: str) -> None:
    """Give one deployed module graph and stylesheet a shared cache key.

    Run only on the deployment artifact. Source modules keep normal local imports.
    Versioning every import avoids mixing a new entry point with cached old modules.
    """
    imports = re.compile(r'''(\bfrom\s*|\bimport\s*)(["'])(\./[^"'?]+\.js)(?:\?v=[^"']*)?\2''')
    for path in (web / "js").rglob("*.js"):
        source = path.read_text(encoding="utf-8")
        source = imports.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?v={revision}{m[2]}", source)
        path.write_text(source, encoding="utf-8", newline="\n")
    index = web / "index.html"
    html = index.read_text(encoding="utf-8")
    html = re.sub(r'((?:src|href)=")((?:js/app\.js|styles\.css))(?:\?v=[^"]*)?"',
                  lambda m: f'{m[1]}{m[2]}?v={revision}"', html)
    index.write_text(html, encoding="utf-8", newline="\n")


def main() -> None:
    log = git("log", "--first-parent", f"--format=%H{FIELD}%cI{FIELD}%s{FIELD}%b{RECORD}", "HEAD")
    data = build(parse(log), repo_url())
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    if "--stamp-assets" in sys.argv:
        stamp_assets(OUT.parent, data["commit"])
    print(f"wrote {OUT.relative_to(ROOT)}: v{data['version']} ({data['commit']}, {data['date']}) {data['title']}")


if __name__ == "__main__":
    main()
