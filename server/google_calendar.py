import asyncio
import base64
from collections import deque
from contextlib import contextmanager
import hashlib
import os
import secrets
import sqlite3
import time
from datetime import date, datetime, time as day_time, timedelta
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

COOKIE_NAME = "busy_calendar_session"
SCOPE = "https://www.googleapis.com/auth/calendar.freebusy"
TOKEN_URL = "https://oauth2.googleapis.com/token"
FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy"
SESSION_TTL = 30 * 24 * 60 * 60
PENDING_TTL = 10 * 60  # an authorization nobody finished
RATE_LIMIT = 30  # calendar requests per session (or client address) per RATE_WINDOW
RATE_WINDOW = 60
RETRY_DELAYS = (0.5, 1.0)  # backoff before each retry of a temporary Google failure
RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"}
_rate_buckets = {}
_sleep = asyncio.sleep


def _rate_limit(request: Request):
    """In-memory sliding window, so one browser can't spend the app's Google quota.

    Per process: with several server instances each one keeps its own count.
    """
    session = request.cookies.get(COOKIE_NAME)
    key = _session_hash(session) if session else f"ip:{request.client.host if request.client else 'unknown'}"
    now = time.monotonic()
    if len(_rate_buckets) > 10_000:
        for stale in [k for k, hits in _rate_buckets.items() if not hits or hits[-1] < now - RATE_WINDOW]:
            del _rate_buckets[stale]
    hits = _rate_buckets.setdefault(key, deque())
    while hits and hits[0] < now - RATE_WINDOW:
        hits.popleft()
    if len(hits) >= RATE_LIMIT:
        retry_after = max(1, int(hits[0] + RATE_WINDOW - now) + 1)
        raise HTTPException(
            status_code=429,
            detail="Too many calendar requests. Please wait a minute and retry.",
            headers={"Retry-After": str(retry_after)},
        )
    hits.append(now)


# /status only reads the local session table, so it is not limited: page loads call it, and
# signed-out visitors behind one proxy would otherwise share a single address bucket.
router = APIRouter(prefix="/api/calendar", tags=["calendar"])
LIMITED = [Depends(_rate_limit)]


class FreeBusyRequest(BaseModel):
    date: date
    timezone: str = Field(min_length=1, max_length=100)
    days: int = Field(default=1, ge=1, le=7)


class CalendarConnectRequest(BaseModel):
    return_url: str = Field(min_length=1, max_length=2000)


def _config():
    return {
        "client_id": os.getenv("GOOGLE_CLIENT_ID"),
        "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
        "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI"),
        "frontend_origin": os.getenv("CALENDAR_FRONTEND_ORIGIN"),
        "frontend_url": os.getenv("CALENDAR_FRONTEND_URL"),
        "encryption_key": os.getenv("CALENDAR_TOKEN_ENCRYPTION_KEY"),
        "database": os.getenv(
            "CALENDAR_SESSION_DB",
            str(Path(__file__).with_name("calendar_sessions.sqlite3")),
        ),
    }


