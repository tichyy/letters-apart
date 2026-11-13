"""Development: uv run uvicorn server.app:app --reload. Production: build the client first."""

import asyncio
import contextlib
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from starlette.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .game import Game, Peer, SIDES
from .store import Store

ROOT = Path(__file__).resolve().parent.parent


def create_app(database: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = Store(database or Path(os.environ.get("POSTCARD_DB", ROOT / "data/postcards.sqlite3")))
        app.state.game = Game(store)
        task = asyncio.create_task(app.state.game.run())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)

    @app.websocket("/ws/{side}")
    async def connect(socket: WebSocket, side: str, token: str = ""):
        await socket.accept()
        # Browser clients must connect from the same origin (including Vite's proxy).
        origin = socket.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != socket.headers.get("host"):
            await socket.close(code=1008, reason="Connect from the game website.")
            return
        if side not in SIDES or not re.fullmatch(r"[a-zA-Z0-9-]{16,64}", token):
            await socket.close(code=1008, reason="Invalid player.")
            return

        game: Game = app.state.game
        old = game.peers.get(side)
        if old and old.token != token:
            await socket.send_json({"type": "occupied"})
            await socket.close(code=1008, reason="That home is already occupied.")
            return
        if old:
            await old.socket.close(code=1000)

        game.stop(side)
        peer = Peer(socket, token)
        game.peers[side] = peer
        peer.send({"type": "welcome", "side": side, "players": game.snapshot()["players"]})
        writer = asyncio.create_task(peer.write())

        async def receive() -> None:
            while True:
                raw = await socket.receive_text()
                if len(raw) > 8192:
                    await socket.close(code=1009, reason="Message too large.")
                    return
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError("Invalid message.")
                    response = game.handle(side, message)
                    if response:
                        peer.send(response)
                except ValueError as error:
                    peer.send({"type": "error", "message": str(error)})

        reader = asyncio.create_task(receive())
        try:
            await asyncio.wait((reader, writer), return_when=asyncio.FIRST_COMPLETED)
        finally:
            if game.peers.get(side) is peer:
                del game.peers[side]
                game.stop(side)
            for task in (reader, writer):
                task.cancel()
            for task in (reader, writer):
                with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                    await task
            with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
                await socket.close()

    # A single Python process serves the built game and its WebSocket endpoint.
    dist = ROOT / "dist"
    if dist.is_dir():
        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

        app.mount("/", StaticFiles(directory=dist, html=True), name="game")
    else:
        @app.get("/")
        def development():
            return {"message": "Run npm run dev for development, or npm run build first."}

    return app


app = create_app()
