"""Club directory: browse student clubs, apply, waitlist, and organizer review.

Stored in server/clubs.json (created on first run, git-ignored). Same identity
model as community_events.py: a random per-device token, no accounts. Whoever
creates a club is its organizer: their token becomes `organizer_token`, and only
that token can edit the club or read and decide its applications. That is
demo-grade gating (identification, not authentication), and the UI says so.

Privacy: applications (name, school email, year, optional notes) are returned
only to the club's organizer, and each student only ever gets their own
application back. Tokens are never returned.

Capacity: an approved member or a pending application holds a spot. A full club
offers its waitlist (the student asks for it explicitly), never an unbounded
join. When a spot frees up, the first waitlisted student moves up: to pending if
the club needs officer approval, otherwise to approved. All of this happens
under one lock, so concurrent sign-ups can't overfill a club.

Busyness hint: an estimate for the club's meeting place and time from the
simulated campus data (analytics.time_weighted_mean). See meeting_busyness().
"""
import json
import math
import os
import re
import secrets
import threading
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from analytics import THRESHOLD_NOTE, time_weighted_mean
from sources import Facility

STORE = Path(__file__).resolve().parent / "clubs.json"
_lock = threading.Lock()
CAMPUS_TZ = ZoneInfo("America/New_York")

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
CATEGORIES = ["Sports", "Academic", "Cultural", "Arts", "Volunteer", "Social", "Professional"]
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
YEARS = ["First-year", "Sophomore", "Junior", "Senior", "Graduate", "Other"]
Category = Literal["Sports", "Academic", "Cultural", "Arts", "Volunteer", "Social", "Professional"]
Day = Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
Year = Literal["First-year", "Sophomore", "Junior", "Senior", "Graduate", "Other"]
SCHOOL_EMAIL = re.compile(r"^[A-Za-z0-9._%+-]+@bu\.edu$", re.IGNORECASE)
CONTROL_CHARS = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")   # newlines allowed in long text only
LINE_CHARS = re.compile(r"[\x00-\x1f\x7f]")

MAX_MEMBERS = 500            # also the cap when an organizer leaves capacity empty
MAX_WAITLIST = 100
MAX_CLUBS = 300              # creation is refused beyond this (disk/spam guard)
MAX_APPLICATIONS = 2000      # per club, every status included
MAX_UPCOMING_DAYS = 180
MIN_COVERAGE = 0.5           # the hint needs simulated data for at least half the meeting

