import asyncio
import json
import math
import sqlite3
from contextlib import closing
from types import SimpleNamespace

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import create_app
from server.game import WORLD, Game, Peer
from server.store import Store


@pytest.fixture
def game(tmp_path):
    store = Store(tmp_path / "postcards.sqlite3")
    yield Game(store)
    store.close()


def write(game, side, body="Thinking of you."):
    game.players[side].x = WORLD["desks"][side]
    return game.handle(side, {"type": "write", "body": body})


def deliver(game, side):
    other = "right" if side == "left" else "left"
    game.players[side].x = WORLD["mailboxes"][other]
    return game.handle(side, {"type": "interact"})


def test_postcard_round_trip_and_persistence(game, tmp_path):
    assert write(game, "left", "  See you soon. ♥  ") == {"type": "written"}
    assert game.mail["left"]["carrying"]
    # Snapshots expose the backpack, never the private message.
    assert "See you" not in json.dumps(game.snapshot())
    deliver(game, "left")
    assert not game.mail["left"]["carrying"]
    assert game.mail["right"]["unread"] == 1

    # Recreate the world against the same journal, as after a server restart.
    restarted = Game(game.store)
    restarted.players["right"].x = WORLD["mailboxes"]["right"]
    postcard = restarted.handle("right", {"type": "interact"})["postcards"][0]
    assert postcard["body"] == "See you soon. ♥"
    assert restarted.mail["right"]["unread"] == 1
    restarted.handle("right", {"type": "read", "id": postcard["id"]})
    assert restarted.mail["right"]["unread"] == 0
    assert restarted.handle("right", {"type": "interact"}) is None
    with closing(Store(tmp_path / "postcards.sqlite3")) as store:
        assert store.inbox("right") == []


def test_writing_requires_own_desk_and_one_carried_card(game):
    game.players["left"].x = WORLD["desks"]["right"]
    with pytest.raises(ValueError, match="your desk"):
        game.handle("left", {"type": "write", "body": "Hello"})
    write(game, "left")
    with pytest.raises(ValueError, match="backpack first"):
        write(game, "left", "A duplicate")
    assert game.handle("left", {"type": "interact"}) is None
    assert game.store.db.execute("SELECT COUNT(*) FROM postcards").fetchone()[0] == 1


@pytest.mark.parametrize("stamp", [1, 2, 3])
def test_selected_stamp_survives_delivery_and_restart(game, tmp_path, stamp):
    game.handle("left", {"type": "write", "body": "See you soon.", "stamp": stamp})
    deliver(game, "left")
    with closing(Store(tmp_path / "postcards.sqlite3")) as store:
        card = store.inbox("right")[0]
        assert card["body"] == "See you soon."
        assert card["stamp"] == stamp


def test_title_survives_delivery_and_restart(game, tmp_path):
    game.handle(
        "left",
        {"type": "write", "title": "  Hello from home  ", "body": "Thinking of you."},
    )
    deliver(game, "left")
    with closing(Store(tmp_path / "postcards.sqlite3")) as store:
        card = store.inbox("right")[0]
        assert card["title"] == "Hello from home"
        assert card["body"] == "Thinking of you."


@pytest.mark.parametrize(
    "title", [None, True, [], "a" * 61, "Two\nlines", "Two\rlines"]
)
def test_invalid_title_is_not_saved(game, title):
    with pytest.raises(ValueError, match="title"):
        game.handle("left", {"type": "write", "title": title, "body": "Hello"})
    assert not game.mail["left"]["carrying"]


@pytest.mark.parametrize("stamp", [0, 4, "2", True, None])
def test_invalid_stamp_is_not_saved(game, stamp):
    with pytest.raises(ValueError, match="three stamps"):
        game.handle("left", {"type": "write", "body": "Hello", "stamp": stamp})
    assert not game.mail["left"]["carrying"]


