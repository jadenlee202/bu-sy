import asyncio
import sys
import logging
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import google_calendar as gc  # noqa: E402
import main  # noqa: E402

ORIGIN = "https://bu-sy.test"


@pytest.fixture
def calendar_client(tmp_path, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "https://api.test/api/calendar/callback")
    monkeypatch.setenv("CALENDAR_FRONTEND_ORIGIN", ORIGIN)
    monkeypatch.setenv("CALENDAR_FRONTEND_URL", f"{ORIGIN}/")
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("CALENDAR_SESSION_DB", str(tmp_path / "calendar.sqlite3"))
    with TestClient(main.app, base_url="https://api.test", follow_redirects=False) as client:
        yield client


def connect(calendar_client, return_url=f"{ORIGIN}/?api=https%3A%2F%2Fapi.test#/calendar"):
    response = calendar_client.post(
        "/api/calendar/connect",
        json={"return_url": return_url},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200
    authorization = parse_qs(urlsplit(response.json()["authorization_url"]).query)
    return authorization["state"][0], authorization


def authorize(calendar_client, monkeypatch):
    async def token_response(data):
        assert data["grant_type"] == "authorization_code"
        assert data["code_verifier"]
        return 200, {"access_token": "access-secret", "refresh_token": "refresh-secret", "expires_in": 3600}

    monkeypatch.setattr(gc, "oauth_post", token_response)
    state, _ = connect(calendar_client)
    response = calendar_client.get("/api/calendar/callback", params={"code": "temporary-code", "state": state})
    assert response.status_code == 303
    assert response.headers["location"] == f"{ORIGIN}/?api=https%3A%2F%2Fapi.test#/calendar"
    return state


def test_status_is_explicitly_unconfigured_without_server_credentials(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    response = TestClient(main.app).get("/api/calendar/status")
    assert response.json() == {"configured": False, "connected": False}


def test_calendar_api_requires_origin_and_authentication(calendar_client):
    no_origin = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "America/New_York"},
    )
    assert no_origin.status_code == 403
    not_connected = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "America/New_York"},
        headers={"Origin": ORIGIN},
    )
    assert not_connected.status_code == 401
    status = calendar_client.get("/api/calendar/status")
    assert status.headers["cache-control"] == "no-store"


def test_oauth_connect_uses_pkce_minimum_scope_and_validates_return_origin(calendar_client):
    _, authorization = connect(calendar_client)
    assert authorization["scope"] == [gc.SCOPE]
    assert authorization["code_challenge_method"] == ["S256"]
    assert authorization["access_type"] == ["offline"]
    assert len(authorization["code_challenge"][0]) == 43

    bad_origin = calendar_client.post(
        "/api/calendar/connect",
        json={"return_url": "https://attacker.test/"},
        headers={"Origin": ORIGIN},
    )
    assert bad_origin.status_code == 400
    blocked_origin = calendar_client.post(
        "/api/calendar/connect",
        json={"return_url": f"{ORIGIN}/"},
        headers={"Origin": "https://attacker.test"},
    )
    assert blocked_origin.status_code == 403


def test_callback_checks_state_and_preserves_external_api_query(calendar_client, monkeypatch):
    state, _ = connect(calendar_client)
    csrf = calendar_client.get("/api/calendar/callback", params={"error": "access_denied"})
    assert csrf.status_code == 303
    assert calendar_client.get("/api/calendar/status").json()["connected"] is False

    async def token_response(data):
        return 200, {"access_token": "access-secret", "refresh_token": "refresh-secret", "expires_in": 3600}

    monkeypatch.setattr(gc, "oauth_post", token_response)
    callback = calendar_client.get("/api/calendar/callback", params={"code": "temporary-code", "state": state})
    assert callback.status_code == 303
    assert callback.headers["location"] == f"{ORIGIN}/?api=https%3A%2F%2Fapi.test#/calendar"
    assert calendar_client.get("/api/calendar/status").json()["connected"] is True

    with open(gc._config()["database"], "rb") as db_file:
        persisted = db_file.read()
    assert b"access-secret" not in persisted and b"refresh-secret" not in persisted


def test_user_denial_clears_pending_oauth_session(calendar_client):
    state, _ = connect(calendar_client)
    denied = calendar_client.get(
        "/api/calendar/callback",
        params={"error": "access_denied", "state": state},
    )
    assert denied.status_code == 303
    assert denied.headers["location"] == f"{ORIGIN}/?api=https%3A%2F%2Fapi.test&calendar_error=denied#/calendar"
    assert calendar_client.get("/api/calendar/status").json()["connected"] is False


