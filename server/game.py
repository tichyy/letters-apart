"""One shared, flat world. The server advances one input per fixed tick."""

import asyncio
import json
import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import WebSocket

from .store import Store

SIDES = ("left", "right")
WORLD = json.loads((Path(__file__).resolve().parent.parent / "world.json").read_text())


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


@dataclass
class Peer:
    socket: WebSocket
    token: str
    outbox: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))

    def send(self, message: dict) -> None:
        # Snapshots are replaceable. Don't pile them up behind a slow connection.
        if message["type"] == "state" and self.outbox.qsize() > 1:
            return
        self.outbox.put_nowait(message)

    async def write(self) -> None:
        while True:
            message = await self.outbox.get()
            await asyncio.wait_for(self.socket.send_json(message), timeout=5)


class Game:
    def __init__(self, store: Store):
        self.store = store
        self.players = {
            side: Player(side, WORLD["desks"][side], 1 if side == "left" else -1)
            for side in SIDES
        }
        self.peers: dict[str, Peer] = {}
        self.mail = {side: store.summary(side) for side in SIDES}

    def snapshot(self) -> dict:
        return {
            "type": "state",
            "players": [
                {
                    "side": p.side, "x": p.x, "y": p.y, "vy": p.vy, "facing": p.facing,
                    "jumpChain": p.jump_chain, "landingTicks": p.landing_ticks,
                    "moving": p.moving, "ack": p.ack,
                    "connected": p.side in self.peers,
                    **self.mail[p.side],
                }
                for p in self.players.values()
            ],
        }

    def step(self) -> None:
        for player in self.players.values():
            player.moving = False
            direction = 0
            if player.inputs:
                seq, direction, jump = player.inputs.popleft()
                player.jump_held = jump
                player.ack = seq
                player.moving = direction != 0
                if direction:
                    player.facing = direction
            if player.y == 0:
                if not player.jump_held:
                    player.jump_chain = 0
                player.landing_ticks = max(0, player.landing_ticks - 1)
                if player.jump_held and player.landing_ticks == 0:
                    player.vy = -WORLD["jumpSpeed"]
                    player.jump_chain = min(player.jump_chain + 1, WORLD["maxJumpChain"])
            speed = WORLD["speed"] * (1 + max(0, player.jump_chain - 1) * WORLD["jumpBoost"])
            player.x = max(WORLD["minX"], min(
                WORLD["maxX"], player.x + direction * speed / WORLD["tickRate"]
            ))
            # Gravity continues even when an input packet is late or a player disconnects.
            previous_y = player.y
            player.vy += WORLD["gravity"] / WORLD["tickRate"]
            player.y = min(0, player.y + player.vy / WORLD["tickRate"])
            if player.y == 0:
                player.vy = 0
                if previous_y < 0:
                    player.landing_ticks = WORLD["landingTicks"]

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        tick = 0
        while True:
            self.step()
            tick += 1
            if tick % 2 == 0:
                state = self.snapshot()
                for peer in list(self.peers.values()):
                    peer.send(state)
            deadline += 1 / WORLD["tickRate"]
            # Bound catch-up after a suspended process; don't spiral through old ticks.
            deadline = max(deadline, loop.time() - 0.1)
            await asyncio.sleep(max(0, deadline - loop.time()))

    def stop(self, side: str) -> None:
        player = self.players[side]
        player.inputs.clear()
        player.ack = player.received
        player.moving = False
        player.jump_held = False
        player.jump_chain = 0

    def nearby(self, side: str, x: float) -> bool:
        player = self.players[side]
        return math.hypot(player.x - x, player.y) <= WORLD["radius"]

    def refresh_mail(self) -> None:
        self.mail = {side: self.store.summary(side) for side in SIDES}

    def use_mailbox(self, side: str) -> None:
        for peer in self.peers.values():
            peer.send({"type": "mailbox_used", "side": side})

    def handle(self, side: str, message: dict) -> dict | None:
        kind = message.get("type")
        player = self.players[side]
        other = "right" if side == "left" else "left"

        if kind == "input":
            inputs = message.get("inputs")
            if not isinstance(inputs, list) or not 1 <= len(inputs) <= 8:
                raise ValueError("Invalid movement input.")
            # Validate the entire batch before modifying movement state.
            previous = player.received
            for item in inputs:
                if not isinstance(item, dict):
                    raise ValueError("Invalid movement input.")
                seq, direction = item.get("seq"), item.get("direction")
                if (type(seq) is not int or seq != previous + 1
                        or type(direction) is not int or direction not in (-1, 0, 1)
                        or type(item.get("jump", False)) is not bool):
                    raise ValueError("Invalid movement sequence.")
                previous = seq
            if len(player.inputs) + len(inputs) > 120:
                raise ValueError("Too many queued movement inputs.")
            for item in inputs:
                player.inputs.append((item["seq"], item["direction"], item.get("jump", False)))
            player.received = previous
            return None

        if kind == "stop":
            self.stop(side)
            return None

        if kind == "read":
            postcard_id = message.get("id")
            if type(postcard_id) is not int or postcard_id < 1:
                raise ValueError("Invalid postcard.")
            self.store.mark_read(side, postcard_id)
            self.refresh_mail()
            return None

        if kind == "write":
            body = message.get("body")
            title = message.get("title", "")
            stamp = message.get("stamp", 1)
            if not isinstance(body, str) or not 1 <= len(body.strip()) <= 1000:
                raise ValueError("Write a message between 1 and 1,000 characters.")
            if not isinstance(title, str) or len(title.strip()) > 60 or "\n" in title or "\r" in title:
                raise ValueError("Keep the title to one line and at most 60 characters.")
            if type(stamp) is not int or stamp not in (1, 2, 3):
                raise ValueError("Choose one of the three stamps.")
            if not self.nearby(side, WORLD["desks"][side]):
                raise ValueError("Return to your desk to write a postcard.")
            if self.mail[side]["carrying"]:
                raise ValueError("Deliver the postcard in your backpack first.")
            self.store.write(side, body.strip(), stamp, title.strip())
            self.refresh_mail()
            return {"type": "written"}

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