def test_existing_postcards_get_default_stamp(tmp_path):
    path = tmp_path / "old-postcards.sqlite3"
    with closing(sqlite3.connect(path)) as db:
        db.execute("""CREATE TABLE postcards (
            id INTEGER PRIMARY KEY, sender TEXT, body TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT, read_at TEXT
        )""")
        db.execute("""INSERT INTO postcards(sender, body, delivered_at)
            VALUES ('left', 'An older postcard.', CURRENT_TIMESTAMP)""")
        db.commit()
    with closing(Store(path)) as store:
        card = store.inbox("right")[0]
        assert card["body"] == "An older postcard."
        assert card["stamp"] == 1
        assert card["title"] == ""


@pytest.mark.parametrize("body", [None, [], "", " \n ", "a" * 1001])
def test_invalid_postcard_is_not_saved(game, body):
    with pytest.raises(ValueError, match="1,000"):
        write(game, "left", body)
    assert not game.mail["left"]["carrying"]


def test_delivery_requires_correct_location_and_cannot_repeat(game):
    write(game, "left")
    game.players["left"].x = 480
    game.handle("left", {"type": "input", "inputs": [{"seq": 1, "direction": 1}]})
    assert game.handle("left", {"type": "interact"}) is None
    game.step()
    assert game.players["left"].moving
    assert game.players["left"].x > 480
    game.players["left"].x = WORLD["mailboxes"]["left"]
    assert game.handle("left", {"type": "interact"}) is None
    assert game.mail["left"]["carrying"]
    deliver(game, "left")
    assert deliver(game, "left") is None
    assert game.mail["right"]["unread"] == 1


def test_mailbox_lists_unread_cards_oldest_first_and_keeps_unseen_cards(game):
    for body in ["First", "Second"]:
        write(game, "right", body)
        deliver(game, "right")
    game.players["left"].x = WORLD["mailboxes"]["left"]
    cards = game.handle("left", {"type": "interact"})["postcards"]
    assert [card["body"] for card in cards] == ["First", "Second"]
    assert game.mail["left"]["unread"] == 2
    game.handle("left", {"type": "read", "id": cards[0]["id"]})
    assert game.mail["left"]["unread"] == 1
    assert [
        card["body"] for card in game.handle("left", {"type": "interact"})["postcards"]
    ] == ["Second"]
    game.handle("left", {"type": "read", "id": cards[1]["id"]})
    assert game.mail["left"]["unread"] == 0
    assert game.handle("left", {"type": "interact"}) is None


@pytest.mark.parametrize("side", ["left", "right"])
def test_home_gallery_keeps_received_cards_after_reading_and_restart(
    game, tmp_path, side
):
    other = "right" if side == "left" else "left"
    for body in ("First", "Second"):
        write(game, other, body)
        deliver(game, other)
    first = game.store.inbox(side)[0]
    game.handle(side, {"type": "read", "id": first["id"]})
    write(game, side, "My outgoing postcard")
    deliver(game, side)
    write(game, other, "Still in the sender's backpack")
    write(game, side, "I can browse while carrying my own card")
    result = game.handle(side, {"type": "gallery"})
    assert [card["body"] for card in result["postcards"]] == ["Second", "First"]
    assert result["page"] == 0 and not result["hasMore"]
    assert game.mail[side]["unread"] == 1
    assert [card["body"] for card in game.store.inbox(side)] == ["Second"]
    game.players[side].x = WORLD["desks"][other]
    with pytest.raises(ValueError, match="your home"):
        game.handle(side, {"type": "gallery"})
    with closing(Store(tmp_path / "postcards.sqlite3")) as store:
        restarted = Game(store)
        assert restarted.handle(side, {"type": "gallery"}) == result


