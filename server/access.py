"""Two private player passphrases, exchanged for signed HTTPS session cookies."""

import asyncio
import hashlib
import hmac
import json
import os
import time
from collections import deque
from urllib.parse import parse_qs, urlsplit

from starlette.requests import HTTPConnection, Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.websockets import WebSocket

COOKIE = "__Host-letters-access"
SESSION_SECONDS = 90 * 24 * 60 * 60
# ASGI scope key holding the signed-in side, for handlers behind the middleware.
SESSION_SIDE = "letters.side"
# Sign-in attempts per minute. The per-client limit stops guessing; the much higher
# total only bounds work, so one client can't lock both players out.
ATTEMPTS_PER_CLIENT = 20
ATTEMPTS_TOTAL = 300


class Access:
    def __init__(self):
        codes = {
            side: os.environ.get(f"POSTCARD_ACCESS_{side.upper()}", "")
            for side in ("left", "right")
        }
        required = os.environ.get("POSTCARD_REQUIRE_AUTH", "0") == "1" or bool(
            os.environ.get("RAILWAY_ENVIRONMENT_ID")
        )
        self.enabled = required or any(codes.values())
        self.attempts: dict[str, deque[float]] = {}
        self.total: deque[float] = deque()
        if not self.enabled:
            return
        if any(
            len(code) < 15 or len(code.encode()) > 256 or code != code.strip()
            for code in codes.values()
        ):
            raise ValueError(
                "Set POSTCARD_ACCESS_LEFT and POSTCARD_ACCESS_RIGHT to distinct passphrases of at least 15 characters, up to 256 UTF-8 bytes, without leading or trailing spaces."
            )
        if codes["left"] == codes["right"]:
            raise ValueError("Each player needs a different passphrase.")
        # Slow key derivation protects memorable credentials against offline guesses
        # from a captured signed cookie. It runs once, before the game starts.
        self.key = hashlib.pbkdf2_hmac(
            "sha256",
            json.dumps(codes, sort_keys=True).encode(),
            b"letters-apart-session-v2",
            600_000,
        )
        self.hashes = {
            side: hmac.digest(self.key, code.encode(), "sha256")
            for side, code in codes.items()
        }

    def issue(self, side: str) -> str:
        payload = f"{side}.{int(time.time()) + SESSION_SECONDS}"
        return f"{payload}.{hmac.digest(self.key, payload.encode(), 'sha256').hex()}"

    def session(self, connection: HTTPConnection) -> tuple[str, int] | None:
        token = connection.cookies.get(COOKIE, "")
        if len(token) > 128:
            return None
        try:
            side, expiry, signature = token.split(".")
            if (
                side not in self.hashes
                or not expiry.isascii()
                or not expiry.isdecimal()
            ):
                return None
            expected = hmac.digest(
                self.key, f"{side}.{expiry}".encode(), "sha256"
            ).hex()
            if not signature.isascii() or not hmac.compare_digest(signature, expected):
                return None
            expires = int(expiry)
            return (side, expires) if time.time() < expires else None
        except ValueError:
            return None

    def admit(self, client: str) -> bool:
        """Record a sign-in attempt unless this client or everyone is over the limit."""
        now = time.monotonic()
        for attempts in (self.total, self.attempts.get(client, ())):
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
        if len(self.attempts) > 1024:
            # Forget idle clients so spoofed or rotating addresses can't grow memory.
            self.attempts = {
                key: value
                for key, value in self.attempts.items()
                if value and value[-1] > now - 60
            }
        attempts = self.attempts.setdefault(client, deque())
        if len(attempts) >= ATTEMPTS_PER_CLIENT or len(self.total) >= ATTEMPTS_TOTAL:
            return False
        attempts.append(now)
        self.total.append(now)
        return True

    async def login(self, request: Request):
        if request.method == "GET":
            return login_page()
        if request.method != "POST":
            return HTMLResponse(
                "Method not allowed.", status_code=405, headers={"Allow": "GET, POST"}
            )
        try:
            same_origin = urlsplit(
                request.headers.get("origin", "")
            ).netloc == request.headers.get("host")
        except ValueError:
            same_origin = False
        if not same_origin:
            return login_page("Refresh this sign-in page and try again.", 403)
        if (
            request.headers.get("content-type", "").split(";", 1)[0]
            != "application/x-www-form-urlencoded"
        ):
            return login_page("Please use the sign-in form.", 415)
        if not self.admit(request.client.host if request.client else ""):
            response = login_page("Too many attempts. Please wait a minute.", 429)
            response.headers["Retry-After"] = "60"
            return response

        async def read_form():
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > 4096:
                    raise ValueError("Form too large.")
                body.extend(chunk)
            return parse_qs(body.decode("utf-8"), max_num_fields=2)

        try:
            form = await asyncio.wait_for(read_form(), timeout=5)
            code = form.get("code", [""])[0]
        except (ValueError, UnicodeError, asyncio.TimeoutError):
            return login_page("Please try signing in again.", 400)
        candidate = hmac.digest(self.key, code.encode(), "sha256")
        matches = [
            side
            for side, expected in self.hashes.items()
            if hmac.compare_digest(candidate, expected)
        ]
        if not matches:
            return login_page("That passphrase is not recognised.", 401)
        side = matches[0]
        response = RedirectResponse(f"/?player={side}", status_code=303)
        response.set_cookie(
            COOKIE,
            self.issue(side),
            max_age=SESSION_SECONDS,
            secure=True,
            httponly=True,
            samesite="strict",
            path="/",
        )
        return response