# Sample clubs everyone sees. Names are generic on purpose: these are demo data, not BU clubs.
# `members`/`waitlisted` become placeholder entries with no personal data.
SEED_CLUBS = [
    {"name": "Charles River Run Club", "category": "Sports",
     "description": "Easy-pace group runs along the river, 3 to 5 miles. All speeds welcome; nobody gets left behind.",
     "activities": "Weekly group runs, a monthly long run, a spring 5K as a team.",
     "meeting_day": "Tuesday", "meeting_start": "18:00", "meeting_end": "19:00", "location_id": "fitrec-synthetic",
     "location_text": "Meet at the FitRec main entrance", "officers": [{"role": "President", "name": "Sample officer"}],
     "contact": "", "requirements": "Comfortable running 3 miles.", "requires_approval": False,
     "capacity": 40, "waitlist": True, "members": 18, "waitlisted": 0},
    {"name": "Data Science Study Circle", "category": "Academic",
     "description": "Small study group working through statistics and Python problems together before exams.",
     "activities": "Problem sets, short peer talks, mock interview questions.",
     "meeting_day": "Wednesday", "meeting_start": "19:00", "meeting_end": "20:30", "location_id": "mugar-synthetic",
     "location_text": "Mugar Library, group study area", "officers": [{"role": "Organizer", "name": "Sample officer"}],
     "contact": "", "requirements": "Taking or finished an intro statistics course.", "requires_approval": True,
     "capacity": 12, "waitlist": True, "members": 12, "waitlisted": 2},
    {"name": "Pickup Volleyball", "category": "Sports",
     "description": "Casual 6v6 games. Rotating teams every set.",
     "activities": "Open games; a beginner drill for the first 15 minutes.",
     "meeting_day": "Friday", "meeting_start": "17:00", "meeting_end": "19:00", "location_id": "fitrec-synthetic",
     "location_text": "FitRec courts", "officers": [], "contact": "", "requirements": "",
     "requires_approval": False, "capacity": 16, "waitlist": False, "members": 16, "waitlisted": 0},
    {"name": "Film Photography Society", "category": "Arts",
     "description": "Shoot, develop and share film photos. Loaner cameras for new members.",
     "activities": "Photo walks, darkroom basics, an end-of-semester show.",
     "meeting_day": "Thursday", "meeting_start": "18:30", "meeting_end": "20:00", "location_id": None,
     "location_text": "", "officers": [], "contact": "", "requirements": "",
     "requires_approval": False, "capacity": None, "waitlist": True, "members": 7, "waitlisted": 0},
    {"name": "Global Food Exchange", "category": "Cultural",
     "description": "Share a dish from home and the story behind it. Different region each week.",
     "activities": "Potluck lunches, cooking demos, a cultural night in the spring.",
     "meeting_day": "Sunday", "meeting_start": "12:00", "meeting_end": "13:30", "location_id": "marciano-dining-synthetic",
     "location_text": "Marciano Commons", "officers": [{"role": "Co-chair", "name": "Sample officer"}],
     "contact": "", "requirements": "", "requires_approval": False,
     "capacity": 30, "waitlist": True, "members": 9, "waitlisted": 0},
    {"name": "Weekend Volunteers", "category": "Volunteer",
     "description": "Saturday morning volunteering with local food banks and park cleanups.",
     "activities": "One service project each weekend; transit directions shared beforehand.",
     "meeting_day": "Saturday", "meeting_start": "09:00", "meeting_end": "12:00", "location_id": None,
     "location_text": "Off campus (varies by project)", "officers": [], "contact": "",
     "requirements": "Sign a volunteer waiver at your first project.", "requires_approval": True,
     "capacity": 25, "waitlist": True, "members": 6, "waitlisted": 0},
    {"name": "Consulting Case Prep", "category": "Professional",
     "description": "Practice case interviews in pairs with feedback.",
     "activities": "Live case practice, resume reviews, alumni Q&A.",
     "meeting_day": "Monday", "meeting_start": "19:00", "meeting_end": "20:00", "location_id": "mugar-synthetic",
     "location_text": "Mugar Library", "officers": [{"role": "President", "name": "Sample officer"},
                                                    {"role": "Treasurer", "name": "Sample officer"}],
     "contact": "", "requirements": "", "requires_approval": True,
     "capacity": 20, "waitlist": True, "members": 5, "waitlisted": 0},
    {"name": "Board Game Night", "category": "Social",
     "description": "Strategy and party games. Bring one or play ours.",
     "activities": "", "meeting_day": None, "meeting_start": None, "meeting_end": None, "location_id": None,
     "location_text": "", "officers": [], "contact": "", "requirements": "",
     "requires_approval": False, "capacity": None, "waitlist": True, "members": 3, "waitlisted": 0},
]


def _now() -> datetime:
    return datetime.now(CAMPUS_TZ).replace(tzinfo=None)


def _clean_line(v):
    """Trim before length checks, so "   " counts as empty; refuse control characters."""
    if isinstance(v, str):
        v = v.strip()
        if LINE_CHARS.search(v):
            raise ValueError("must not contain line breaks or control characters")
    return v


def _clean_text(v):
    """Like _clean_line, but a long text may keep line breaks."""
    if isinstance(v, str):
        v = v.strip().replace("\r\n", "\n")
        if CONTROL_CHARS.search(v):
            raise ValueError("must not contain control characters")
    return v


# ---------- input models ----------
class Officer(BaseModel):
    role: str = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1, max_length=60)

    _strip = field_validator("role", "name", mode="before")(_clean_line)


class Meeting(BaseModel):
    date: date
    note: str = Field("", max_length=80)

    _strip = field_validator("note", mode="before")(_clean_line)