def test_gallery_paginates_without_marking_unseen_postcards_read(game):
    for index in range(15):
        write(game, "right", f"Card {index}")
        deliver(game, "right")
    game.players["left"].x = WORLD["desks"]["left"]
    first = game.handle("left", {"type": "gallery"})
    second = game.handle("left", {"type": "gallery", "page": 1})
    assert len(first["postcards"]) == 12 and first["hasMore"]
    assert [card["body"] for card in second["postcards"]] == [
        "Card 2",
        "Card 1",
        "Card 0",
    ]
    assert not second["hasMore"] and second["page"] == 1
    assert not {card["id"] for card in first["postcards"]} & {
        card["id"] for card in second["postcards"]
    }
    assert game.mail["left"]["unread"] == 15
    game.handle("left", {"type": "read", "id": first["postcards"][0]["id"]})
    assert game.mail["left"]["unread"] == 14
    assert game.handle("left", {"type": "gallery"}) == first


@pytest.mark.parametrize("page", [None, True, "1", -1, 2**31, []])
def test_gallery_rejects_invalid_pages(game, page):
    with pytest.raises(ValueError, match="gallery page"):
        game.handle("left", {"type": "gallery", "page": page})


@pytest.mark.parametrize("side", ["left", "right"])
def test_library_delete_is_soft_and_persists(game, tmp_path, side):
    other = "right" if side == "left" else "left"
    write(game, other, "Keep the original postcard")
    deliver(game, other)
    card = game.store.inbox(side)[0]
    game.players[side].x = WORLD["desks"][side]
    result = game.handle(side, {"type": "delete", "id": card["id"]})
    assert result == {"type": "gallery", "postcards": [], "page": 0, "hasMore": False}
    assert game.mail[side]["unread"] == 0
    assert game.store.inbox(side) == []
    row = game.store.db.execute(
        "SELECT body, deleted_at FROM postcards WHERE id = ?", (card["id"],)
    ).fetchone()
    assert row["body"] == card["body"] and row["deleted_at"] is not None
    assert game.handle(side, {"type": "delete", "id": card["id"]}) == result
    with closing(Store(tmp_path / "postcards.sqlite3")) as store:
        assert store.inbox(side, include_read=True) == []
        assert store.summary(side)["unread"] == 0


def test_library_delete_only_allows_delivered_received_cards_at_home(game):
    write(game, "right", "Incoming")
    deliver(game, "right")
    incoming = game.store.inbox("left")[0]
    game.players["left"].x = WORLD["desks"]["right"]
    with pytest.raises(ValueError, match="your home"):
        game.handle("left", {"type": "delete", "id": incoming["id"]})
    game.players["right"].x = WORLD["desks"]["right"]
    game.handle("right", {"type": "delete", "id": incoming["id"]})
    assert game.store.inbox("left") == [incoming]
    write(game, "right", "Undelivered")
    carried = game.store.db.execute(
        "SELECT id FROM postcards WHERE delivered_at IS NULL"
    ).fetchone()[0]
    game.players["left"].x = WORLD["desks"]["left"]
    game.handle("left", {"type": "delete", "id": carried})
    assert game.store.summary("right")["carrying"]
    assert (
        game.store.db.execute(
            "SELECT deleted_at FROM postcards WHERE id = ?", (carried,)
        ).fetchone()[0]
        is None
    )


def test_delete_last_card_on_page_returns_previous_page(game):
    for index in range(13):
        write(game, "right", f"Card {index}")
        deliver(game, "right")
    game.players["left"].x = WORLD["desks"]["left"]
    last = game.handle("left", {"type": "gallery", "page": 1})["postcards"][0]
    result = game.handle("left", {"type": "delete", "id": last["id"], "page": 1})
    assert result["page"] == 0 and not result["hasMore"]
    assert len(result["postcards"]) == 12
    assert last["id"] not in {card["id"] for card in result["postcards"]}


@pytest.mark.parametrize("postcard_id", [None, True, "1", 0, -1, []])
def test_delete_rejects_invalid_ids(game, postcard_id):
    with pytest.raises(ValueError, match="Invalid postcard"):
        game.handle("left", {"type": "delete", "id": postcard_id})


