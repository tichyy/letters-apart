from contextlib import contextmanager


@contextmanager
def join(client, url, token, **kwargs):
    """Open a game WebSocket and introduce this tab with its token, like the client."""
    with client.websocket_connect(url, **kwargs) as socket:
        socket.send_json({"type": "hello", "token": token})
        yield socket


def receive_type(socket, kind):
    """The next message of this kind, skipping others (game state arrives every tick)."""
    for _ in range(240):
        message = socket.receive_json()
        if message["type"] == kind:
            return message
    raise AssertionError(f"No {kind} message received")