class ClubFields(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    category: Category
    description: str = Field(min_length=1, max_length=600)
    activities: str = Field("", max_length=400)
    meeting_day: Optional[Day] = None
    meeting_start: Optional[str] = Field(None, pattern=HHMM)
    meeting_end: Optional[str] = Field(None, pattern=HHMM)
    location_id: Optional[str] = Field(None, max_length=64)
    location_text: str = Field("", max_length=80)
    officers: list[Officer] = Field(default_factory=list, max_length=5)
    contact: str = Field("", max_length=80)
    requirements: str = Field("", max_length=300)
    requires_approval: bool = False
    capacity: Optional[int] = Field(None, ge=1, le=MAX_MEMBERS)
    waitlist: bool = True
    upcoming: list[Meeting] = Field(default_factory=list, max_length=5)
    token: str = Field(min_length=8, max_length=64)

    _strip_line = field_validator("name", "location_text", "contact", mode="before")(_clean_line)
    _strip_text = field_validator("description", "activities", "requirements", mode="before")(_clean_text)

    @model_validator(mode="after")
    def check_schedule(self):
        if (self.meeting_start is None) != (self.meeting_end is None):
            raise ValueError("give both a start and an end time, or neither")
        if self.meeting_start and self.meeting_end <= self.meeting_start:
            raise ValueError("end must be after start")
        today = _now().date()
        for m in self.upcoming:
            if not today <= m.date <= today + timedelta(days=MAX_UPCOMING_DAYS):
                raise ValueError(f"upcoming meetings must be between today and {MAX_UPCOMING_DAYS} days ahead")
        return self


class Application(BaseModel):
    token: str = Field(min_length=8, max_length=64)
    name: str = Field(min_length=1, max_length=60)
    email: str = Field(min_length=6, max_length=80)
    year: Year
    contact: str = Field("", max_length=80)
    reason: str = Field("", max_length=500)
    availability: str = Field("", max_length=120)
    join_waitlist: bool = False

    _strip_line = field_validator("name", "email", "contact", "availability", mode="before")(_clean_line)
    _strip_text = field_validator("reason", mode="before")(_clean_text)

    @field_validator("email")
    @classmethod
    def school_email(cls, v: str) -> str:
        if not SCHOOL_EMAIL.match(v):
            raise ValueError("use your school email (name@bu.edu)")
        return v.lower()


class TokenRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)


class Decision(BaseModel):
    token: str = Field(min_length=8, max_length=64)
    decision: Literal["approve", "reject"]


# ---------- busyness hint (data science) ----------
def meeting_busyness(f: Optional[Facility], start: Optional[str], end: Optional[str]) -> Optional[dict]:
    """How busy the club's meeting place tends to be during its meeting time, as an ESTIMATE.

    Time-weighted mean count over [start, end) on the facility's simulated demo day
    (analytics.time_weighted_mean, same gap rule as everywhere else), classified with
    the shared demo thresholds. Only campus (synthetic) places qualify; historical
    references never do. The simulation covers one Monday, so the club's weekday is not
    modeled: the basis says so. None when there is no place or no time to estimate for.
    """
    if f is None or not f.campus_eligible or not start or not end:
        return None
    day = f.default_day
    a = f.at(day, time.fromisoformat(start))
    b = f.at(day, time.fromisoformat(end))
    mean, covered = time_weighted_mean(f.days[day], a, b, f.coverage_end(day), f.max_hold)
    share = covered / (b - a).total_seconds()
    when = f"{start}–{end}"
    if mean is None or share < MIN_COVERAGE:
        return {"level": "unknown", "estimate": None, "capacity": f.capacity, "coverage": _half_up(share * 100) / 100,
                "label": "No estimate", "basis": f"Not enough simulated data at {f.facility_name}, {when}."}
    level = f.level(mean)
    return {
        "level": level, "estimate": _half_up(mean), "capacity": f.capacity, "coverage": _half_up(share * 100) / 100,
        "label": f"Usually {level} then (estimate)",
        "basis": (f"Estimate: about {_half_up(mean):,} people on average at {f.facility_name}, {when}, on the simulated "
                  f"demo Monday ({_half_up(mean / f.capacity * 100)}% of an illustrative capacity of {f.capacity:,}). "
                  f"Time-weighted, {_half_up(share * 100)}% of the meeting covered; {THRESHOLD_NOTE}. "
                  "Simulated, not a BU measurement, and the meeting's weekday isn't modeled."),
    }