@pytest.mark.parametrize("side", ["left", "right"])
def test_read_markers_only_affect_delivered_mail_for_the_recipient(game, side):
    other = "right" if side == "left" else "left"
    write(game, other, "Private incoming card.")
    deliver(game, other)
    incoming = game.store.inbox(side)[0]
    game.handle(other, {"type": "read", "id": incoming["id"]})
    assert game.mail[side]["unread"] == 1
    assert game.store.inbox(side) == [incoming]

    write(game, other, "Not delivered yet.")
    carried_id = game.store.db.execute(
        "SELECT id FROM postcards WHERE delivered_at IS NULL"
    ).fetchone()[0]
    game.handle(side, {"type": "read", "id": carried_id})
    assert (
        game.store.db.execute(
            "SELECT read_at FROM postcards WHERE id = ?", (carried_id,)
        ).fetchone()[0]
        is None
    )
    game.handle(side, {"type": "read", "id": incoming["id"]})
    assert game.mail[side]["unread"] == 0
    game.handle(side, {"type": "read", "id": incoming["id"]})
    assert game.mail[side]["unread"] == 0
    deliver(game, other)
    assert [card["body"] for card in game.store.inbox(side)] == ["Not delivered yet."]


@pytest.mark.parametrize("postcard_id", [None, True, "1", 0, -1, []])
def test_invalid_read_marker_is_rejected(game, postcard_id):
    with pytest.raises(ValueError, match="Invalid postcard"):
        game.handle("left", {"type": "read", "id": postcard_id})


@pytest.mark.parametrize("side", ["left", "right"])
def test_mailbox_checks_and_delivery_animate_for_both_players_without_moving_them(
    game, side
):
    events = {peer: [] for peer in ("left", "right")}
    for peer in events:
        game.peers[peer] = SimpleNamespace(send=events[peer].append)
    owner = game.players[side]
    owner.x = WORLD["mailboxes"][side] + 20
    position = (owner.x, owner.y)
    used = {"type": "mailbox_used", "side": side}

    assert game.handle(side, {"type": "interact"}) is None
    assert all(messages == [used] for messages in events.values())
    assert (owner.x, owner.y) == position

    other = "right" if side == "left" else "left"
    write(game, other, "A postcard for you.")
    sender = game.players[other]
    sender.x = WORLD["mailboxes"][side] - 20
    sender_position = (sender.x, sender.y)
    for messages in events.values():
        messages.clear()
    game.handle(other, {"type": "interact"})
    assert all(
        messages == [used, {"type": "delivered", "sender": other, "recipient": side}]
        for messages in events.values()
    )
    assert (sender.x, sender.y) == sender_position

    # With no postcard left to deliver, the other mailbox does nothing for either client.
    for messages in events.values():
        messages.clear()
    assert game.handle(other, {"type": "interact"}) is None
    assert all(not messages for messages in events.values())
    assert (sender.x, sender.y) == sender_position

    for messages in events.values():
        messages.clear()
    card = game.handle(side, {"type": "interact"})["postcards"][0]
    assert card["body"] == "A postcard for you."
    game.handle(side, {"type": "read", "id": card["id"]})
    assert all(messages == [used] for messages in events.values())
    assert (owner.x, owner.y) == position
    assert game.mail[side]["unread"] == 0


def test_movement_is_fixed_rate_bounded_and_stops(game):
    player = game.players["left"]
    start = player.x
    game.handle(
        "left",
        {
            "type": "input",
            "inputs": [
                {"seq": 1, "direction": 1},
                {"seq": 2, "direction": 1},
            ],
        },
    )
    game.step()
    assert player.x == pytest.approx(start + WORLD["speed"] / WORLD["tickRate"])
    assert player.ack == 1
    game.handle("left", {"type": "stop"})
    game.step()
    assert player.ack == 2
    assert not player.moving
    player.x = WORLD["maxX"]
    game.handle("left", {"type": "input", "inputs": [{"seq": 3, "direction": 1}]})
    game.step()
    assert player.x == WORLD["maxX"]


