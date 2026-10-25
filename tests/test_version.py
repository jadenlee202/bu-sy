"""Version note: server/write_version.py turns main's history into web/version.json.

The log text below is a SYNTHETIC FIXTURE in the format the script asks git for.
Run: python -m pytest
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import write_version as wv  # noqa: E402

US, RS = wv.FIELD, wv.RECORD
LOG = "".join(f"{sha}{US}{date}{US}{subject}{US}{body}{RS}\n" for sha, date, subject, body in [
    ("c" * 40, "2026-10-26T09:00:00-04:00", "Merge pull request #12 from jadenlee202/ben8", "Add a version note\n\nDetails"),
    ("b" * 40, "2026-10-25T18:30:00-04:00", "Merge branch 'ben7': mugar from ROBOD", "Co-Authored-By: someone"),
    ("a" * 40, "2026-10-24T14:04:00-04:00", "Initial commit", ""),
])


def test_titles_name_what_each_version_brought_in():
    assert wv.describe("Merge branch 'ben6': FitRec as one building", "") == ("FitRec as one building", "ben6")
    assert wv.describe("Merge branch 'ben2'", "") == ("Merged ben2", "ben2")
    assert wv.describe("Merge branch 'fix/x' into main", "") == ("Merged fix/x", "fix/x")
    assert wv.describe("Merge pull request #3 from me/topic", "\nPR title\n") == ("PR title", "me/topic")
    assert wv.describe("Merge pull request #3 from me/topic", "") == ("Pull request #3", "me/topic")
    assert wv.describe("Fix typo", "body") == ("Fix typo", None)


def test_history_is_numbered_oldest_first_and_newest_is_current():
    data = wv.build(wv.parse(LOG), "https://github.com/jadenlee202/bu-sy")
    assert data["version"] == 3 and data["commit"] == "ccccccc" and data["title"] == "Add a version note"
    assert [(h["version"], h["title"]) for h in data["history"]] == [
        (3, "Add a version note"), (2, "Mugar from ROBOD"), (1, "Initial commit")]       # capitalised
    assert data["history"][1]["url"] == "https://github.com/jadenlee202/bu-sy/commit/" + "b" * 40
    assert data["history"][0]["date"] == "2026-10-26T09:00:00-04:00"
    assert "sha" not in data["history"][0]


def test_no_repo_means_no_links():
    data = wv.build(wv.parse(LOG), None)
    assert all(h["url"] is None for h in data["history"]) and data["repo"] is None


def test_every_pages_deploy_writes_the_note_from_full_history():
    workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
    assert "fetch-depth: 0" in workflow and "python3 server/write_version.py" in workflow
    assert workflow.index("write_version.py") < workflow.index("upload-pages-artifact")   # before the site is packed
    assert "web/version.json" in (ROOT / ".gitignore").read_text(encoding="utf-8")       # generated, never committed
