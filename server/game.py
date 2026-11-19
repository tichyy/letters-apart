"""One shared world with sequenced inputs and bounded, elapsed-time catch-up."""

import asyncio
import hashlib
import json
import logging
import math
import re
import sqlite3
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import WebSocket

from .store import Store, session_owner

SIDES = ("left", "right")
GALLERY_PAGE_SIZE = 12
WORLD = json.loads((Path(__file__).resolve().parent.parent / "world.json").read_text())
# Non-movement messages (interactions, reads, writes) per peer: sustained rate and burst.
MESSAGE_RATE = 10
MESSAGE_BURST = 20
# /healthz fails when no tick has completed successfully within this many seconds.
HEALTHY_WITHIN = 1.0
logger = logging.getLogger(__name__)


class Desync(ValueError):
    """The client's input sequence no longer matches ours; it must reconnect to resync."""


@dataclass
class Player:
    side: str
    x: float
    facing: int
    y: float = 0
    vy: float = 0
    jump_chain: int = 0
    landing_ticks: int = 0
    jump_held: bool = False
    moving: bool = False
    ack: int = 0
    received: int = 0
    inputs: deque = field(default_factory=deque)
    credit: float = 0
    paused: bool = False
    actions: deque = field(default_factory=deque)


@dataclass
class Peer:
    socket: WebSocket
    token: str
    outbox: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))
    # Set once this connection must end; its handler closes the socket with `closing`.
    dropped: asyncio.Event = field(default_factory=asyncio.Event)
    closing: tuple[int, str] | None = None
    budget: float = MESSAGE_BURST
    refilled: float = field(default_factory=lambda: time.monotonic())

    def drop(self, code: int, reason: str) -> None:
        if self.closing is None:
            self.closing = (code, reason)
            self.dropped.set()

    def send(self, message: dict) -> None:
        """Never raises: callers include the shared game loop."""
        if self.closing:
            return
        # Keep the newest state under backpressure, preserving reliable events.
        if message["type"] == "state":
            reliable = []
            while not self.outbox.empty():
                queued = self.outbox.get_nowait()
                if queued["type"] != "state":
                    reliable.append(queued)
            for queued in reliable:
                self.outbox.put_nowait(queued)
            if self.outbox.full():
                return
        elif self.outbox.full():
            # A reliable event can't be dropped silently. This peer is too far behind
            # to catch up, so disconnect it; its client reconnects with fresh state.
            self.drop(1013, "Connection too slow.")
            return
        self.outbox.put_nowait(message)

    def allow(self) -> bool:
        """Spend one token from this peer's message budget."""
        now = time.monotonic()
        self.budget = min(
            MESSAGE_BURST, self.budget + max(0, now - self.refilled) * MESSAGE_RATE
        )
        self.refilled = now
        if self.budget < 1:
            return False
        self.budget -= 1
        return True

    async def write(self) -> None:
        while True:
            message = await self.outbox.get()
            await asyncio.wait_for(self.socket.send_json(message), timeout=5)


def move(player: Player, direction: int, jump: bool) -> None:
    """Advance one input. Must match client/src/movement.ts; see test_movement_parity."""
    player.jump_held = jump
    player.moving = direction != 0
    if direction:
        player.facing = direction
    if player.y == 0:
        if not jump:
            player.jump_chain = 0
        player.landing_ticks = max(0, player.landing_ticks - 1)
        if jump and player.landing_ticks == 0:
            player.vy = -WORLD["jumpSpeed"]
            player.jump_chain = min(player.jump_chain + 1, WORLD["maxJumpChain"])
    speed = WORLD["speed"] * (
        1 + max(0, player.jump_chain - 1) * WORLD["jumpBoost"]
    )
    player.x = max(
        WORLD["minX"],
        min(WORLD["maxX"], player.x + direction * speed / WORLD["tickRate"]),
    )
    previous_y = player.y
    player.vy += WORLD["gravity"] / WORLD["tickRate"]
    player.y = min(0, player.y + player.vy / WORLD["tickRate"])
    if player.y == 0:
        player.vy = 0
        if previous_y < 0:
            player.landing_ticks = WORLD["landingTicks"]


