"""Development: uv run uvicorn server.app:app --reload. Production: build the client first."""

import asyncio
import contextlib
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .access import SESSION_SIDE, Access, AccessMiddleware
from .game import SIDES, Game, Peer
from .image_routes import ImageService
from .image_routes import router as image_router
from .images import ImageStorage, LocalImageStorage
from .store import Store

ROOT = Path(__file__).resolve().parent.parent


def create_app(
    database: Path | None = None, *, image_storage: ImageStorage | None = None
) -> FastAPI:
    access = Access()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database_path = database or Path(
            os.environ.get("POSTCARD_DB", ROOT / "data/postcards.sqlite3")
        )
        store = Store(database_path)
        app.state.game = Game(store)
        app.state.images = ImageService(
            app.state.game,
            image_storage
            if image_storage is not None
            else LocalImageStorage(
                Path(
                    os.environ.get(
                        "POSTCARD_IMAGES", database_path.parent / "postcard-images"
                    )
                ),
            ),
            int(os.environ.get("POSTCARD_IMAGE_BUDGET", 256 * 1024 * 1024)),
        )
        await app.state.images.cleanup()
        maintenance = asyncio.create_task(app.state.images.maintain())
        task = asyncio.create_task(app.state.game.run())
        try:
            yield
        finally:
            task.cancel()
            maintenance.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            with contextlib.suppress(asyncio.CancelledError):
                await maintenance
            store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)
    app.add_middleware(AccessMiddleware, access=access)
    app.include_router(image_router)

    @app.get("/healthz", include_in_schema=False)
    async def health():
        # Lifespan initializes persistent storage before accepting requests.
        app.state.game.store.db.execute("SELECT 1").fetchone()
        if not app.state.game.healthy():
            return JSONResponse({"status": "game loop stalled"}, status_code=503)
        return {"status": "ok"}

    @app.websocket("/ws/{side}")
    async def connect(socket: WebSocket, side: str):
        await socket.accept()
        # Browser clients must connect from the same origin (including Vite's proxy).
        origin = socket.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != socket.headers.get("host"):
            await socket.close(code=1008, reason="Connect from the game website.")
            return
        # The tab token arrives in a first message rather than the URL, which
        # access logs record. It also authorizes this tab's photo requests.
        token = None
        if side in SIDES:
            try:
                hello = json.loads(
                    await asyncio.wait_for(socket.receive_text(), timeout=10)
                )
                if isinstance(hello, dict) and hello.get("type") == "hello":
                    token = hello.get("token")
            except (ValueError, KeyError, asyncio.TimeoutError):
                pass
            except WebSocketDisconnect:
                return
        if not isinstance(token, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,64}", token):
            await socket.close(code=1008, reason="Invalid player.")
            return

        game: Game = app.state.game
        old = game.peers.get(side)
        if old and old.token != token:
            # A signed-in owner may move their home to this window; anyone else
            # (or anyone at all when sign-in is off) must pick the free home.
            if socket.scope.get(SESSION_SIDE) != side:
                await socket.send_json({"type": "occupied"})
                await socket.close(code=1008, reason="That home is already occupied.")
                return
            old.drop(4001, "Opened in another window.")
        elif old:
            old.drop(1000, "Reconnected.")

        game.stop(side)
        peer = Peer(socket, token)
        game.peers[side] = peer
        game.players[side].paused = False
        peer.send(
            {
                "type": "welcome", "side": side,
                "players": game.snapshot()["players"],
            }
        )
        writer = asyncio.create_task(peer.write())

        async def receive() -> None:
            while True:
                raw = await socket.receive_text()
                if game.peers.get(side) is not peer:
                    return
                if len(raw) > 8192:
                    peer.drop(1009, "Message too large.")
                    return
                try:
                    message = json.loads(raw)
                except ValueError:
                    message = None
                if not isinstance(message, dict):
                    peer.send({"type": "error", "message": "Invalid message."})
                    continue
                # Movement is bounded by its own sequence and queue checks; everything
                # else may touch the database on the game's thread, so it is budgeted.
                if message.get("type") != "input" and not peer.allow():
                    response = {"type": "error", "message": "Slow down a little."}
                    if isinstance(message.get("requestId"), str):
                        response["requestId"] = message["requestId"]
                    peer.send(response)
                    continue
                response = game.respond(side, message, peer.token)
                if response:
                    peer.send(response)

        reader = asyncio.create_task(receive())
        dropped = asyncio.create_task(peer.dropped.wait())
        tasks = (reader, writer, dropped)
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if game.peers.get(side) is peer:
                del game.peers[side]
                game.stop(side)
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(
                    asyncio.CancelledError,
                    WebSocketDisconnect,
                    RuntimeError,
                    OSError,
                    asyncio.TimeoutError,
                ):
                    await task
            code, reason = peer.closing or (1000, "")
            with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
                await socket.close(code=code, reason=reason)

    # A single Python process serves the built game and its WebSocket endpoint.
    dist = ROOT / "dist"
    if dist.is_dir():

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(
                dist / "index.html", headers={"Cache-Control": "no-cache"}
            )

        app.mount("/", StaticFiles(directory=dist, html=True), name="game")
    else:

        @app.get("/")
        def development():
            return {
                "message": "Run npm --prefix client run dev for development, or npm --prefix client run build first."
            }

    return app


app = create_app()