def test_invalid_input_batch_is_atomic(game):
    with pytest.raises(ValueError):
        game.handle(
            "left",
            {
                "type": "input",
                "inputs": [
                    {"seq": 1, "direction": 1},
                    {"seq": 2, "direction": 100},
                ],
            },
        )
    assert not game.players["left"].inputs
    assert game.players["left"].received == 0


@pytest.mark.parametrize("side,direction", [("left", 1), ("right", -1)])
def test_longer_trip_still_delivers_in_15_to_30_seconds(game, side, direction):
    write(game, side)
    other = "right" if side == "left" else "left"
    distance = abs(WORLD["mailboxes"][other] - game.players[side].x)
    ticks = math.ceil(distance / WORLD["speed"] * WORLD["tickRate"])
    assert 15 <= ticks / WORLD["tickRate"] <= 30
    for seq in range(1, ticks + 1):
        game.handle(
            side, {"type": "input", "inputs": [{"seq": seq, "direction": direction}]}
        )
        game.step()
    game.handle(side, {"type": "interact"})
    assert game.mail[other]["unread"] == 1


@pytest.mark.parametrize("side", ["left", "right"])
def test_jump_syncs_prevents_double_jump_and_lands_without_more_inputs(game, side):
    player = game.players[side]
    game.handle(
        side, {"type": "input", "inputs": [{"seq": 1, "direction": 1, "jump": True}]}
    )
    game.step()
    assert player.y < 0 and player.vy < 0
    snapshot = next(p for p in game.snapshot()["players"] if p["side"] == side)
    assert snapshot["y"] == player.y and snapshot["vy"] == player.vy
    for _ in range(12):
        game.step()
    previous_velocity = player.vy
    game.handle(
        side, {"type": "input", "inputs": [{"seq": 2, "direction": 0, "jump": True}]}
    )
    game.step()
    assert player.vy == pytest.approx(
        previous_velocity + WORLD["gravity"] / WORLD["tickRate"]
    )
    assert not game.nearby(side, WORLD["desks"][side])
    game.stop(side)
    for _ in range(WORLD["tickRate"]):
        game.step()
    assert player.y == 0 and player.vy == 0


@pytest.mark.parametrize("side,direction", [("left", 1), ("right", -1)])
def test_held_jump_repeats_after_landing_and_caps_speed_boost(game, side, direction):
    player = game.players[side]
    takeoffs = []
    grounded_ticks = 0
    for seq in range(1, 501):
        previous_y, previous_x = player.y, player.x
        game.handle(
            side,
            {
                "type": "input",
                "inputs": [
                    {
                        "seq": seq,
                        "direction": direction,
                        "jump": True,
                    }
                ],
            },
        )
        game.step()
        if previous_y == 0 and player.y < 0:
            if takeoffs:
                assert grounded_ticks >= WORLD["landingTicks"]
            takeoffs.append(player.jump_chain)
            speed = WORLD["speed"] * (1 + (player.jump_chain - 1) * WORLD["jumpBoost"])
            assert player.x - previous_x == pytest.approx(
                direction * speed / WORLD["tickRate"]
            )
            grounded_ticks = 0
        elif player.y == 0:
            grounded_ticks += 1
            assert player.landing_ticks > 0
    assert takeoffs[: WORLD["maxJumpChain"]] == list(
        range(1, WORLD["maxJumpChain"] + 1)
    )
    assert len(takeoffs) > WORLD["maxJumpChain"]
    assert max(takeoffs) == WORLD["maxJumpChain"]

    # Releasing jump lets the current arc finish, then restores normal walking.
    for seq in range(501, 621):
        game.handle(
            side,
            {
                "type": "input",
                "inputs": [
                    {
                        "seq": seq,
                        "direction": direction,
                        "jump": False,
                    }
                ],
            },
        )
        previous_x = player.x
        game.step()
    assert player.y == 0 and player.jump_chain == 0 and player.landing_ticks == 0
    assert player.x - previous_x == pytest.approx(
        direction * WORLD["speed"] / WORLD["tickRate"]
    )


