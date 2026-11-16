"""Small session-authorized photo API; image bytes never use game WebSockets."""

import asyncio
import logging
import secrets
import sqlite3
import time
from collections import deque
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from .game import WORLD, Game
from .images import IMAGE_ID, MAX_OUTPUT, MAX_UPLOAD, ImageStorage, normalize
from .store import session_owner

logger = logging.getLogger(__name__)


class ImageService:
    def __init__(self, game: Game, storage: ImageStorage, byte_limit: int):
        self.game = game
        self.storage = storage
        self.byte_limit = byte_limit
        self.busy = False
        self.attempts = {side: deque() for side in ("left", "right")}
        self.cleanup_lock = asyncio.Lock()

    def session(self, request: Request) -> tuple[str, str]:
        origin = request.headers.get("origin")
        if origin:
            try:
                allowed = urlsplit(origin).netloc == request.headers.get("host")
            except ValueError:
                allowed = False
            if not allowed:
                raise HTTPException(403, "Open photos from the game website.")
        side = request.headers.get("x-player-side", "")
        authorization = request.headers.get("authorization", "")
        token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
        peer = self.game.peers.get(side)
        if not peer or not token.isascii() or not secrets.compare_digest(peer.token, token):
            raise HTTPException(401, "Reconnect to the game to use photos.")
        return side, session_owner(side, token)

    def writable(self, side: str) -> None:
        if not self.game.nearby(side, WORLD["desks"][side]):
            raise HTTPException(409, "Return to your desk to add a photo.")
        if self.game.mail[side]["carrying"]:
            raise HTTPException(409, "Deliver the postcard in your backpack first.")

    async def cleanup(self) -> None:
        async with self.cleanup_lock:
            for image_id in self.game.store.expired_images():
                try:
                    await run_in_threadpool(self.storage.delete, image_id)
                except OSError:
                    logger.warning("Could not delete expired photo %s; will retry", image_id, exc_info=True)
                    continue
                self.game.store.forget_image(image_id)
            await run_in_threadpool(self.storage.cleanup_orphans, self.game.store.image_ids(), time.time() - 86400)

    async def maintain(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.cleanup()
            except (OSError, sqlite3.Error):
                logger.exception("Photo cleanup failed; will retry")


router = APIRouter(prefix="/api/images")


@router.post("")
async def upload(request: Request):
    service: ImageService = request.app.state.images
    side, owner = service.session(request)
    service.writable(side)
    image_id = request.headers.get("x-upload-id", "")
    if not IMAGE_ID.fullmatch(image_id):
        raise HTTPException(400, "Invalid photo upload.")
    existing = service.game.store.image_for(image_id, side, owner)
    if existing:
        return {"id": image_id, "width": existing["width"], "height": existing["height"],
                "expiresAt": existing["expires_at"]}
    if service.game.store.image_exists(image_id):
        # A client-supplied retry ID must never overwrite another session's stored bytes.
        raise HTTPException(409, "This upload ID is unavailable. Please choose the photo again.")
    if service.busy:
        raise HTTPException(429, "Another photo is being prepared. Please try again shortly.")
    attempts = service.attempts[side]
    now = time.monotonic()
    while attempts and attempts[0] < now - 60:
        attempts.popleft()
    if len(attempts) >= 10:
        raise HTTPException(429, "Please wait a minute before adding another photo.")
    attempts.append(now)
    service.busy = True
    saved = False
    try:
        await service.cleanup()
        if not service.game.store.image_capacity(side, service.byte_limit):
            raise HTTPException(409, "Photo storage is full. Reset an unused photo or try again later.")
        length = request.headers.get("content-length")
        if length and (not length.isdecimal() or int(length) > MAX_UPLOAD):
            raise HTTPException(413, "Choose a photo smaller than 20 MB.")

        async def receive():
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_UPLOAD:
                    raise HTTPException(413, "Choose a photo smaller than 20 MB.")
                data.extend(chunk)
            return bytes(data)

        data = await asyncio.wait_for(receive(), timeout=60)
        jpeg, width, height = await run_in_threadpool(normalize, data)
        # Normalization yields to the game loop. Check ownership and game state again.
        if service.session(request) != (side, owner):
            raise HTTPException(401, "Your home changed. Reopen the postcard.")
        service.writable(side)
        if not service.game.store.image_capacity(side, service.byte_limit):
            raise HTTPException(409, "Photo storage is full. Please try again later.")
        await run_in_threadpool(service.storage.save, image_id, jpeg)
        saved = True
        if service.session(request) != (side, owner):
            raise HTTPException(401, "Your home changed. Reopen the postcard.")
        service.writable(side)
        result = service.game.store.add_image(image_id, side, owner, width, height, len(jpeg))
        saved = False  # The metadata now owns this file.
        return result
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except asyncio.TimeoutError:
        raise HTTPException(408, "The upload took too long. Please try again.") from None
    except ClientDisconnect:
        raise HTTPException(400, "Photo upload interrupted.") from None
    except (OSError, sqlite3.Error):
        raise HTTPException(503, "Photo storage is unavailable. Please try again.") from None
    finally:
        try:
            if saved:
                await run_in_threadpool(service.storage.delete, image_id)
        finally:
            service.busy = False


@router.get("/{image_id}")
async def retrieve(request: Request, image_id: str):
    service: ImageService = request.app.state.images
    side, owner = service.session(request)
    if not IMAGE_ID.fullmatch(image_id) or not service.game.store.image_for(image_id, side, owner):
        raise HTTPException(404, "This photo is no longer available.")
    try:
        data = await run_in_threadpool(service.storage.read, image_id)
    except FileNotFoundError:
        raise HTTPException(404, "This photo is no longer available.") from None
    except OSError:
        raise HTTPException(503, "Photo storage is unavailable. Please try again.") from None
    if len(data) > MAX_OUTPUT:
        raise HTTPException(503, "This photo could not be loaded.")
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })


@router.delete("/{image_id}", status_code=204)
async def discard(request: Request, image_id: str):
    service: ImageService = request.app.state.images
    side, owner = service.session(request)
    async with service.cleanup_lock:
        if IMAGE_ID.fullmatch(image_id) and service.game.store.retire_image(image_id, side, owner):
            try:
                await run_in_threadpool(service.storage.delete, image_id)
            except OSError:
                logger.warning("Could not discard photo %s; cleanup will retry", image_id, exc_info=True)
                raise HTTPException(503, "The photo will be removed when storage is available.") from None
            service.game.store.forget_image(image_id)
    return Response(status_code=204)