def _half_up(x: float) -> int:
    """Round halves up (like JS Math.round), so static mode shows the same numbers."""
    return math.floor(x + 0.5)


def options(facilities: dict[str, Facility]) -> dict:
    """Choices and limits the static-mode mirror (web/js/source.js) must match."""
    return {
        "categories": CATEGORIES, "days": DAYS, "years": YEARS,
        "locations": [{"id": f.facility_id, "name": f.facility_name} for f in facilities.values() if f.campus_eligible],
        "limits": {"name": 60, "description": 600, "activities": 400, "location_text": 80, "officers": 5,
                   "officer_role": 30, "officer_name": 60, "contact": 80, "requirements": 300, "upcoming": 5,
                   "note": 80, "capacity": MAX_MEMBERS, "waitlist": MAX_WAITLIST, "upcoming_days": MAX_UPCOMING_DAYS,
                   "applicant_name": 60, "email": 80, "reason": 500, "availability": 120, "clubs": MAX_CLUBS},
    }


def static_seed(facilities: dict[str, Facility]) -> dict:
    """For web/data/clubs_seed.json: sample clubs with counts (no placeholders, no tokens) and
    their busyness hints computed here, so static mode shows the same estimates as the API."""
    return {
        "options": options(facilities),
        "clubs": [{**s, "busyness_hint": meeting_busyness(facilities.get(s["location_id"]), s["meeting_start"], s["meeting_end"])}
                  for s in SEED_CLUBS],
    }


# ---------- store ----------
def _placeholders(prefix: str, n: int, status: str) -> list[dict]:
    """Seed members/waitlist with no personal data. Tokens are shorter than any accepted
    token, so nobody can withdraw or act on their behalf."""
    return [{"id": f"{prefix}{k}", "token": f"{prefix}{k}", "status": status, "example": True,
             "created_at": f"2026-01-01T00:00:{k % 60:02d}"} for k in range(n)]


def _seed() -> list[dict]:
    clubs = []
    for i, s in enumerate(SEED_CLUBS):
        fields = {k: v for k, v in s.items() if k not in ("members", "waitlisted")}
        clubs.append({
            **fields, "id": f"example-{i + 1}", "upcoming": [], "organizer_token": None, "example": True,  # nobody runs a sample club
            "applications": _placeholders("m", s["members"], "approved") + _placeholders("w", s["waitlisted"], "waitlisted"),
        })
    return clubs


def _load() -> list[dict]:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=503, detail="Club storage is unreadable. Delete server/clubs.json to reset it.")
    clubs = _seed()
    _save(clubs)
    return clubs


def _save(clubs: list[dict]) -> None:
    """Write-then-rename, so a crash mid-write never leaves a half-written file."""
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(clubs, indent=2), encoding="utf-8")
    os.replace(tmp, STORE)


def _find(clubs: list[dict], club_id: str) -> dict:
    for c in clubs:
        if c["id"] == club_id:
            return c
    raise HTTPException(status_code=404, detail="Club not found")


# ---------- capacity rules ----------
HOLDS_SPOT = ("approved", "pending")
ACTIVE = ("approved", "pending", "waitlisted")


def _limit(c: dict) -> int:
    return c["capacity"] or MAX_MEMBERS


def _taken(c: dict) -> int:
    return sum(a["status"] in HOLDS_SPOT for a in c["applications"])


def _waitlist(c: dict) -> list[dict]:
    return sorted((a for a in c["applications"] if a["status"] == "waitlisted"), key=lambda a: a["created_at"])


