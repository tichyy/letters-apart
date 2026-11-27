"""Speech bubbles: short-lived chat lines and live drafts, kept in memory only.

Lines outlive a reload (the server re-sends the ones still showing) but not a
restart. Drafts are only what a player is typing right now.
"""

import json
import re
import time
import unicodedata
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

CHAT = json.loads(
    (Path(__file__).resolve().parent.parent / "chat.json").read_text(encoding="utf-8")
)
# What the pixel font can draw; tests/test_chat.py keeps this in step with the font.
CHARACTERS = frozenset(CHAT["characters"])
# Longer than any line a client sends (it cleans as you type), so a raw message
# this long is not from the game.
MAX_RAW_LENGTH = 4 * CHAT["maxLength"]
WHITESPACE = re.compile(r"\s")


def clean(text: str) -> str:
    """Keep what the font can draw, with any whitespace as a plain space, up to the
    length limit. client/src/chat.ts cleans the same way while the player types."""
    text = WHITESPACE.sub(" ", unicodedata.normalize("NFC", text))
    return "".join(c for c in text if c in CHARACTERS)[: CHAT["maxLength"]]


def lifetime(text: str) -> float:
    """Seconds a line stays up: longer lines get longer to read."""
    limits = CHAT["lifetime"]
    return min(limits["max"], limits["base"] + limits["perCharacter"] * len(text)) / 1000


@dataclass
class Line:
    side: str
    id: str
    text: str
    expires: float


class Chat:
    def __init__(self, sides: tuple[str, ...], clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.lines = {side: deque(maxlen=CHAT["lines"]) for side in sides}
        self.drafts = {side: "" for side in sides}

    def say(self, side: str, line_id: str, text: str) -> dict:
        """Commit a line; it replaces its speaker's draft."""
        line = Line(side, line_id, text, self.clock() + lifetime(text))
        self.lines[side].append(line)
        self.drafts[side] = ""
        return self.describe(line)

    def sync(self) -> dict:
        """Everything still showing, for a player who just (re)connected."""
        now = self.clock()
        for lines in self.lines.values():
            while lines and lines[0].expires <= now:
                lines.popleft()
        return {
            "type": "chat",
            "lines": [self.describe(line) for lines in self.lines.values() for line in lines],
            "drafts": dict(self.drafts),
        }

    def describe(self, line: Line) -> dict:
        # Time left rather than a timestamp: the two clocks don't agree.
        remaining = max(0, round((line.expires - self.clock()) * 1000))
        return {"side": line.side, "id": line.id, "text": line.text, "remaining": remaining}
