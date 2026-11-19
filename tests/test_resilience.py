"""The shared game loop and each connection must survive slow peers and failures."""

import asyncio
import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import join
from server.app import create_app
from server.game import MESSAGE_BURST, WORLD, Game, Peer
from server.store import Store


@pytest.fixture
def game(tmp_path):
    store = Store(tmp_path / "resilience.sqlite3")
    yield Game(store)
    store.close()


class StalledSocket:
    async def send_json(self, message):
        await asyncio.sleep(3600)


def test_reliable_overflow_drops_the_slow_peer_instead_of_raising():
    peer = Peer(None, "slow-peer-token")
    for _ in range(32):
        peer.send({"type": "mailbox_used", "side": "left"})
    peer.send({"type": "mailbox_used", "side": "left"})
    assert peer.dropped.is_set()
    assert peer.closing == (1013, "Connection too slow.")
    peer.send({"type": "delivered"})  # Later sends are ignored, not raised.
    assert peer.outbox.qsize() == 32


def test_stalled_partner_cannot_stop_the_game_loop(game):
    async def scenario():
        game.peers["left"] = Peer(StalledSocket(), "left-player-token")
        game.peers["right"] = Peer(StalledSocket(), "right-player-token")
        game.players["left"].x = WORLD["mailboxes"]["left"]
        loop = asyncio.create_task(game.run())
        # Each mailbox check broadcasts to both peers, whose writers never drain.
        for seq in range(1, 41):
            game.handle("left", {"type": "input", "inputs": [{"seq": seq, "direction": 0}]})
            game.respond("left", {"type": "interact", "after": seq})
            await asyncio.sleep(1 / 60)
        await asyncio.sleep(0.1)
        assert not loop.done()
        assert game.healthy()
        assert game.peers["right"].closing == (1013, "Connection too slow.")
        loop.cancel()

    asyncio.run(scenario())


def test_game_loop_keeps_ticking_after_an_unexpected_error(game, monkeypatch, caplog):
    step = game.step
    failures = []

    def flaky_step(seconds):
        if not failures:
            failures.append(seconds)
            raise RuntimeError("boom")
        step(seconds)

    monkeypatch.setattr(game, "step", flaky_step)

    async def scenario():
        loop = asyncio.create_task(game.run())
        await asyncio.sleep(0.1)
        # healthy() needs a tick that completed after the failure.
        assert not loop.done() and game.healthy()
        loop.cancel()

    asyncio.run(scenario())
    assert "Game tick failed" in caplog.text


def test_persistently_failing_ticks_report_unhealthy(game, monkeypatch):
    monkeypatch.setattr("server.game.HEALTHY_WITHIN", 0.2)
    step = game.step
    broken = []

    def failing_step(seconds):
        if broken:
            raise RuntimeError("stuck")
        step(seconds)

    monkeypatch.setattr(game, "step", failing_step)

    async def scenario():
        loop = asyncio.create_task(game.run())
        await asyncio.sleep(0.05)
        assert game.healthy()
        broken.append(True)
        await asyncio.sleep(0.3)
        # The loop task is alive but the world is frozen, so health must say so.
        assert not loop.done() and not game.healthy()
        loop.cancel()

    asyncio.run(scenario())


def test_health_reports_a_stalled_game_loop(tmp_path, monkeypatch):
    app = create_app(tmp_path / "cards.sqlite3")
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        monkeypatch.setattr(Game, "healthy", lambda self: False)
        response = client.get("/healthz")
        assert response.status_code == 503


def test_database_errors_become_replies_with_the_request_id(game, monkeypatch, caplog):
    def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(game.store, "write", broken)
    game.players["left"].x = WORLD["desks"]["left"]
    request_id = "a" * 32
    response = game.respond(
        "left",
        {"type": "write", "body": "Hello", "requestId": request_id},
        "left-player-token",
    )
    assert response == {
        "type": "error",
        "message": "Something went wrong. Please try again.",
        "requestId": request_id,
    }
    assert "disk I/O error" in caplog.text


def test_deferred_database_errors_do_not_escape_the_tick(game, monkeypatch):
    sent = []
    game.peers["left"] = SimpleNamespace(send=sent.append)
    game.players["left"].x = WORLD["mailboxes"]["right"]
    game.store.write("left", "Carried")
    game.refresh_mail()

    def broken(side):
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(game.store, "deliver", broken)
    game.handle("left", {"type": "input", "inputs": [{"seq": 1, "direction": 0}]})
    game.handle("left", {"type": "interact", "after": 1})
    game.step()
    assert {"type": "error", "message": "Something went wrong. Please try again."} in sent


def test_rejected_input_batch_asks_the_client_to_resync(game):
    peer = Peer(None, "left-player-token")
    game.peers["left"] = peer
    batch = {"type": "input", "inputs": [{"seq": 5, "direction": 1}]}
    assert game.respond("left", batch) is None
    assert peer.closing == (4000, "Resynchronizing.")
    assert game.players["left"].received == 0


def test_message_budget_refills_over_time(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("server.game.time.monotonic", lambda: now[0])
    peer = Peer(None, "budget-peer-token")
    assert all(peer.allow() for _ in range(MESSAGE_BURST))
    assert not peer.allow()
    now[0] += 0.5
    assert sum(peer.allow() for _ in range(MESSAGE_BURST)) == 5


def test_flooding_non_movement_messages_is_throttled(tmp_path):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with join(client, "/ws/left", "left-player-token") as socket:
            assert socket.receive_json()["type"] == "welcome"
            for _ in range(MESSAGE_BURST + 5):
                socket.send_json({"type": "read", "id": 1})
            for _ in range(240):
                message = socket.receive_json()
                if message["type"] == "error":
                    break
            assert message == {"type": "error", "message": "Slow down a little."}


@pytest.mark.parametrize(
    "hello",
    [None, {"type": "hello"}, {"type": "hello", "token": "short"}, {"type": "input"}],
)
def test_websocket_requires_a_hello_with_a_valid_token(tmp_path, hello):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with client.websocket_connect("/ws/left") as socket:
            socket.send_text("not json" if hello is None else json.dumps(hello))
            with pytest.raises(WebSocketDisconnect) as error:
                socket.receive_json()
            assert error.value.code == 1008 and error.value.reason == "Invalid player."


def test_resync_close_is_followed_by_a_clean_reconnect(tmp_path):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with join(client, "/ws/left", "left-player-token") as socket:
            assert socket.receive_json()["type"] == "welcome"
            socket.send_json({"type": "input", "inputs": [{"seq": 9, "direction": 1}]})
            with pytest.raises(WebSocketDisconnect) as error:
                while True:
                    socket.receive_json()
            assert error.value.code == 4000
        with join(client, "/ws/left", "left-player-token") as socket:
            welcome = socket.receive_json()
            assert welcome["type"] == "welcome"
            assert welcome["players"][0]["ack"] == 0
