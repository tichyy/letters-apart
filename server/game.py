"""One shared world with sequenced inputs and bounded, elapsed-time catch-up."""

import asyncio
import hashlib
import json
import logging
import math
import sqlite3
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import WebSocket

from .chat import MAX_RAW_LENGTH, Chat, clean
from .images import IMAGE_ID
from .store import Store, session_owner

SIDES = ("left", "right")
GALLERY_PAGE_SIZE = 12
WORLD = json.loads((Path(__file__).resolve().parent.parent / "world.json").read_text())
# Non-movement messages (interactions, reads, writes) per peer: sustained rate and burst.
MESSAGE_RATE = 10
MESSAGE_BURST = 20
# Chat has budgets of its own. Lines: 10 in any 5 seconds. Drafts arrive with each
# keystroke (clients send at most 20 a second); extras are dropped without a reply.
CHAT_RATE = 2
CHAT_BURST = 10
DRAFT_RATE = 30
DRAFT_BURST = 30
# How far a client's inputs may run ahead of the server: the input queue limit, and
# the catch-up allowance a stalled connection earns. They must match, or a backlog
# larger than the allowance never drains and the player stays permanently delayed.
MAX_BUFFERED_INPUTS = 2 * WORLD["tickRate"]
# /healthz fails when no tick has completed successfully within this many seconds.
HEALTHY_WITHIN = 1.0
# Interactions wait for the movement sent before them, so they use the position the
# player saw on screen. "stop" waits for every input received.
SEQUENCED = ("interact", "gallery", "stop")
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
    # Physics steps applied. Partners play this player back on this timeline, which
    # stays evenly spaced however unevenly the inputs arrived.
    steps: int = 0
    moving: bool = False
    ack: int = 0
    received: int = 0
    inputs: deque = field(default_factory=deque)
    credit: float = 0
    paused: bool = False
    actions: deque = field(default_factory=deque)


@dataclass
class Bucket:
    """A token bucket: `rate` tokens a second, holding at most `burst`."""

    rate: float
    burst: float
    tokens: float = -1
    refilled: float = field(default_factory=lambda: time.monotonic())

    def __post_init__(self) -> None:
        if self.tokens < 0:
            self.tokens = self.burst

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(
            self.burst, self.tokens + max(0, now - self.refilled) * self.rate
        )
        self.refilled = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


@dataclass
class Peer:
    socket: WebSocket
    token: str
    outbox: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))
    # Set once this connection must end; its handler closes the socket with `closing`.
    dropped: asyncio.Event = field(default_factory=asyncio.Event)
    closing: tuple[int, str] | None = None
    budget: Bucket = field(default_factory=lambda: Bucket(MESSAGE_RATE, MESSAGE_BURST))
    chat: Bucket = field(default_factory=lambda: Bucket(CHAT_RATE, CHAT_BURST))
    drafts: Bucket = field(default_factory=lambda: Bucket(DRAFT_RATE, DRAFT_BURST))

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

    def allow(self, kind: object = None) -> bool:
        """Spend one token from the budget for this kind of message."""
        if kind == "input":
            # Bounded by its own sequence and queue checks.
            return True
        # Anything else, malformed types included, spends the general budget; the
        # handler then answers an unknown type with an error.
        if kind == "say":
            return self.chat.take()
        if kind == "draft":
            return self.drafts.take()
        return self.budget.take()

    async def write(self) -> None:
        while True:
            message = await self.outbox.get()
            await asyncio.wait_for(self.socket.send_json(message), timeout=5)


