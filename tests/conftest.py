from contextlib import contextmanager


@contextmanager
def join(client, url, token, **kwargs):
    """Open a game WebSocket and introduce this tab with its token, like the client."""
    with client.websocket_connect(url, **kwargs) as socket:
        socket.send_json({"type": "hello", "token": token})
        yield socket