class Game:
    def __init__(self, store: Store):
        self.store = store
        self.players = {
            side: Player(side, WORLD["desks"][side], 1 if side == "left" else -1)
            for side in SIDES
        }
        self.peers: dict[str, Peer] = {}
        self.mail = {side: store.summary(side) for side in SIDES}
        self.time = 0.0
        self.last_tick: float | None = None
        self.last_error = -math.inf

    def snapshot(self) -> dict:
        return {
            "type": "state",
            "time": self.time,
            "players": [
                {
                    "side": p.side,
                    "x": p.x,
                    "y": p.y,
                    "vy": p.vy,
                    "facing": p.facing,
                    "jumpChain": p.jump_chain,
                    "landingTicks": p.landing_ticks,
                    "moving": p.moving,
                    "ack": p.ack,
                    "connected": p.side in self.peers,
                    **self.mail[p.side],
                }
                for p in self.players.values()
            ],
        }

    def step(self, seconds: float = 1 / WORLD["tickRate"]) -> None:
        self.time += seconds * 1000
        for player in self.players.values():
            # Credit is earned by wall time, not loop iterations. Delayed packets
            # can catch up without granting faster-than-real-time movement.
            player.credit = min(
                WORLD["tickRate"], player.credit + seconds * WORLD["tickRate"]
            )
            while player.inputs and player.credit >= 1 - 1e-9:
                seq, direction, jump = player.inputs.popleft()
                player.credit -= 1
                player.paused = False
                player.ack = seq
                move(player, direction, jump)
                while player.actions and player.actions[0][0] <= player.ack:
                    _, message, token = player.actions.popleft()
                    response = self.respond(player.side, message, token)
                    peer = self.peers.get(player.side)
                    if response and peer:
                        peer.send(response)
            # Active prediction advances physics once per input on both ends.
            # Explicitly paused/disconnected players still finish falling.
            if player.paused or player.side not in self.peers:
                while (
                    not player.inputs
                    and player.credit >= 1 - 1e-9
                    and (player.y < 0 or player.vy < 0 or player.landing_ticks > 0)
                ):
                    player.credit -= 1
                    move(player, 0, False)

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        previous = deadline - 1 / WORLD["tickRate"]
        tick = 0
        while True:
            now = loop.time()
            elapsed, previous = max(0, now - previous), now
            tick += 1
            try:
                self.step(elapsed)
                if tick % 2 == 0:
                    state = self.snapshot()
                    for peer in list(self.peers.values()):
                        peer.send(state)
                # Only a completed tick counts as alive: a loop that keeps failing
                # is running but frozen, and /healthz must report it.
                self.last_tick = loop.time()
            except Exception:
                # The shared world must outlive any single failure. Log a repeating
                # error at most every 10 seconds rather than 60 times a second.
                if now - self.last_error >= 10:
                    self.last_error = now
                    logger.exception("Game tick failed; continuing")
            deadline += 1 / WORLD["tickRate"]
            # Bound catch-up after a suspended process; don't spiral through old ticks.
            deadline = max(deadline, loop.time() - 0.1)
            await asyncio.sleep(max(0, deadline - loop.time()))

    def stop(self, side: str) -> None:
        player = self.players[side]
        player.inputs.clear()
        # A reconnect restarts sequencing from the last input actually applied.
        player.received = player.ack
        player.actions.clear()
        player.credit = 0
        player.paused = True
        player.moving = False
        player.jump_held = False
        player.jump_chain = 0

    def healthy(self) -> bool:
        """True while the game loop is ticking."""
        loop = asyncio.get_running_loop()
        return (
            self.last_tick is not None
            and loop.time() - self.last_tick < HEALTHY_WITHIN
        )

    def nearby(self, side: str, x: float) -> bool:
        player = self.players[side]
        return math.hypot(player.x - x, player.y) <= WORLD["radius"]

    def refresh_mail(self) -> None:
        self.mail = {side: self.store.summary(side) for side in SIDES}

    def use_mailbox(self, side: str) -> None:
        for peer in self.peers.values():
            peer.send({"type": "mailbox_used", "side": side})

    def respond(
        self, side: str, message: dict, session_token: str | None = None
    ) -> dict | None:
        """Run one client message, turning validation and database failures into a reply."""
        try:
            return self.handle(side, message, session_token)
        except Desync:
            # The client already discarded inputs we rejected, so every later batch
            # would fail too. Reconnecting resynchronizes from the last applied input.
            if peer := self.peers.get(side):
                peer.drop(4000, "Resynchronizing.")
            return None
        except ValueError as error:
            response = {"type": "error", "message": str(error)}
        except sqlite3.Error:
            logger.exception("Could not handle %r from %s", message.get("type"), side)
            response = {
                "type": "error",
                "message": "Something went wrong. Please try again.",
            }
        if isinstance(message.get("requestId"), str):
            response["requestId"] = message["requestId"]
        return response

    def handle(
        self, side: str, message: dict, session_token: str | None = None
    ) -> dict | None:
        kind = message.get("type")
        player = self.players[side]
        other = "right" if side == "left" else "left"

        if kind in ("interact", "gallery", "stop"):
            after = message.get(
                "after", player.received if kind == "stop" else player.ack
            )
            if type(after) is not int or not 0 <= after <= player.received:
                raise Desync("Invalid interaction sequence.")
            if after > player.ack:
                if len(player.actions) >= 4:
                    raise ValueError("Please wait for your previous interaction.")
                player.actions.append((after, {**message, "after": after}, session_token))
                return None

        if kind == "input":
            inputs = message.get("inputs")
            if not isinstance(inputs, list) or not 1 <= len(inputs) <= 8:
                raise Desync("Invalid movement input.")
            # Validate the entire batch before modifying movement state.
            previous = player.received
            for item in inputs:
                if not isinstance(item, dict):
                    raise Desync("Invalid movement input.")
                seq, direction = item.get("seq"), item.get("direction")
                if (
                    type(seq) is not int
                    or seq != previous + 1
                    or type(direction) is not int
                    or direction not in (-1, 0, 1)
                    or type(item.get("jump", False)) is not bool
                ):
                    raise Desync("Invalid movement sequence.")
                previous = seq
            if len(player.inputs) + len(inputs) > 120:
                raise Desync("Too many queued movement inputs.")
            for item in inputs:
                player.inputs.append(
                    (item["seq"], item["direction"], item.get("jump", False))
                )
            player.received = previous
            player.paused = False
            return None

        if kind == "stop":
            player.paused = True
            player.moving = False
            player.jump_held = False
            player.jump_chain = 0
            return None

        if kind == "read":
            postcard_id = message.get("id")
            if type(postcard_id) is not int or postcard_id < 1:
                raise ValueError("Invalid postcard.")
            self.store.mark_read(side, postcard_id)
            self.refresh_mail()
            return None

        if kind in ("gallery", "delete"):
            if not self.nearby(side, WORLD["desks"][side]):
                raise ValueError("Return to your home to browse received postcards.")
            page = message.get("page", 0)
            if type(page) is not int or not 0 <= page <= 2**31 - 1:
                raise ValueError("Invalid gallery page.")
            if kind == "delete":
                postcard_id = message.get("id")
                if type(postcard_id) is not int or postcard_id < 1:
                    raise ValueError("Invalid postcard.")
                self.store.delete(side, postcard_id)
                self.refresh_mail()
            cards = self.store.inbox(
                side,
                include_read=True,
                limit=GALLERY_PAGE_SIZE + 1,
                offset=page * GALLERY_PAGE_SIZE,
            )
            if kind == "delete" and not cards and page > 0:
                page -= 1
                cards = self.store.inbox(
                    side,
                    include_read=True,
                    limit=GALLERY_PAGE_SIZE + 1,
                    offset=page * GALLERY_PAGE_SIZE,
                )
            return {
                "type": "gallery",
                "postcards": cards[:GALLERY_PAGE_SIZE],
                "page": page,
                "hasMore": len(cards) > GALLERY_PAGE_SIZE,
            }

        if kind == "write":
            body = message.get("body")
            title = message.get("title", "")
            stamp = message.get("stamp", 1)
            if not isinstance(body, str) or not 1 <= len(body.strip()) <= 1000:
                raise ValueError("Write a message between 1 and 1,000 characters.")
            if (
                not isinstance(title, str)
                or len(title.strip()) > 60
                or "\n" in title
                or "\r" in title
            ):
                raise ValueError(
                    "Keep the title to one line and at most 60 characters."
                )
            if type(stamp) is not int or stamp not in (1, 2, 3):
                raise ValueError("Choose one of the three stamps.")
            image_id = message.get("imageId")
            if image_id is not None and (
                not isinstance(image_id, str)
                or not re.fullmatch(r"[a-f0-9]{32}", image_id)
            ):
                raise ValueError("Invalid photo.")
            crop = message.get("crop", {"x": 0.5, "y": 0.5, "zoom": 1})
            if not isinstance(crop, dict) or any(
                type(crop.get(key)) not in (int, float)
                or not lower <= crop[key] <= upper
                or not math.isfinite(crop[key])
                for key, lower, upper in (("x", 0, 1), ("y", 0, 1), ("zoom", 1, 5))
            ):
                raise ValueError("Invalid photo position or zoom.")
            request_id = message.get("requestId")
            if request_id is not None and (
                not isinstance(request_id, str)
                or not re.fullmatch(r"[a-f0-9]{32}", request_id)
            ):
                raise ValueError("Invalid postcard request.")
            if (image_id or request_id) and not session_token:
                raise ValueError("Reconnect to the game to save this postcard.")
            owner = session_owner(side, session_token) if session_token else None
            payload_hash = hashlib.sha256(
                json.dumps(
                    [body.strip(), title.strip(), stamp, image_id, crop],
                    sort_keys=True,
                ).encode()
            ).hexdigest()
            acknowledgement = {
                "type": "written",
                **({"requestId": request_id} if request_id else {}),
            }
            if request_id and self.store.completed_write(
                owner, request_id, payload_hash
            ):
                return acknowledgement
            if not self.nearby(side, WORLD["desks"][side]):
                raise ValueError("Return to your desk to write a postcard.")
            if self.mail[side]["carrying"]:
                raise ValueError("Deliver the postcard in your backpack first.")
            self.store.write(
                side,
                body.strip(),
                stamp,
                title.strip(),
                image_id=image_id,
                crop=(crop["x"], crop["y"], crop["zoom"]),
                owner=owner,
                request_id=request_id,
                payload_hash=payload_hash,
            )
            self.refresh_mail()
            return acknowledgement

        if kind == "interact":
            if self.nearby(side, WORLD["desks"][side]):
                if self.mail[side]["carrying"]:
                    return None
                return {"type": "compose"}
            if self.nearby(side, WORLD["mailboxes"][other]):
                if not self.mail[side]["carrying"]:
                    return None
                self.use_mailbox(other)
                self.store.deliver(side)
                self.refresh_mail()
                for peer in self.peers.values():
                    peer.send({"type": "delivered", "sender": side, "recipient": other})
                return None
            if self.nearby(side, WORLD["mailboxes"][side]):
                self.use_mailbox(side)
                cards = self.store.inbox(side)
                return {"type": "mailbox", "postcards": cards} if cards else None
            return None

        raise ValueError("Unknown action.")