def status_of(c: dict) -> str:
    """Open: a spot is free. Waitlist: no spot, but the waitlist takes names. Full: neither."""
    if _taken(c) < _limit(c):
        return "Open"
    if c["waitlist"] and len(_waitlist(c)) < MAX_WAITLIST:
        return "Waitlist"
    return "Full"


def _promote(c: dict) -> None:
    """Fill freed spots from the front of the waitlist, in sign-up order."""
    for a in _waitlist(c):
        if _taken(c) >= _limit(c):
            break
        a["status"] = "pending" if c["requires_approval"] else "approved"


def _mine(c: dict, token: Optional[str]) -> Optional[dict]:
    return next((a for a in c["applications"] if token and a["token"] == token), None)


def _next_meeting(c: dict, today: date) -> Optional[str]:
    if not c.get("meeting_day"):
        return None
    ahead = (DAYS.index(c["meeting_day"]) - today.weekday()) % 7
    return (today + timedelta(days=ahead)).isoformat()


def _public(c: dict, token: Optional[str], facilities: dict[str, Facility]) -> dict:
    """What anyone may see. Applications and tokens never leave except the viewer's own status."""
    mine = _mine(c, token)
    today = _now().date()
    waitlist = _waitlist(c)
    my = None
    if mine:
        my = {"id": mine["id"], "status": mine["status"], "created_at": mine["created_at"],
              "position": waitlist.index(mine) + 1 if mine["status"] == "waitlisted" else None}
    keep = ("id", "name", "category", "description", "activities", "meeting_day", "meeting_start", "meeting_end",
            "location_id", "location_text", "officers", "contact", "requirements", "requires_approval",
            "capacity", "waitlist")
    return {
        **{k: c[k] for k in keep},
        "example": c.get("example", False),
        "location_name": facilities[c["location_id"]].facility_name if c["location_id"] in facilities else None,
        "upcoming": [m for m in c["upcoming"] if m["date"] >= today.isoformat()],
        "next_meeting": _next_meeting(c, today),
        "members": sum(a["status"] == "approved" for a in c["applications"]),
        "spots_left": None if c["capacity"] is None else max(0, c["capacity"] - _taken(c)),
        "waitlist_count": len(waitlist),
        "status": status_of(c),
        "is_organizer": _is_organizer(c, token),
        "my_application": my,
        "busyness_hint": meeting_busyness(facilities.get(c["location_id"]), c["meeting_start"], c["meeting_end"]),
    }


def _is_organizer(c: dict, token: Optional[str]) -> bool:
    """A real-length token that matches. Sample clubs have no organizer, and a short header
    value (e.g. "example") never matches anything."""
    return bool(token) and len(token) >= 8 and bool(c["organizer_token"]) and secrets.compare_digest(token, c["organizer_token"])


def _organizer(c: dict, token: Optional[str]) -> None:
    if not _is_organizer(c, token):
        raise HTTPException(status_code=403, detail="Only this club's organizer can do that")


def _check_location(location_id: Optional[str], facilities: dict[str, Facility]) -> None:
    if location_id is not None and not (location_id in facilities and facilities[location_id].campus_eligible):
        raise HTTPException(status_code=422, detail="Pick a listed campus place, or none")


# ---------- operations ----------
def list_clubs(token: Optional[str], facilities: dict[str, Facility]) -> list[dict]:
    with _lock:
        clubs = _load()
    return sorted((_public(c, token, facilities) for c in clubs), key=lambda c: c["name"].lower())


def get_club(club_id: str, token: Optional[str], facilities: dict[str, Facility]) -> dict:
    with _lock:
        c = _find(_load(), club_id)
    return _public(c, token, facilities)


def create_club(body: ClubFields, facilities: dict[str, Facility]) -> dict:
    _check_location(body.location_id, facilities)
    club = {**body.model_dump(mode="json", exclude={"token"}), "id": secrets.token_urlsafe(6), "organizer_token": body.token,
            "example": False, "applications": []}
    with _lock:
        clubs = _load()
        if len(clubs) >= MAX_CLUBS:
            raise HTTPException(status_code=503, detail="Too many clubs right now. Try again later.")
        clubs.append(club)
        _save(clubs)
    return _public(club, body.token, facilities)


