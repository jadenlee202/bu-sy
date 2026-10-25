"""Unofficial, student-run events ("basketball run on court 4 at 6").

Stored in server/community_events.json (created on first run, git-ignored).
People are identified only by a random per-device token plus a nickname they
type; no accounts, no campus identity. That token is *identification, not
authentication*: whoever holds it can act as that device. It travels in POST
bodies or an X-BUsy-Device header, never in a URL, so it stays out of access logs.

Invite-only is a sign-up gate, not privacy: every event's title, place and
time are visible to everyone. Codes (8 characters, ~1e12 combinations) are
only ever returned to the host. Attendee names and tokens are never returned.

One process only: the lock below does not coordinate several uvicorn workers.
"""
import json
import os
import re
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

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
MAX_DAYS_AHEAD = 60
MAX_ATTENDEES = 200          # also the cap when the host leaves "spots" empty
MAX_UPCOMING = 300           # creation is refused beyond this (disk/spam guard)
KEEP_ENDED = timedelta(days=1)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _now() -> datetime:
    return datetime.now(CAMPUS_TZ).replace(tzinfo=None)

# Example events, dated relative to "today" so the demo never looks stale.
SEED_EVENTS = [
    {"title": "Pickup basketball run", "place": "FitRec", "note": "Floor 2 courts",
     "day_offset": 0, "start": "18:00", "end": "20:00", "spots": 10, "invite_only": False, "going": 6},
    {"title": "Morning lift partners", "place": "FitRec", "note": "Floor 1 weight room, by the racks",
     "day_offset": 1, "start": "07:00", "end": "08:00", "spots": 4, "invite_only": False, "going": 1},
    {"title": "Bouldering crew", "place": "FitRec", "note": "Climbing wall, beginners welcome",
     "day_offset": 2, "start": "19:00", "end": "21:00", "spots": 8, "invite_only": True, "going": 3},
]


def _clean(v):
    """Trim before length checks, so "   " counts as empty; refuse control characters."""
    if isinstance(v, str):
        v = v.strip()
        if CONTROL_CHARS.search(v):
            raise ValueError("must not contain control characters")
    return v


class NewEvent(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    place: str = Field(min_length=1, max_length=60)
    note: str = Field("", max_length=80)
    date: date
    start: str = Field(pattern=HHMM)
    end: str = Field(pattern=HHMM)
    host: str = Field(min_length=1, max_length=30)
    spots: Optional[int] = Field(None, ge=2, le=MAX_ATTENDEES)
    invite_only: bool = False
    token: str = Field(min_length=8, max_length=64)

    _strip = field_validator("title", "place", "note", "host", mode="before")(_clean)

    @model_validator(mode="after")
    def check_times(self):
        if self.end <= self.start:
            raise ValueError("end must be after start")
        if _ends_at(self.date.isoformat(), self.end) <= _now():
            raise ValueError("that time has already passed")
        if self.date > _now().date() + timedelta(days=MAX_DAYS_AHEAD):
            raise ValueError(f"events can be at most {MAX_DAYS_AHEAD} days ahead")
        return self


class JoinRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)
    name: str = Field(min_length=1, max_length=30)
    code: Optional[str] = Field(None, max_length=16)

    _strip = field_validator("name", mode="before")(_clean)


class TokenRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)


def _code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def _norm_code(code: Optional[str]) -> str:
    """Case, spaces and dashes don't matter when typing a code."""
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def _ends_at(day: str, end: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{end}")


def _ended(e: dict, now: datetime) -> bool:
    """Ended, or unreadable (an old store written before validation): never joinable."""
    try:
        return _ends_at(e["date"], e["end"]) <= now
    except (KeyError, TypeError, ValueError):
        return True


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
            # Shorter than any accepted token, so nobody can leave on their behalf.
            "going": [{"token": f"ex{k}", "name": "Example"} for k in range(s["going"])],
        })
    return events


def _load() -> list[dict]:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=503, detail="Meetup storage is unreadable. "
                                "Delete server/community_events.json to reset it.")
    events = _seed()
    _save(events)
    return events


def _save(events: list[dict]) -> None:
    """Write-then-rename, so a crash mid-write never leaves a half-written file."""
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(events, indent=2), encoding="utf-8")
    os.replace(tmp, STORE)


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
    upcoming = [e for e in events if not _ended(e, now)]
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
        now = _now()
        events = [e for e in _load() if not _ended(e, now - KEEP_ENDED)]  # prune old ones
        if sum(not _ended(e, now) for e in events) >= MAX_UPCOMING:
            raise HTTPException(status_code=503, detail="Too many upcoming events right now. Try again later.")
        events.append(event)
        _save(events)
    return _public(event, body.token)


def join_event(event_id: str, body: JoinRequest) -> dict:
    with _lock:
        events = _load()
        e = _find(events, event_id)
        if not any(g["token"] == body.token for g in e["going"]):
            if _ended(e, _now()):
                raise HTTPException(status_code=410, detail="This event has already ended")
            if e["invite_only"] and not secrets.compare_digest(_norm_code(body.code), _norm_code(e["invite_code"])):
                raise HTTPException(status_code=403, detail="Wrong invite code")
            if len(e["going"]) >= (e["spots"] or MAX_ATTENDEES):
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
