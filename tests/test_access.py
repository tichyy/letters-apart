import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.access import COOKIE, SESSION_SECONDS, Access
from server.app import create_app

# Shorter than the old 24-byte requirement; spaces are valid within passphrases.
LEFT_CODE = "quiet amber reeds"
RIGHT_CODE = "moss silver tide"
ORIGIN = "https://letters.example"
WS_ORIGIN = "wss://letters.example"


@pytest.fixture
def private_app(tmp_path, monkeypatch):
    monkeypatch.setenv("POSTCARD_REQUIRE_AUTH", "1")
    monkeypatch.setenv("POSTCARD_ACCESS_LEFT", LEFT_CODE)
    monkeypatch.setenv("POSTCARD_ACCESS_RIGHT", RIGHT_CODE)
    return create_app(tmp_path / "cards.sqlite3")


def sign_in(client, code=LEFT_CODE):
    return client.post(
        "/login",
        data={"code": code},
        headers={"Origin": ORIGIN},
        follow_redirects=False,
    )


def test_all_game_routes_require_access_but_healthcheck_stays_public(private_app):
    with TestClient(private_app, base_url=ORIGIN) as client:
        for path in (
            "/",
            "/?player=left",
            "/assets/game.js",
            "/world.json",
            "/openapi.json",
        ):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == "/login"
            assert "no-store" in response.headers["cache-control"]
        for method, path in (
            ("GET", "/api/images/abc"),
            ("POST", "/api/images"),
            ("DELETE", "/api/images/abc"),
        ):
            response = client.request(
                method,
                path,
                headers={
                    "Authorization": "Bearer left-player-token",
                    "X-Player-Side": "left",
                },
            )
            assert response.status_code == 401
        with client.websocket_connect(
            f"{WS_ORIGIN}/ws/left?token=left-player-token"
        ) as socket:
            with pytest.raises(WebSocketDisconnect) as error:
                socket.receive_json()
            assert error.value.code == 1008
        assert client.get("/healthz").json() == {"status": "ok"}
        page = client.get("/login")
        assert page.status_code == 200
        assert LEFT_CODE not in page.text and RIGHT_CODE not in page.text


@pytest.mark.parametrize(
    ("code", "side", "other"),
    [(LEFT_CODE, "left", "right"), (RIGHT_CODE, "right", "left")],
)
def test_invitation_assigns_one_home_and_protects_other_home(
    private_app, code, side, other
):
    with TestClient(private_app, base_url=ORIGIN) as client:
        response = sign_in(client, code)
        assert response.status_code == 303
        assert response.headers["location"] == f"/?player={side}"
        cookie = response.headers["set-cookie"]
        assert (
            "Secure" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
        )
        assert f"Max-Age={SESSION_SECONDS}" in cookie
        assert code not in cookie
        assert (
            client.get(f"/?player={other}", follow_redirects=False).headers["location"]
            == f"/?player={side}"
        )
        assert client.get(f"/?player={side}").status_code == 200
        assert (
            client.get("/api/images/abc", headers={"X-Player-Side": other}).status_code
            == 403
        )
        # The invitation cookie does not replace the photo API's live-session check.
        assert (
            client.get("/api/images/abc", headers={"X-Player-Side": side}).status_code
            == 401
        )
        with client.websocket_connect(
            f"{WS_ORIGIN}/ws/{other}?token=left-player-token"
        ) as socket:
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
        with client.websocket_connect(
            f"{WS_ORIGIN}/ws/{side}?token=left-player-token", headers={"Origin": ORIGIN}
        ) as socket:
            welcome = socket.receive_json()
            assert welcome["type"] == "welcome" and welcome["side"] == side
            response = client.get(
                "/api/images/abc",
                headers={
                    "X-Player-Side": side,
                    "Authorization": "Bearer left-player-token",
                },
            )
            assert (
                response.status_code == 404
            )  # Authenticated, but the photo does not exist.


def test_login_rejects_invalid_codes_cross_origin_and_large_forms(private_app):
    with TestClient(private_app, base_url=ORIGIN) as client:
        response = sign_in(client, "wrong-private-code")
        assert response.status_code == 401
        assert "wrong-private-code" not in response.text
        assert COOKIE not in client.cookies
        response = client.post(
            "/login",
            data={"code": LEFT_CODE},
            headers={"Origin": "https://elsewhere.example"},
        )
        assert response.status_code == 403
        assert client.post("/login", data={"code": LEFT_CODE}).status_code == 403
        response = client.post(
            "/login", data={"code": "x" * 5000}, headers={"Origin": ORIGIN}
        )
        assert response.status_code == 400
        assert (
            client.post(
                "/login", json={"code": LEFT_CODE}, headers={"Origin": ORIGIN}
            ).status_code
            == 415
        )


