"""Write the API's responses to web/data/ so the site works with no server
(GitHub Pages). Re-run after changing data or server logic:

    python server/export_static.py
"""
import json
from pathlib import Path

import clubs
import main

OUT = main.WEB_DIR / "data"


def write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path.relative_to(main.WEB_DIR.parent)}")


def dump(model) -> dict:
    return model.model_dump(mode="json")


if __name__ == "__main__":
    write(OUT / "facilities.json", [dump(f) for f in main.list_facilities(at="12:00")])
    for facility_id, facility in main.FACILITIES.items():
        write(OUT / "history" / f"{facility_id}.json", dump(main.get_history(facility_id, on=None)))
        # Only the days the app offers for playback, not the whole recording.
        for day in facility.playback_days:
            write(OUT / "history" / facility_id / f"{day}.json", dump(main.get_history(facility_id, on=day)))
    write(OUT / "campus.json", dump(main.get_campus()))
    write(OUT / "clubs_seed.json", clubs.static_seed(main.FACILITIES))