def edit_club(club_id: str, body: ClubFields, facilities: dict[str, Facility]) -> dict:
    _check_location(body.location_id, facilities)
    with _lock:
        clubs = _load()
        c = _find(clubs, club_id)
        _organizer(c, body.token)
        approved = sum(a["status"] == "approved" for a in c["applications"])
        if body.capacity is not None and body.capacity < approved:
            raise HTTPException(status_code=409, detail=f"{approved} members are already approved; capacity can't be lower")
        c.update(body.model_dump(mode="json", exclude={"token"}))
        _promote(c)                       # a bigger club lets the waitlist move up
        _save(clubs)
    return _public(c, body.token, facilities)


def apply(club_id: str, body: Application, facilities: dict[str, Facility]) -> dict:
    with _lock:
        clubs = _load()
        c = _find(clubs, club_id)
        if body.token == c["organizer_token"]:
            raise HTTPException(status_code=400, detail="You run this club")
        mine = _mine(c, body.token)
        if mine:
            raise HTTPException(status_code=409, detail="You already applied to this club" if mine["status"] != "rejected"
                                else "Your application to this club was declined")
        if len(c["applications"]) >= MAX_APPLICATIONS:
            raise HTTPException(status_code=503, detail="This club can't take more applications right now")
        if _taken(c) < _limit(c):
            status = "pending" if c["requires_approval"] else "approved"
        elif not c["waitlist"] or len(_waitlist(c)) >= MAX_WAITLIST:
            raise HTTPException(status_code=409, detail="This club is full and isn't taking waitlist sign-ups")
        elif not body.join_waitlist:
            raise HTTPException(status_code=409, detail="This club is full. You can join the waitlist instead")
        else:
            status = "waitlisted"
        c["applications"].append({
            "id": secrets.token_urlsafe(6), "token": body.token, "status": status,
            "created_at": _now().isoformat(timespec="microseconds"),
            **body.model_dump(include={"name", "email", "year", "contact", "reason", "availability"}),
        })
        _save(clubs)
    return _public(c, body.token, facilities)


def withdraw(club_id: str, body: TokenRequest, facilities: dict[str, Facility]) -> dict:
    with _lock:
        clubs = _load()
        c = _find(clubs, club_id)
        mine = _mine(c, body.token)
        if not mine:
            raise HTTPException(status_code=404, detail="You haven't applied to this club")
        c["applications"].remove(mine)
        _promote(c)
        _save(clubs)
    return _public(c, body.token, facilities)


def applications(club_id: str, token: Optional[str]) -> list[dict]:
    """Organizer only: every application with the details the student chose to share."""
    with _lock:
        c = _find(_load(), club_id)
    _organizer(c, token)
    waitlist = _waitlist(c)
    out = []
    for a in sorted(c["applications"], key=lambda a: a["created_at"]):
        out.append({
            "id": a["id"], "status": a["status"], "created_at": a["created_at"], "example": a.get("example", False),
            "position": waitlist.index(a) + 1 if a["status"] == "waitlisted" else None,
            **{k: a.get(k, "") for k in ("name", "email", "year", "contact", "reason", "availability")},
        })
    return out


def decide(club_id: str, app_id: str, body: Decision, facilities: dict[str, Facility]) -> dict:
    with _lock:
        clubs = _load()
        c = _find(clubs, club_id)
        _organizer(c, body.token)
        a = next((x for x in c["applications"] if x["id"] == app_id), None)
        if not a:
            raise HTTPException(status_code=404, detail="Application not found")
        if body.decision == "approve":
            if a["status"] == "approved":
                pass
            elif a["status"] == "pending":
                a["status"] = "approved"
            elif a["status"] == "waitlisted":
                if _taken(c) >= _limit(c):
                    raise HTTPException(status_code=409, detail="No spot is free. Raise the capacity or decline someone first")
                a["status"] = "approved"
            else:
                raise HTTPException(status_code=409, detail="This application was already declined")
        else:
            a["status"] = "rejected"
            _promote(c)
        _save(clubs)
    return _public(c, body.token, facilities)