def receive_type(socket, kind):
    for _ in range(120):
        message = socket.receive_json()
        if message["type"] == kind:
            return message
    raise AssertionError(f"No {kind} message received")


def test_two_players_share_state_and_reconnect(tmp_path):
    app = create_app(tmp_path / "cards.sqlite3")
    with TestClient(app) as client:
        with client.websocket_connect("/ws/left?token=left-player-token") as left:
            assert receive_type(left, "welcome")["side"] == "left"
            with client.websocket_connect(
                "/ws/right?token=right-player-token"
            ) as right:
                assert receive_type(right, "welcome")["side"] == "right"
                left.send_json(
                    {"type": "input", "inputs": [{"seq": 1, "direction": 1}]}
                )
                for _ in range(120):
                    state = receive_type(right, "state")
                    player = state["players"][0]
                    if player["ack"] == 1:
                        break
                assert player["x"] > WORLD["desks"]["left"]
                assert all(p["connected"] for p in state["players"])
                with client.websocket_connect(
                    "/ws/left?token=different-player-token"
                ) as third:
                    assert receive_type(third, "occupied")["type"] == "occupied"
                left.send_json({"type": "write", "body": "Saved in my backpack"})
                assert receive_type(left, "written")["type"] == "written"
                with client.websocket_connect(
                    "/ws/left?token=left-player-token"
                ) as resumed:
                    welcome = receive_type(resumed, "welcome")
                    assert welcome["players"][0]["carrying"]
                    assert welcome["players"][0]["x"] == pytest.approx(player["x"])


def test_websocket_rejects_other_origins(tmp_path):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with client.websocket_connect(
            "/ws/left?token=left-player-token",
            headers={"origin": "https://elsewhere.example"},
        ) as socket:
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()


def test_failed_socket_writer_releases_its_home(tmp_path, monkeypatch):
    async def failed_writer(peer):
        await peer.socket.send_json(await peer.outbox.get())
        raise asyncio.TimeoutError

    monkeypatch.setattr(Peer, "write", failed_writer)
    app = create_app(tmp_path / "cards.sqlite3")
    with TestClient(app) as client:
        with client.websocket_connect("/ws/left?token=left-player-token") as socket:
            assert socket.receive_json()["type"] == "welcome"
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
        assert "left" not in app.state.game.peers


def test_disconnect_during_close_releases_home_and_allows_reconnect(
    tmp_path, monkeypatch
):
    close_attempts = []

    async def disconnected_close(socket, *args, **kwargs):
        close_attempts.append(socket)
        raise WebSocketDisconnect(code=1006)

    monkeypatch.setattr(WebSocket, "close", disconnected_close)
    app = create_app(tmp_path / "cards.sqlite3")
    with TestClient(app) as client:
        for token in ("left-player-token", "next-player-token"):
            with client.websocket_connect(f"/ws/left?token={token}") as socket:
                assert receive_type(socket, "welcome")["side"] == "left"
            assert "left" not in app.state.game.peers
    assert len(close_attempts) == 2


def test_game_entry_page_revalidates_and_serves_rebuilt_client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    index = dist / "index.html"
    index.write_text('<script src="/assets/old-client.js"></script>')
    monkeypatch.setattr("server.app.ROOT", tmp_path)
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        health = client.get("/healthz")
        assert health.status_code == 200
        assert health.json() == {"status": "ok"}
        response = client.get("/")
        assert response.headers["cache-control"] == "no-cache"
        index.write_text('<script src="/assets/rebuilt-client.js"></script>')
        response = client.get("/", headers={"If-None-Match": response.headers["etag"]})
        assert response.status_code == 200
        assert "rebuilt-client.js" in response.text