def _configured(config=None):
    values = config or _config()
    if not all(values[key] for key in (
        "client_id", "client_secret", "redirect_uri", "frontend_origin", "encryption_key",
    )):
        return False
    try:
        frontend_url = values["frontend_url"] or values["frontend_origin"].rstrip("/") + "/"
        frontend = urlsplit(frontend_url)
        frontend_origin = urlsplit(values["frontend_origin"])
        redirect = urlsplit(values["redirect_uri"])
    except ValueError:
        return False
    local = frontend_origin.hostname in {"localhost", "127.0.0.1"}
    valid_urls = (
        frontend.scheme in (("http", "https") if local else ("https",))
        and f"{frontend.scheme}://{frontend.netloc}" == values["frontend_origin"].rstrip("/")
        and frontend.username is None
        and frontend.password is None
        and frontend.path.endswith("/")
        and not frontend.query
        and not frontend.fragment
        and redirect.scheme in (("http", "https") if redirect.hostname in {"localhost", "127.0.0.1"} else ("https",))
        and bool(redirect.netloc)
        and redirect.username is None
        and redirect.password is None
        and redirect.path == "/api/calendar/callback"
        and not redirect.query
        and not redirect.fragment
    )
    if not valid_urls:
        return False
    try:
        Fernet(values["encryption_key"].encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return False
    return True


def _require_config():
    config = _config()
    if not _configured(config):
        raise HTTPException(status_code=503, detail="Google Calendar is not configured on this server.")
    return config


def _fernet(config):
    return Fernet(config["encryption_key"].encode("ascii"))


@contextmanager
def _database(config):
    path = Path(config["database"])
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    try:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS calendar_sessions (
                session_hash TEXT PRIMARY KEY,
                state_hash TEXT,
                code_verifier TEXT,
                access_token BLOB,
                refresh_token BLOB,
                expires_at REAL,
                frontend_query TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            )
        """)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(calendar_sessions)")}
        if "frontend_query" not in columns:
            connection.execute("ALTER TABLE calendar_sessions ADD COLUMN frontend_query TEXT NOT NULL DEFAULT ''")
        connection.execute("DELETE FROM calendar_sessions WHERE created_at < ?", (time.time() - SESSION_TTL,))
        connection.execute(
            "DELETE FROM calendar_sessions WHERE refresh_token IS NULL AND created_at < ?",
            (time.time() - PENDING_TTL,),
        )
        connection.commit()
        try:
            path.chmod(0o600)
        except OSError:
            raise HTTPException(status_code=503, detail="Calendar session storage permissions could not be secured.")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _session_hash(session_id):
    return hashlib.sha256(session_id.encode("ascii")).hexdigest()


def _encoded_hash(value):
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def _cookie_options(request):
    is_local = request.url.hostname in {"localhost", "127.0.0.1"}
    return {
        "httponly": True,
        "secure": not is_local,
        "samesite": "none" if not is_local else "lax",
        "path": "/api/calendar",
        "max_age": SESSION_TTL,
    }


def _check_origin(request, config):
    if request.headers.get("origin") != config["frontend_origin"].rstrip("/"):
        raise HTTPException(status_code=403, detail="Calendar request origin is not allowed.")


def _b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _frontend_redirect(config, error=None, query=""):
    frontend_url = config["frontend_url"] or config["frontend_origin"].rstrip("/") + "/"
    destination = frontend_url + query
    if error:
        destination += ("&" if "?" in query else "?") + "calendar_error=" + error
    return destination + "#/calendar"


def _frontend_query(return_url, configured_origin):
    try:
        parsed = urlsplit(return_url)
    except ValueError:
        raise HTTPException(status_code=400, detail="Calendar return URL is invalid.")
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    config = _config()
    frontend_url = config["frontend_url"] or configured_origin.rstrip("/") + "/"
    base_path = urlsplit(frontend_url).path
    if origin != configured_origin.rstrip("/") or parsed.path != base_path:
        raise HTTPException(status_code=400, detail="Calendar return URL must be the configured BU-sy page.")
    api = parse_qs(parsed.query).get("api", [])
    if not api:
        return ""
    try:
        api_url = urlsplit(api[0])
    except ValueError:
        raise HTTPException(status_code=400, detail="Calendar API URL is invalid.")
    api_is_local = api_url.hostname in {"localhost", "127.0.0.1"}
    valid_api_scheme = api_url.scheme == "https" or (api_is_local and api_url.scheme == "http")
    if not valid_api_scheme or not api_url.netloc or api_url.username or api_url.password \
            or api_url.query or api_url.fragment:
        raise HTTPException(status_code=400, detail="Calendar API URL is invalid.")
    return "?" + urlencode({"api": api[0]})


async def oauth_post(data):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(TOKEN_URL, data=data)
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Google authorization service is temporarily unavailable.")
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = {}
        return response.status_code, body
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {}


async def _calendar_post(access_token, body):
    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.post(
            FREEBUSY_URL,
            json=body,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    return response.status_code, payload


def _rate_limited(status_code, result):
    if status_code == 429:
        return True
    if status_code != 403:
        return False
    error_body = result.get("error", {}) if isinstance(result, dict) else {}
    errors = error_body.get("errors", []) if isinstance(error_body, dict) else []
    return bool({error.get("reason") for error in errors if isinstance(error, dict)} & RATE_REASONS)


async def _calendar_post_with_retry(access_token, body):
    """FreeBusy with bounded exponential backoff for temporary failures (network, 5xx, rate limits)."""
    for delay in (*RETRY_DELAYS, None):
        try:
            status_code, result = await _calendar_post(access_token, body)
        except httpx.RequestError:
            if delay is None:
                raise
        else:
            if not (status_code >= 500 or _rate_limited(status_code, result)) or delay is None:
                return status_code, result
        await _sleep(delay)


async def revoke_google_token(refresh_token):
    async with httpx.AsyncClient(timeout=8) as client:
        return await client.post(
            "https://oauth2.googleapis.com/revoke",
            params={"token": refresh_token},
        )


def _load_session(config, session_id):
    if not session_id:
        return None
    with _database(config) as db:
        return db.execute(
            "SELECT session_hash, state_hash, code_verifier, access_token, refresh_token, expires_at, frontend_query "
            "FROM calendar_sessions WHERE session_hash = ?",
            (_session_hash(session_id),),
        ).fetchone()


@router.get("/status")
def calendar_status(busy_calendar_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME)):
    config = _config()
    if not _configured(config):
        return {"configured": False, "connected": False}
    session = _load_session(config, busy_calendar_session)
    return {"configured": True, "connected": bool(session and session[4])}


@router.post("/connect", dependencies=LIMITED)
def calendar_connect(
    request: Request,
    response: Response,
    body: CalendarConnectRequest,
    busy_calendar_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    config = _require_config()
    _check_origin(request, config)
    session_id = secrets.token_urlsafe(32)
    state = secrets.token_urlsafe(32)
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    frontend_query = _frontend_query(body.return_url, config["frontend_origin"])
    with _database(config) as db:
        if busy_calendar_session:
            db.execute(
                "DELETE FROM calendar_sessions WHERE session_hash = ?",
                (_session_hash(busy_calendar_session),),
            )
        db.execute(
            "INSERT OR REPLACE INTO calendar_sessions "
            "(session_hash, state_hash, code_verifier, access_token, refresh_token, expires_at, frontend_query, created_at) "
            "VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)",
            (_session_hash(session_id), _encoded_hash(state), verifier, frontend_query, time.time()),
        )
    response.set_cookie(COOKIE_NAME, session_id, **_cookie_options(request))
    query = urlencode({
        "client_id": config["client_id"],
        "redirect_uri": config["redirect_uri"],
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    return {"authorization_url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}"}


@router.get("/callback", dependencies=LIMITED)
async def calendar_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    busy_calendar_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    config = _require_config()
    if not busy_calendar_session:
        return Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization")})
    session_hash = _session_hash(busy_calendar_session)
    session = _load_session(config, busy_calendar_session)
    if not state or not session or not secrets.compare_digest(session[1] or "", _encoded_hash(state)):
        frontend_query = session[6] if session else ""
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization", frontend_query)})
        return response
    if error:
        frontend_query = session[6]
        with _database(config) as db:
            db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session_hash,))
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "denied", frontend_query)})
        response.delete_cookie(COOKIE_NAME, path="/api/calendar")
        return response
    if not code:
        frontend_query = session[6] if session else ""
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization", frontend_query)})
        response.delete_cookie(COOKIE_NAME, path="/api/calendar")
        return response
    try:
        status_code, payload = await oauth_post({
            "code": code,
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
            "redirect_uri": config["redirect_uri"],
            "grant_type": "authorization_code",
            "code_verifier": session[2],
        })
    except HTTPException:
        with _database(config) as db:
            db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session_hash,))
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization", session[6])})
        response.delete_cookie(COOKIE_NAME, path="/api/calendar")
        return response
    if status_code >= 400 or not payload.get("access_token"):
        with _database(config) as db:
            db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session_hash,))
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization", session[6])})
        response.delete_cookie(COOKIE_NAME, path="/api/calendar")
        return response

    refresh_token = payload.get("refresh_token")
    if not refresh_token:
        with _database(config) as db:
            db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session_hash,))
        response = Response(status_code=303, headers={"Location": _frontend_redirect(config, "authorization", session[6])})
        response.delete_cookie(COOKIE_NAME, path="/api/calendar")
        return response
    encrypted_access = _fernet(config).encrypt(payload["access_token"].encode("utf-8"))
    encrypted_refresh = _fernet(config).encrypt(refresh_token.encode("utf-8"))
    with _database(config) as db:
        db.execute(
            "UPDATE calendar_sessions SET state_hash = NULL, code_verifier = NULL, "
            "access_token = ?, refresh_token = ?, expires_at = ? WHERE session_hash = ?",
            (encrypted_access, encrypted_refresh, time.time() + int(payload.get("expires_in", 3600)), session_hash),
        )
    return Response(status_code=303, headers={"Location": _frontend_redirect(config, query=session[6])})


def _decrypt_tokens(config, session):
    try:
        fernet = _fernet(config)
        return fernet.decrypt(session[3]).decode("utf-8"), fernet.decrypt(session[4]).decode("utf-8")
    except (InvalidToken, TypeError, UnicodeDecodeError):
        raise HTTPException(status_code=401, detail="Calendar authorization needs to be reconnected.")


async def _refresh_access_token(config, session):
    _, refresh_token = _decrypt_tokens(config, session)
    status_code, payload = await oauth_post({
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    })
    if status_code >= 400 or not payload.get("access_token"):
        if payload.get("error") == "invalid_grant":
            with _database(config) as db:
                db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session[0],))
            raise HTTPException(status_code=401, detail="Google authorization expired or was revoked. Reconnect your calendar.")
        raise HTTPException(status_code=503, detail="Google Calendar could not refresh authorization. Please retry.")
    access = payload["access_token"]
    encrypted_access = _fernet(config).encrypt(access.encode("utf-8"))
    with _database(config) as db:
        db.execute(
            "UPDATE calendar_sessions SET access_token = ?, expires_at = ? WHERE session_hash = ?",
            (encrypted_access, time.time() + int(payload.get("expires_in", 3600)), session[0]),
        )
    return access


async def _valid_access_token(config, session):
    if not session or not session[4]:
        raise HTTPException(status_code=401, detail="Connect Google Calendar to check availability.")
    if session[5] is not None and session[5] > time.time() + 60:
        return _decrypt_tokens(config, session)[0]
    return await _refresh_access_token(config, session)


@router.post("/freebusy", dependencies=LIMITED)
async def calendar_freebusy(
    request: Request,
    body: FreeBusyRequest,
    busy_calendar_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    config = _require_config()
    _check_origin(request, config)
    try:
        timezone = ZoneInfo(body.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(status_code=422, detail="Choose a valid IANA timezone.")
    session = _load_session(config, busy_calendar_session)
    access_token = await _valid_access_token(config, session)
    day_start = datetime.combine(body.date, day_time.min, tzinfo=timezone)
    day_end = datetime.combine(body.date + timedelta(days=body.days), day_time.min, tzinfo=timezone)
    payload = {
        "timeMin": day_start.isoformat(),
        "timeMax": day_end.isoformat(),
        "timeZone": body.timezone,
        "items": [{"id": "primary"}],
    }
    try:
        status_code, result = await _calendar_post_with_retry(access_token, payload)
        if status_code == 401:
            access_token = await _refresh_access_token(config, session)
            status_code, result = await _calendar_post_with_retry(access_token, payload)
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Google Calendar is temporarily unreachable. Please retry.")
    if status_code == 401:
        with _database(config) as db:
            db.execute("DELETE FROM calendar_sessions WHERE session_hash = ?", (session[0],))
        raise HTTPException(status_code=401, detail="Google authorization expired or was revoked. Reconnect your calendar.")
    if status_code == 429:
        raise HTTPException(status_code=429, detail="Google Calendar is busy. Please wait and retry.")
    if _rate_limited(status_code, result):
        raise HTTPException(status_code=429, detail="Google Calendar's quota is temporarily exceeded. Please wait and retry.")
    if status_code >= 400:
        raise HTTPException(status_code=502, detail="Google Calendar could not return availability.")
    calendar = result.get("calendars", {}).get("primary")
    if not calendar or calendar.get("errors"):
        raise HTTPException(status_code=502, detail="Google Calendar could not read the primary calendar.")
    return {
        "date": body.date.isoformat(),
        "days": body.days,
        "timezone": body.timezone,
        "busy": [
            {"start": interval["start"], "end": interval["end"]}
            for interval in calendar.get("busy", [])
        ],
    }


@router.delete("/disconnect", status_code=204, dependencies=LIMITED)
async def calendar_disconnect(
    request: Request,
    response: Response,
    busy_calendar_session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    config = _require_config()
    _check_origin(request, config)
    session = _load_session(config, busy_calendar_session)
    refresh_token = None
    if session and session[4]:
        try:
            refresh_token = _decrypt_tokens(config, session)[1]
        except HTTPException as error:
            if error.status_code != 401:
                raise
    if busy_calendar_session:
        with _database(config) as db:
            db.execute(
                "DELETE FROM calendar_sessions WHERE session_hash = ?",
                (_session_hash(busy_calendar_session),),
            )
    response.delete_cookie(COOKIE_NAME, path="/api/calendar")
    if refresh_token:
        try:
            revoked = await revoke_google_token(refresh_token)
        except httpx.RequestError:
            raise HTTPException(
                status_code=503,
                detail="Disconnected from BU-sy, but Google could not be reached to revoke access. Revoke BU-sy in your Google Account settings.",
            )
        if not (200 <= revoked.status_code < 300 or revoked.status_code == 400):
            raise HTTPException(
                status_code=503,
                detail="Disconnected from BU-sy, but Google could not confirm revocation. Revoke BU-sy in your Google Account settings.",
            )
