from types import SimpleNamespace

import pytest

from server.game import Game, Peer, WORLD
from server.store import Store


@pytest.fixture
def game(tmp_path):
    store = Store(tmp_path / "network.sqlite3")
    game = Game(store)
    game.events = []
    game.peers["left"] = SimpleNamespace(send=game.events.append)
    yield game
    store.close()


def inputs(game, start, count, direction=1, jump=False):
    for first in range(start, start + count, 8):
        game.handle("left", {"type": "input", "inputs": [
            {"seq": seq, "direction": direction, "jump": jump}
            for seq in range(first, min(first + 8, start + count))
        ]})


def test_delayed_packets_catch_up_using_earned_time(game):
    player = game.players["left"]
    start = player.x
    for _ in range(12):
        game.step()
    inputs(game, 1, 12)
    game.step(0)
    assert player.ack == 12
    assert not player.inputs
    assert player.x == pytest.approx(start + WORLD["speed"] * 0.2)


def test_catch_up_does_not_grant_unearned_simulation_steps(game):
    inputs(game, 1, 8)
    game.step()
    assert game.players["left"].ack == 1
    game.step(0)
    assert game.players["left"].ack == 1


def test_slow_loop_keeps_up_with_sixty_inputs_per_second(game):
    # Three client steps per 50 ms; the server loop itself runs at only 20 Hz.
    for first in range(1, 301, 3):
        inputs(game, first, 3)
        game.step(0.05)
        assert not game.players["left"].inputs
    assert game.players["left"].ack == 300


def test_packet_gap_does_not_double_advance_jump_physics(game):
    inputs(game, 1, 1, jump=True)
    game.step()
    player = game.players["left"]
    before = (player.y, player.vy)
    for _ in range(10):
        game.step()
    assert (player.y, player.vy) == before
    inputs(game, 2, 10, jump=True)
    game.step(0)
    assert player.ack == 11
    expected_velocity = -WORLD["jumpSpeed"] + 11 * WORLD["gravity"] / WORLD["tickRate"]
    assert player.vy == pytest.approx(expected_velocity)


def test_stop_applies_preceding_movement_without_discarding_future_inputs(game):
    player = game.players["left"]
    start = player.x
    inputs(game, 1, 2)
    game.handle("left", {"type": "stop", "after": 2})
    inputs(game, 3, 1, direction=0)
    game.step()
    assert player.ack == 1 and len(player.actions) == 1
    game.step()
    assert player.ack == 2 and player.paused and not player.moving
    assert len(player.inputs) == 1
    game.step()
    assert player.ack == 3 and not player.inputs
    assert player.x == pytest.approx(start + 2 * WORLD["speed"] / WORLD["tickRate"])


def test_deferred_interaction_executes_at_its_sequence_boundary(game):
    inputs(game, 1, 2, direction=0)
    assert game.handle("left", {"type": "gallery", "after": 2}) is None
    game.step()
    assert not game.events
    game.step()
    assert game.events == [{"type": "gallery", "postcards": [], "page": 0, "hasMore": False}]


def test_deferred_interaction_reports_validation_errors(game):
    game.players["left"].x = 1000
    inputs(game, 1, 1)
    game.handle("left", {"type": "gallery", "after": 1})
    game.step()
    assert game.events[0]["type"] == "error"
    assert "home" in game.events[0]["message"]


@pytest.mark.parametrize("after", [-1, 1, True, "0"])
def test_interaction_cannot_reference_invalid_or_unreceived_inputs(game, after):
    with pytest.raises(ValueError, match="sequence"):
        game.handle("left", {"type": "gallery", "after": after})


def test_reconnect_only_acknowledges_applied_inputs_and_finishes_falling(game):
    inputs(game, 1, 2, jump=True)
    game.step()
    game.stop("left")
    player = game.players["left"]
    assert player.ack == player.received == 1
    assert not player.inputs
    for _ in range(60):
        game.step()
    assert player.y == 0
    inputs(game, 2, 1)
    game.step()
    assert player.ack == 2


def test_slow_writer_gets_latest_state_without_losing_reliable_events():
    peer = Peer(None, "test-token")
    peer.send({"type": "state", "time": 1})
    peer.send({"type": "delivered"})
    peer.send({"type": "state", "time": 2})
    peer.send({"type": "state", "time": 3})
    assert peer.outbox.get_nowait() == {"type": "delivered"}
    assert peer.outbox.get_nowait() == {"type": "state", "time": 3}
    assert peer.outbox.empty()


@pytest.mark.parametrize("stall", [0.5, 1.5, 1.9])
def test_backlog_after_a_stall_drains_instead_of_delaying_forever(game, stall):
    # The client keeps producing 60 inputs/s; its uplink delivers nothing for
    # `stall` seconds, then everything at once, and then resumes normally.
    sent, held = 0, []
    for tick in range(60 * 6):
        sent += 1
        held.append(sent)
        if not 60 <= tick < 60 + stall * 60:
            inputs(game, held[0], len(held))
            held = []
        game.step()
    assert sent - game.players["left"].ack <= 1


def test_catch_up_allowance_never_exceeds_elapsed_time(game):
    # Withholding inputs earns at most the buffered limit: never faster than real time.
    for _ in range(10 * 60):
        game.step()
    inputs(game, 1, 120)
    game.step(0)
    assert game.players["left"].ack == 120
    inputs(game, 121, 8)
    game.step(0)
    assert game.players["left"].ack == 120


def test_snapshots_count_each_players_physics_steps(game):
    inputs(game, 1, 5)
    for _ in range(5):
        game.step()
    states = {p["side"]: p for p in game.snapshot()["players"]}
    assert states["left"]["step"] == 5 and states["right"]["step"] == 0