def move(player: Player, direction: int, jump: bool) -> None:
    """Advance one input. Must match client/src/movement.ts; see test_movement_parity."""
    player.steps += 1
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
        self.last_tick: float | None = None
        self.last_error = -math.inf
        self.chat = Chat(SIDES)
        self.handlers: dict[str, Callable[[str, dict, str | None], dict | None]] = {
            "input": self.receive_inputs,
            "stop": self.pause,
            "interact": self.interact,
            "gallery": self.gallery,
            "delete": self.delete,
            "read": self.read,
            "write": self.write,
            "drop": self.drop,
            "say": self.say,
            "draft": self.draft,
        }

    def snapshot(self) -> dict:
        return {
            "type": "state",
            "players": [
                {
                    "side": p.side,
                    "x": p.x,
                    "y": p.y,
                    "vy": p.vy,
                    "facing": p.facing,
                    "jumpChain": p.jump_chain,
                    "landingTicks": p.landing_ticks,
                    "step": p.steps,
                    "moving": p.moving,
                    "ack": p.ack,
                    "connected": p.side in self.peers,
                    **self.mail[p.side],
                }
                for p in self.players.values()
            ],
        }

    def step(self, seconds: float = 1 / WORLD["tickRate"]) -> None:
        for player in self.players.values():
            # Credit is earned by wall time, not loop iterations. Delayed packets
            # can catch up without granting faster-than-real-time movement.
            player.credit = min(
                MAX_BUFFERED_INPUTS, player.credit + seconds * WORLD["tickRate"]
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
        while True:
            now = loop.time()
            elapsed, previous = max(0, now - previous), now
            try:
                self.step(elapsed)
                # Every tick, so partners get each step as soon as it is applied
                # and can play back with a shallower buffer.
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
        pause(player)

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
        handler = self.handlers.get(kind) if isinstance(kind, str) else None
        if handler is None:
            raise ValueError("Unknown action.")
        if kind in SEQUENCED and self.defer(side, message, session_token):
            return None
        return handler(side, message, session_token)

    def defer(self, side: str, message: dict, session_token: str | None) -> bool:
        """Queue an interaction until the inputs sent before it are applied.

        Returns True when queued; step() replays it once the input is acknowledged."""
        player = self.players[side]
        after = message.get(
            "after", player.received if message["type"] == "stop" else player.ack
        )
        if type(after) is not int or not 0 <= after <= player.received:
            raise Desync("Invalid interaction sequence.")
        if after <= player.ack:
            return False
        if len(player.actions) >= 4:
            raise ValueError("Please wait for your previous interaction.")
        player.actions.append((after, {**message, "after": after}, session_token))
        return True

    def receive_inputs(self, side: str, message: dict, _token: str | None) -> None:
        player = self.players[side]
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
        if len(player.inputs) + len(inputs) > MAX_BUFFERED_INPUTS:
            raise Desync("Too many queued movement inputs.")
        for item in inputs:
            player.inputs.append(
                (item["seq"], item["direction"], item.get("jump", False))
            )
        player.received = previous
        player.paused = False

    def pause(self, side: str, _message: dict, _token: str | None) -> None:
        pause(self.players[side])

    def read(self, side: str, message: dict, _token: str | None) -> None:
        self.store.mark_read(side, postcard_id(message))
        self.refresh_mail()

    def gallery(self, side: str, message: dict, _token: str | None) -> dict:
        return self.gallery_page(side, self.desk_page(side, message))

    def delete(self, side: str, message: dict, _token: str | None) -> dict:
        page = self.desk_page(side, message)
        self.store.delete(side, postcard_id(message))
        self.refresh_mail()
        response = self.gallery_page(side, page)
        # Deleting the only card on the last page shows the page before it.
        if not response["postcards"] and page > 0:
            response = self.gallery_page(side, page - 1)
        return response

    def desk_page(self, side: str, message: dict) -> int:
        """The requested gallery page, which can only be browsed from home."""
        if not self.nearby(side, WORLD["desks"][side]):
            raise ValueError("Return to your home to browse received postcards.")
        page = message.get("page", 0)
        if type(page) is not int or not 0 <= page <= 2**31 - 1:
            raise ValueError("Invalid gallery page.")
        return page

    def gallery_page(self, side: str, page: int) -> dict:
        # One extra card tells whether another page follows.
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

    def write(self, side: str, message: dict, session_token: str | None) -> dict:
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
            raise ValueError("Keep the title to one line and at most 60 characters.")
        to, from_ = message.get("to", ""), message.get("from", "")
        if any(
            not isinstance(name, str) or len(name.strip()) > 30 or "\n" in name or "\r" in name
            for name in (to, from_)
        ):
            raise ValueError("Keep the names to one line and at most 30 characters.")
        if type(stamp) is not int or stamp not in (1, 2, 3):
            raise ValueError("Choose one of the three stamps.")
        image_id = message.get("imageId")
        if image_id is not None and not hex_id(image_id):
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
        if request_id is not None and not hex_id(request_id):
            raise ValueError("Invalid postcard request.")
        if (image_id or request_id) and not session_token:
            raise ValueError("Reconnect to the game to save this postcard.")
        owner = session_owner(side, session_token) if session_token else None
        payload_hash = hashlib.sha256(
            json.dumps(
                [body.strip(), title.strip(), to.strip(), from_.strip(), stamp, image_id, crop],
                sort_keys=True,
            ).encode()
        ).hexdigest()
        acknowledgement = {
            "type": "written",
            **({"requestId": request_id} if request_id else {}),
        }
        if request_id and self.store.completed_write(owner, request_id, payload_hash):
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
            to=to.strip(),
            from_=from_.strip(),
            image_id=image_id,
            crop=(crop["x"], crop["y"], crop["zoom"]),
            owner=owner,
            request_id=request_id,
            payload_hash=payload_hash,
        )
        self.refresh_mail()
        return acknowledgement

    def say(self, side: str, message: dict, _token: str | None) -> None:
        """Commit a chat line. Both players get it, the speaker as confirmation."""
        request_id = message.get("requestId")
        if not hex_id(request_id):
            raise ValueError("Invalid chat message.")
        text = chat_text(message)
        if not text.strip():
            raise ValueError("Write something to say.")
        line = self.chat.say(side, request_id, text.strip())
        for peer in self.peers.values():
            peer.send({"type": "said", "line": line})

    def draft(self, side: str, message: dict, _token: str | None) -> None:
        """What the player is typing right now, shown live to the other player."""
        text = chat_text(message)
        if text != self.chat.drafts[side]:
            self.chat.drafts[side] = text
            self.tell_partner(side, {"type": "draft", "side": side, "text": text})

    def end_draft(self, side: str) -> None:
        """A draft lasts only while its connection does."""
        if self.chat.drafts[side]:
            self.chat.drafts[side] = ""
            self.tell_partner(side, {"type": "draft", "side": side, "text": ""})

    def tell_partner(self, side: str, message: dict) -> None:
        if peer := self.peers.get("right" if side == "left" else "left"):
            peer.send(message)

    def drop(self, side: str, _message: dict, _token: str | None) -> dict | None:
        if not self.mail[side]["carrying"]:
            return None
        self.store.drop(side)
        self.refresh_mail()
        return {"type": "dropped"}

    def interact(self, side: str, _message: dict, _token: str | None) -> dict | None:
        """Use whatever is in reach: the desk, the partner's mailbox or your own."""
        other = "right" if side == "left" else "left"
        carrying = self.mail[side]["carrying"]
        if self.nearby(side, WORLD["desks"][side]):
            return None if carrying else {"type": "compose", **self.store.last_address(side)}
        if self.nearby(side, WORLD["mailboxes"][other]):
            if not carrying:
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


def pause(player: Player) -> None:
    """Stop moving in place; a fall in progress still lands."""
    player.paused = True
    player.moving = False
    player.jump_held = False
    player.jump_chain = 0


def chat_text(message: dict) -> str:
    text = message.get("text")
    if not isinstance(text, str) or len(text) > MAX_RAW_LENGTH:
        raise ValueError("Invalid chat message.")
    return clean(text)


def postcard_id(message: dict) -> int:
    value = message.get("id")
    if type(value) is not int or value < 1:
        raise ValueError("Invalid postcard.")
    return value


def hex_id(value: object) -> bool:
    """Photo and postcard request IDs: 32 lowercase hex characters."""
    return isinstance(value, str) and IMAGE_ID.fullmatch(value) is not None