class AccessMiddleware:
    def __init__(self, app, access: Access):
        self.app = app
        self.access = access

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not self.access.enabled:
            await self.app(scope, receive, send)
            return
        connection = HTTPConnection(scope)
        path = scope["path"]
        if scope["type"] == "http" and path == "/healthz":
            await self.app(scope, receive, send)
            return

        async def private_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = [
                    (key, value)
                    for key, value in message["headers"]
                    if key.lower() != b"cache-control"
                ]
                message["headers"].append((b"cache-control", b"private, no-store"))
            await send(message)

        if scope["type"] == "http" and path == "/login":
            response = await self.access.login(Request(scope, receive))
            await response(scope, receive, private_send)
            return
        session = self.access.session(connection)
        if scope["type"] == "websocket":
            if session is None or path != f"/ws/{session[0]}":
                socket = WebSocket(scope, receive, send)
                await socket.accept()
                await socket.close(code=1008, reason="Sign in to play.")
                return
            side, expires = session
            scope[SESSION_SIDE] = side

            async def authenticated_receive():
                try:
                    return await asyncio.wait_for(
                        receive(), timeout=max(0, expires - time.time())
                    )
                except asyncio.TimeoutError:
                    await send(
                        {
                            "type": "websocket.close",
                            "code": 1008,
                            "reason": "Sign in to play.",
                        }
                    )
                    return {"type": "websocket.disconnect", "code": 1008}

            await self.app(scope, authenticated_receive, send)
            return
        if session is None:
            response = (
                JSONResponse({"detail": "Sign in to play."}, status_code=401)
                if path.startswith("/api/")
                else RedirectResponse("/login", status_code=303)
            )
        elif (
            path.startswith("/api/")
            and connection.headers.get("x-player-side") != session[0]
        ):
            response = JSONResponse({"detail": "Use your own home."}, status_code=403)
        elif path == "/" and connection.query_params.get("player") != session[0]:
            response = RedirectResponse(f"/?player={session[0]}", status_code=303)
        else:
            await self.app(scope, receive, private_send)
            return
        await response(scope, receive, private_send)


def login_page(error: str = "", status: int = 200):
    # Error messages are fixed server strings; submitted codes are never echoed.
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Letters Apart · Sign in</title>
<style>
* {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px; background: #143f5b; color: #513e35; font: 18px/1.5 Georgia, serif; }}
main {{ width: min(100%, 400px); padding: 32px; border-radius: 12px; background: #f8ecd4; }}
h1 {{ margin: 0 0 12px; font-size: 32px; }}
label, input, button {{ display: block; width: 100%; }}
input, button {{ margin-top: 10px; padding: 12px; font: inherit; border-radius: 6px; border: 1px solid #8e6247; }}
button {{ background: #77503c; color: #fff3dc; cursor: pointer; }}
.error {{ color: #942b23; }}
</style><main><h1>Letters Apart</h1><p>A little place for the two of you.</p>
<form method="post" action="/login"><label for="code">Your private passphrase</label>
<input id="code" name="code" type="password" autocomplete="current-password" required minlength="15" maxlength="256" autofocus>
<p>Stay signed in on this browser for 90 days.</p>
<button type="submit">Come inside</button></form>
<p class="error" role="alert">{error}</p></main></html>""",
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            # no-referrer makes browsers send Origin: null for form POSTs,
            # which would fail the login's same-origin check.
            "Referrer-Policy": "same-origin",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
    )
