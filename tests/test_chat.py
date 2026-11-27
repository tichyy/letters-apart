from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from fontTools.ttLib import TTFont

from conftest import join, receive_type
from server.app import create_app
from server.chat import CHAT, Chat, clean, lifetime
from server.game import CHAT_BURST, Game, Peer
from server.store import Store

ROOT = Path(__file__).resolve().parent.parent
LINE_ID = "a" * 32


@pytest.fixture
def game(tmp_path):
    store = Store(tmp_path / "chat.sqlite3")
    game = Game(store)
    game.chat.clock = lambda: 50.0
    game.sent = {"left": [], "right": []}
    for side in ("left", "right"):
        game.peers[side] = SimpleNamespace(send=game.sent[side].append)
    yield game
    store.close()




def test_chat_characters_are_exactly_what_the_font_draws():
    # Other spaces (no-break, ideographic) are typed as a plain space instead.
    drawn = {chr(c) for c in TTFont(ROOT / "assets/font.ttf").getBestCmap()}
    assert set(CHAT["characters"]) == drawn - {" ", "　"}


def test_clean_keeps_czech_drops_undrawable_and_flattens_whitespace():
    assert clean("Ahoj, jak se máš? Čau 👋\tŽluťoučký\n") == "Ahoj, jak se máš? Čau  Žluťoučký "
    # Combining accents (as some keyboards type them) become the precomposed letter.
    assert clean("č") == "č"
    assert clean("x" * 150) == "x" * CHAT["maxLength"]


def test_lifetime_grows_with_length_up_to_ten_seconds():
    assert lifetime("") == 4
    assert lifetime("x" * 50) == pytest.approx(7)
    assert lifetime("x" * 100) == 10


def test_line_reaches_both_players_and_replaces_the_speakers_draft(game):
    game.handle("left", {"type": "draft", "text": "Ahoj"})
    assert game.sent["right"] == [{"type": "draft", "side": "left", "text": "Ahoj"}]
    assert game.sent["left"] == []
    game.handle("left", {"type": "say", "requestId": LINE_ID, "text": "  Ahoj!  "})
    said = {"type": "said", "line": {"side": "left", "id": LINE_ID, "text": "Ahoj!", "remaining": 4300}}
    assert game.sent["left"] == [said]
    assert game.sent["right"][-1] == said
    assert game.chat.drafts["left"] == ""


def test_unchanged_draft_is_not_forwarded_again(game):
    game.handle("left", {"type": "draft", "text": "Ahoj"})
    game.handle("left", {"type": "draft", "text": "Ahoj🙂"})
    assert len(game.sent["right"]) == 1


@pytest.mark.parametrize(
    "message",
    [
        {"type": "say", "requestId": LINE_ID, "text": "   "},
        {"type": "say", "requestId": LINE_ID, "text": "🙂"},
        {"type": "say", "requestId": LINE_ID, "text": 5},
        {"type": "say", "requestId": LINE_ID, "text": "x" * 401},
        {"type": "say", "requestId": "short", "text": "Hi"},
        {"type": "say", "text": "Hi"},
        {"type": "draft", "text": None},
    ],
)
def test_invalid_chat_is_rejected_and_not_shown(game, message):
    response = game.respond("left", message)
    assert response["type"] == "error"
    assert game.sent["right"] == []
    assert game.chat.sync()["lines"] == []


def test_lines_expire_and_only_the_last_three_per_speaker_are_kept():
    now = [0.0]
    chat = Chat(("left", "right"), clock=lambda: now[0])
    for index in range(4):
        chat.say("left", str(index), "hi")
    chat.say("right", "r", "x" * 100)
    assert [line["id"] for line in chat.sync()["lines"]] == ["1", "2", "3", "r"]
    now[0] = 4.12
    assert [line["id"] for line in chat.sync()["lines"]] == ["r"]
    assert chat.sync()["lines"][0]["remaining"] == 5880
    now[0] = 10
    assert chat.sync()["lines"] == []


def test_chat_lines_have_their_own_budget_of_ten_in_five_seconds(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("server.game.time.monotonic", lambda: now[0])
    peer = Peer(None, "chat-budget-token")
    assert all(peer.allow("say") for _ in range(CHAT_BURST))
    # Spamming on keeps being refused, and doesn't touch the other budgets.
    assert not any(peer.allow("say") for _ in range(50))
    assert peer.allow("read") and peer.allow("draft")
    now[0] += 5
    assert sum(peer.allow("say") for _ in range(50)) == 10


def test_reconnect_shows_lines_still_up_and_drops_the_old_draft(tmp_path):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with join(client, "/ws/right", "right-player-token") as right:
            assert receive_type(right, "chat") == {
                "type": "chat", "lines": [], "drafts": {"left": "", "right": ""},
            }
            with join(client, "/ws/left", "left-player-token") as left:
                receive_type(left, "chat")
                left.send_json({"type": "say", "requestId": LINE_ID, "text": "Jsem tady"})
                assert receive_type(right, "said")["line"]["text"] == "Jsem tady"
                left.send_json({"type": "draft", "text": "Ještě něc"})
                assert receive_type(right, "draft") == {"type": "draft", "side": "left", "text": "Ještě něc"}
            # Leaving takes the draft away, but the line stays until it expires.
            assert receive_type(right, "draft") == {"type": "draft", "side": "left", "text": ""}
            with join(client, "/ws/left", "left-player-token") as left:
                sync = receive_type(left, "chat")
                assert [line["text"] for line in sync["lines"]] == ["Jsem tady"]
                assert 0 < sync["lines"][0]["remaining"] <= 4540
                assert sync["drafts"] == {"left": "", "right": ""}


def test_flooding_chat_lines_is_answered_with_errors_for_those_lines(tmp_path):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with join(client, "/ws/left", "left-player-token") as socket:
            receive_type(socket, "chat")
            for index in range(CHAT_BURST + 3):
                socket.send_json({"type": "say", "requestId": f"{index:032x}", "text": "spam"})
            said = errors = 0
            while said + errors < CHAT_BURST + 3:
                message = socket.receive_json()
                said += message["type"] == "said"
                if message["type"] == "error":
                    assert message["message"] == "Slow down a little."
                    assert message["requestId"] == f"{CHAT_BURST + errors:032x}"
                    errors += 1
            assert (said, errors) == (CHAT_BURST, 3)


@pytest.mark.parametrize("kind", [["say"], {"type": "say"}, None, 5])
def test_malformed_message_types_get_an_error_not_a_dropped_connection(tmp_path, kind):
    with TestClient(create_app(tmp_path / "cards.sqlite3")) as client:
        with join(client, "/ws/left", "left-player-token") as socket:
            receive_type(socket, "chat")
            socket.send_json({"type": kind})
            assert receive_type(socket, "error")["message"] == "Unknown action."
            # Still connected: a chat line goes through.
            socket.send_json({"type": "say", "requestId": LINE_ID, "text": "still here"})
            assert receive_type(socket, "said")["line"]["text"] == "still here"
