"""Server and client movement must agree frame for frame, or prediction rubber-bands.

tests/fixtures/movement.json is the contract: this test checks the Python physics
against it, and client/tests/movement-parity.test.mjs checks movement.ts against it.
After an intended physics change, regenerate it with:

    uv run python tests/test_movement_parity.py
"""

import json
from pathlib import Path

import pytest

from server.game import WORLD, Player, move

FIXTURE = Path(__file__).parent / "fixtures" / "movement.json"
START = {"x": WORLD["minX"] + 12, "y": 0, "vy": 0, "jumpChain": 0, "landingTicks": 0}


def script() -> list[tuple[int, bool]]:
    """Inputs covering the wall clamp, jump chains, the speed cap, and landing."""
    inputs = [(-1, False)] * 20  # Run into the left wall.
    inputs += [(1, True)] * 400  # Hold jump while running: chain up to the cap.
    inputs += [(1, False)] * 30  # Release mid-air, land, and keep running.
    inputs += [(0, True), (0, False)] * 10  # Tap jump during landing recovery.
    inputs += [(0, False)] * 40  # Settle.
    inputs += [(-1, True)] * 3 + [(-1, False)] * 40  # Short hop left.
    return inputs


def simulate(inputs) -> list[list[float]]:
    player = Player("left", START["x"], 1)
    states = []
    for direction, jump in inputs:
        move(player, direction, jump)
        states.append(
            [player.x, player.y, player.vy, player.jump_chain, player.landing_ticks]
        )
    return states


def test_server_movement_matches_the_shared_fixture():
    fixture = json.loads(FIXTURE.read_text())
    assert fixture["start"] == START
    assert [tuple(item) for item in fixture["inputs"]] == script()
    actual, expected = simulate(script()), fixture["states"]
    assert len(actual) == len(expected)
    for frame, (got, want) in enumerate(zip(actual, expected)):
        assert got == pytest.approx(want, abs=1e-9), f"frame {frame}"


def test_fixture_exercises_every_movement_rule():
    states = simulate(script())
    assert min(state[0] for state in states) == WORLD["minX"]
    assert max(state[3] for state in states) == WORLD["maxJumpChain"]
    assert any(state[4] == WORLD["landingTicks"] for state in states)


if __name__ == "__main__":
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.write_text(
        json.dumps(
            {
                "start": START,
                "inputs": [list(item) for item in script()],
                "states": simulate(script()),
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    print(f"Wrote {FIXTURE}")