def test_login_attempts_are_bounded(private_app):
    with TestClient(private_app, base_url=ORIGIN) as client:
        for _ in range(20):
            assert sign_in(client, "wrong").status_code == 401
        response = sign_in(client)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"


def test_tampered_and_expired_cookies_cannot_access_game(private_app, monkeypatch):
    with TestClient(private_app, base_url=ORIGIN) as client:
        sign_in(client)
        original = client.cookies.get(COOKIE)
        for token in (
            original.replace("left", "right"),
            original[:-1] + ("0" if original[-1] != "0" else "1"),
            "left.invalid.signature",
            "x" * 300,
        ):
            client.cookies.clear()
            client.cookies.set(COOKIE, token)
            assert (
                client.get("/", follow_redirects=False).headers["location"] == "/login"
            )
        client.cookies.clear()
        client.cookies.set(COOKIE, original)
        now = time.time()
        monkeypatch.setattr(
            "server.access.time.time", lambda: now + SESSION_SECONDS + 1
        )
        assert client.get("/", follow_redirects=False).headers["location"] == "/login"
        with client.websocket_connect(
            f"{WS_ORIGIN}/ws/left?token=left-player-token"
        ) as socket:
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()


def test_browser_session_remains_valid_for_90_days(private_app, monkeypatch):
    now = int(time.time())
    monkeypatch.setattr("server.access.time.time", lambda: now)
    with TestClient(private_app, base_url=ORIGIN) as client:
        response = sign_in(client)
        token = client.cookies.get(COOKIE)
        lifetime = 90 * 24 * 60 * 60
        assert f"Max-Age={lifetime}" in response.headers["set-cookie"]
        assert int(token.split(".")[1]) == now + lifetime
        for age in (8 * 24 * 60 * 60, lifetime - 1):
            monkeypatch.setattr("server.access.time.time", lambda: now + age)
            assert (
                client.get("/?player=left", follow_redirects=False).status_code == 200
            )
        monkeypatch.setattr("server.access.time.time", lambda: now + lifetime)
        assert client.get("/", follow_redirects=False).headers["location"] == "/login"


def test_rotating_codes_invalidates_previous_sessions(
    private_app, monkeypatch, tmp_path
):
    with TestClient(private_app, base_url=ORIGIN) as client:
        sign_in(client)
        previous = client.cookies.get(COOKIE)
    monkeypatch.setenv("POSTCARD_ACCESS_LEFT", "c" * 32)
    with TestClient(create_app(tmp_path / "cards.sqlite3"), base_url=ORIGIN) as client:
        client.cookies.set(COOKIE, previous)
        assert client.get("/", follow_redirects=False).headers["location"] == "/login"
        assert sign_in(client, LEFT_CODE).status_code == 401
        assert sign_in(client, "c" * 32).status_code == 303


def test_expired_session_closes_an_existing_websocket(private_app, monkeypatch):
    monkeypatch.setattr("server.access.SESSION_SECONDS", 2)
    with TestClient(private_app, base_url=ORIGIN) as client:
        sign_in(client)
        with client.websocket_connect(
            f"{WS_ORIGIN}/ws/left?token=left-player-token", headers={"Origin": ORIGIN}
        ) as socket:
            assert socket.receive_json()["type"] == "welcome"
            with pytest.raises(WebSocketDisconnect) as error:
                while True:
                    socket.receive_json()
            assert error.value.code == 1008
            assert error.value.reason == "Sign in to play."


@pytest.mark.parametrize("railway", [False, True])
def test_production_cannot_start_without_codes(monkeypatch, railway):
    monkeypatch.delenv("POSTCARD_ACCESS_LEFT", raising=False)
    monkeypatch.delenv("POSTCARD_ACCESS_RIGHT", raising=False)
    monkeypatch.setenv("POSTCARD_REQUIRE_AUTH", "0" if railway else "1")
    if railway:
        monkeypatch.setenv("RAILWAY_ENVIRONMENT_ID", "production-environment")
    with pytest.raises(ValueError, match="POSTCARD_ACCESS_LEFT"):
        Access()


def test_partial_or_identical_codes_are_rejected(private_app, monkeypatch):
    monkeypatch.delenv("POSTCARD_ACCESS_RIGHT")
    with pytest.raises(ValueError):
        Access()
    monkeypatch.setenv("POSTCARD_ACCESS_RIGHT", LEFT_CODE)
    with pytest.raises(ValueError, match="different"):
        Access()


@pytest.mark.parametrize(
    "passphrase", ["too short", "x" * 14, " " + LEFT_CODE, LEFT_CODE + " ", "é" * 129]
)
def test_passphrase_limits_are_enforced(private_app, monkeypatch, passphrase):
    monkeypatch.setenv("POSTCARD_ACCESS_LEFT", passphrase)
    with pytest.raises(ValueError, match="at least 15 characters"):
        Access()
