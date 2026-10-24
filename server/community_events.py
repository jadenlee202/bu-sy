"""Unofficial, student-run events ("basketball run on court 4 at 6").

Stored in server/community_events.json (created on first run, git-ignored).
People are identified only by a random per-device token plus a nickname they
type; no accounts, no campus identity. Invite codes and tokens are never
returned to anyone except the host.
"""
import json
import secrets
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

STORE = Path(__file__).resolve().parent / "community_events.json"
_lock = threading.Lock()
CAMPUS_TZ = ZoneInfo("America/New_York")  # event dates/times are campus-local


def _now() -> datetime:
    return datetime.now(CAMPUS_TZ).replace(tzinfo=None)

# Example events, dated relative to "today" so the demo never looks stale.
SEED_EVENTS = [
    {"title": "Pickup basketball run", "place": "Basketball · Floor 2 (4 courts)", "note": "Court 4",
     "day_offset": 0, "start": "18:00", "end": "20:00", "spots": 10, "invite_only": False, "going": 6},
    {"title": "Morning lift partners", "place": "Weight Room · Floor 1", "note": "Meet by the racks",
     "day_offset": 1, "start": "07:00", "end": "08:00", "spots": 4, "invite_only": False, "going": 1},
    {"title": "Bouldering crew", "place": "Climbing Wall", "note": "Beginners welcome",
     "day_offset": 2, "start": "19:00", "end": "21:00", "spots": 8, "invite_only": True, "going": 3},
]


class NewEvent(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    place: str = Field(min_length=1, max_length=60)
    note: str = Field("", max_length=80)
    date: date
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    end: str = Field(pattern=r"^\d{2}:\d{2}$")
    host: str = Field(min_length=1, max_length=30)
    spots: Optional[int] = Field(None, ge=2, le=200)
    invite_only: bool = False
    token: str = Field(min_length=8, max_length=64)

    @field_validator("title", "place", "note", "host")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()

    @model_validator(mode="after")
    def check_times(self):
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


class JoinRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)
    name: str = Field(min_length=1, max_length=30)
    code: Optional[str] = None


class TokenRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)


def _code() -> str:
    return secrets.token_hex(3).upper()


def _seed() -> list[dict]:
    today = _now().date()
    events = []
    for i, s in enumerate(SEED_EVENTS):
        events.append({
            "id": f"example-{i + 1}", "title": s["title"], "place": s["place"], "note": s["note"],
            "date": (today + timedelta(days=s["day_offset"])).isoformat(),
            "start": s["start"], "end": s["end"], "host": "Example host", "spots": s["spots"],
            "invite_only": s["invite_only"], "invite_code": _code() if s["invite_only"] else None,
            "host_token": "example", "example": True,
            "going": [{"token": f"example-{k}", "name": "Example"} for k in range(s["going"])],
        })
    return events


def _load() -> list[dict]:
    if STORE.exists():
        return json.loads(STORE.read_text(encoding="utf-8"))
    events = _seed()
    _save(events)
    return events


def _save(events: list[dict]) -> None:
    STORE.write_text(json.dumps(events, indent=2), encoding="utf-8")


def _public(e: dict, token: Optional[str]) -> dict:
    is_host = bool(token) and token == e["host_token"]
    return {
        "id": e["id"], "title": e["title"], "place": e["place"], "note": e["note"],
        "date": e["date"], "start": e["start"], "end": e["end"], "host": e["host"],
        "spots": e["spots"], "invite_only": e["invite_only"], "example": e.get("example", False),
        "going_count": len(e["going"]),
        "joined": any(g["token"] == token for g in e["going"]),
        "is_host": is_host,
        "invite_code": e["invite_code"] if is_host else None,
    }


def _find(events: list[dict], event_id: str) -> dict:
    for e in events:
        if e["id"] == event_id:
            return e
    raise HTTPException(status_code=404, detail="Event not found")


def list_events(token: Optional[str]) -> list[dict]:
    """Upcoming events (not yet ended), soonest first."""
    now = _now()
    with _lock:
        events = _load()
    upcoming = [e for e in events if datetime.fromisoformat(f"{e['date']}T{e['end']}") > now]
    upcoming.sort(key=lambda e: (e["date"], e["start"]))
    return [_public(e, token) for e in upcoming]


def create_event(body: NewEvent) -> dict:
    event = body.model_dump(exclude={"token"})
    event.update(
        id=secrets.token_urlsafe(6), date=body.date.isoformat(),
        invite_code=_code() if body.invite_only else None,
        host_token=body.token, example=False,
        going=[{"token": body.token, "name": body.host}],
    )
    with _lock:
        events = _load()
        events.append(event)
        _save(events)
    return _public(event, body.token)


def join_event(event_id: str, body: JoinRequest) -> dict:
    with _lock:
        events = _load()
        e = _find(events, event_id)
        if not any(g["token"] == body.token for g in e["going"]):
            if e["invite_only"] and (body.code or "").strip().upper() != e["invite_code"]:
                raise HTTPException(status_code=403, detail="Wrong invite code")
            if e["spots"] and len(e["going"]) >= e["spots"]:
                raise HTTPException(status_code=409, detail="Event is full")
            e["going"].append({"token": body.token, "name": body.name.strip()})
            _save(events)
    return _public(e, body.token)


def leave_event(event_id: str, body: TokenRequest) -> dict:
    with _lock:
        events = _load()
        e = _find(events, event_id)
        if body.token == e["host_token"]:
            raise HTTPException(status_code=400, detail="Hosts cancel instead of leaving")
        e["going"] = [g for g in e["going"] if g["token"] != body.token]
        _save(events)
    return _public(e, body.token)


def cancel_event(event_id: str, body: TokenRequest) -> None:
    with _lock:
        events = _load()
        e = _find(events, event_id)
        if body.token != e["host_token"]:
            raise HTTPException(status_code=403, detail="Only the host can cancel")
        events.remove(e)
        _save(events)