def test_freebusy_requests_primary_calendar_and_dst_aware_day(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)
    calls = []

    async def busy_response(access_token, body):
        calls.append((access_token, body))
        return 200, {"calendars": {"primary": {"busy": [
            {"start": "2026-03-08T13:00:00Z", "end": "2026-03-08T14:00:00Z"},
        ]}}}

    monkeypatch.setattr(gc, "_calendar_post", busy_response)
    response = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-03-08", "timezone": "America/New_York"},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200
    assert response.json()["busy"] == [{
        "start": "2026-03-08T13:00:00Z", "end": "2026-03-08T14:00:00Z",
    }]
    assert calls[0][0] == "access-secret"
    assert calls[0][1]["items"] == [{"id": "primary"}]
    assert calls[0][1]["timeMin"] == "2026-03-08T00:00:00-05:00"
    assert calls[0][1]["timeMax"] == "2026-03-09T00:00:00-04:00"


def test_empty_calendar_returns_an_empty_busy_list(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)

    async def empty_response(access_token, body):
        return 200, {"calendars": {"primary": {"busy": []}}}

    monkeypatch.setattr(gc, "_calendar_post", empty_response)
    response = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "America/New_York"},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200
    assert response.json()["busy"] == []


def test_freebusy_provider_request_uses_bearer_token(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"calendars": {"primary": {"busy": []}}}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return FakeResponse()

    monkeypatch.setattr(gc.httpx, "AsyncClient", lambda **kwargs: FakeClient())
    status, result = asyncio.run(gc._calendar_post(
        "provider-access-token",
        {"items": [{"id": "primary"}]},
    ))
    assert status == 200
    assert result == {"calendars": {"primary": {"busy": []}}}
    assert calls[0][0] == gc.FREEBUSY_URL
    assert calls[0][1]["headers"]["Authorization"] == "Bearer provider-access-token"


def test_invalid_timezone_and_provider_quota_errors_are_explicit(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)
    invalid_zone = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "Not/A_Timezone"},
        headers={"Origin": ORIGIN},
    )
    assert invalid_zone.status_code == 422

    async def quota_response(access_token, body):
        return 429, {}

    monkeypatch.setattr(gc, "_calendar_post", quota_response)
    limited = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "America/New_York"},
        headers={"Origin": ORIGIN},
    )
    assert limited.status_code == 429


def test_revoked_authorization_removes_local_session(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)
    with gc._database(gc._config()) as db:
        db.execute("UPDATE calendar_sessions SET expires_at = 0")

    async def invalid_refresh(data):
        assert data["grant_type"] == "refresh_token"
        return 400, {"error": "invalid_grant"}

    monkeypatch.setattr(gc, "oauth_post", invalid_refresh)
    response = calendar_client.post(
        "/api/calendar/freebusy",
        json={"date": "2026-10-24", "timezone": "America/New_York"},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 401
    assert calendar_client.get("/api/calendar/status").json()["connected"] is False


def test_disconnect_deletes_session_and_revokes_google_token(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)
    revoked = []

    async def revoke(token):
        revoked.append(token)
        return type("GoogleResponse", (), {"status_code": 200})()

    monkeypatch.setattr(gc, "revoke_google_token", revoke)
    response = calendar_client.delete("/api/calendar/disconnect", headers={"Origin": ORIGIN})
    assert response.status_code == 204
    assert revoked == ["refresh-secret"]
    assert calendar_client.get("/api/calendar/status").json()["connected"] is False


def test_disconnect_reports_provider_throttling_after_local_session_is_removed(calendar_client, monkeypatch):
    authorize(calendar_client, monkeypatch)

    async def throttled_revoke(token):
        return type("GoogleResponse", (), {"status_code": 429})()

    monkeypatch.setattr(gc, "revoke_google_token", throttled_revoke)
    response = calendar_client.delete("/api/calendar/disconnect", headers={"Origin": ORIGIN})
    assert response.status_code == 503
    assert "could not confirm revocation" in response.json()["detail"]
    assert calendar_client.get("/api/calendar/status").json()["connected"] is False


def test_access_log_filter_redacts_oauth_callback_query_parameters():
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, "server", 1, "%s - %s", (
            "127.0.0.1", "GET /api/calendar/callback?code=private-code&state=private-state",
        ), None,
    )
    main.CalendarCallbackLogFilter().filter(record)
    assert "private-code" not in str(record.args)
    assert "private-state" not in str(record.args)
