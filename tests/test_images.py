import asyncio
import io
import json
import time
from contextlib import closing

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pillow_heif import from_pillow

from server.app import create_app
from server.game import WORLD, Game
from server.image_routes import ImageService
from server.images import MAX_UPLOAD, LocalImageStorage, normalize
from server.store import Store, session_owner
from tests.test_game import receive_type


class MemoryImages:
    """A non-filesystem backend exercises the complete storage boundary."""

    def __init__(self):
        self.data = {}
        self.fail_delete = set()
        self.orphan_checks = []

    def save(self, image_id, data):
        self.data[image_id] = data

    def read(self, image_id):
        if image_id not in self.data:
            raise FileNotFoundError(image_id)
        return self.data[image_id]

    def delete(self, image_id):
        if image_id in self.fail_delete:
            raise OSError("Storage temporarily unavailable")
        self.data.pop(image_id, None)

    def cleanup_orphans(self, known_ids, older_than):
        self.orphan_checks.append((known_ids, older_than))


TOKEN = "left-photo-player-token"
RIGHT_TOKEN = "right-photo-player-token"
PHOTO_ID = "a" * 32
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "X-Player-Side": "left",
    "X-Upload-ID": PHOTO_ID,
}
RIGHT_HEADERS = {"Authorization": f"Bearer {RIGHT_TOKEN}", "X-Player-Side": "right"}


def photo_bytes(format="PNG", size=(240, 160)):
    image = Image.new("RGB", size, "#c85f42")
    output = io.BytesIO()
    image.save(output, format=format)
    return output.getvalue()


@pytest.fixture
def session(tmp_path):
    app = create_app(tmp_path / "cards.sqlite3")
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/left?token={TOKEN}") as left:
            receive_type(left, "welcome")
            with client.websocket_connect(f"/ws/right?token={RIGHT_TOKEN}") as right:
                receive_type(right, "welcome")
                yield app, client, left, right


def test_photo_crop_delivery_read_and_restart(session, tmp_path):
    app, client, left, right = session
    uploaded = client.post("/api/images", headers=HEADERS, content=photo_bytes())
    assert uploaded.status_code == 200
    assert uploaded.json()["id"] == PHOTO_ID
    assert (
        client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).headers["content-type"]
        == "image/jpeg"
    )
    assert (
        client.get(f"/api/images/{PHOTO_ID}", headers=RIGHT_HEADERS).status_code == 404
    )
    original = client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).content
    assert (
        client.post(
            "/api/images",
            headers={**RIGHT_HEADERS, "X-Upload-ID": PHOTO_ID},
            content=photo_bytes(),
        ).status_code
        == 409
    )
    assert client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).content == original
    crop = {"x": 0.2, "y": 0.7, "zoom": 2.5}
    message = {
        "type": "write",
        "requestId": "b" * 32,
        "body": "A photo from home",
        "stamp": 2,
        "imageId": PHOTO_ID,
        "crop": crop,
    }
    left.send_json(message)
    assert receive_type(left, "written")["requestId"] == message["requestId"]
    assert (
        client.get(f"/api/images/{PHOTO_ID}", headers=RIGHT_HEADERS).status_code == 404
    )
    assert PHOTO_ID not in json.dumps(app.state.game.snapshot())
    # Attached photos cannot be removed by a stale draft's reset request.
    assert client.delete(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code == 204
    assert client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code == 200
    # Replaying a request after acknowledgement loss must succeed even away from the desk.
    app.state.game.players["left"].x = WORLD["mailboxes"]["right"]
    left.send_json(message)
    receive_type(left, "written")
    left.send_json({"type": "interact"})
    receive_type(left, "delivered")
    app.state.game.players["right"].x = WORLD["mailboxes"]["right"]
    right.send_json({"type": "interact"})
    card = receive_type(right, "mailbox")["postcards"][0]
    assert card["image"]["crop"] == crop
    right.send_json({"type": "read", "id": card["id"]})
    result = client.get(f"/api/images/{PHOTO_ID}", headers=RIGHT_HEADERS)
    assert result.status_code == 200
    assert result.headers["cache-control"] == "private, no-store"
    assert result.headers["x-content-type-options"] == "nosniff"

    # Reopen the journal independently to check the committed attachment and retry record.
    with closing(Store(tmp_path / "cards.sqlite3")) as store:
        restarted = Game(store)
        assert (
            restarted.handle("left", message, TOKEN)["requestId"]
            == message["requestId"]
        )
        assert store.db.execute("SELECT COUNT(*) FROM postcards").fetchone()[0] == 1
        assert store.image_for(PHOTO_ID, "right", session_owner("right", RIGHT_TOKEN))
    assert (
        LocalImageStorage(tmp_path / "postcard-images").read(PHOTO_ID) == result.content
    )


def test_upload_authorization_validation_and_cleanup(session):
    app, client, left, _ = session
    assert client.post("/api/images", content=photo_bytes()).status_code == 401
    assert (
        client.post(
            "/api/images",
            headers={**HEADERS, "Origin": "https://elsewhere.test"},
            content=photo_bytes(),
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/images", headers=HEADERS, content=b"<svg>not a photo</svg>"
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/images",
            headers={**HEADERS, "content-length": str(MAX_UPLOAD + 1)},
            content=b"small",
        ).status_code
        == 413
    )
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).status_code
        == 200
    )
    # The upload ID makes an HTTP retry reuse the existing pending image.
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).json()["id"]
        == PHOTO_ID
    )
    assert (
        client.get(
            f"/api/images/{PHOTO_ID}",
            headers={**HEADERS, "Authorization": "Bearer another-token"},
        ).status_code
        == 401
    )
    assert (
        client.delete(f"/api/images/{PHOTO_ID}", headers=RIGHT_HEADERS).status_code
        == 204
    )
    assert client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code == 200
    assert client.delete(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code == 204
    assert client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code == 404
    assert not app.state.images.storage.path(PHOTO_ID).exists()
    app.state.game.players["left"].x = WORLD["desks"]["right"]
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).status_code
        == 409
    )


@pytest.mark.parametrize(
    "crop",
    [
        None,
        [],
        {"x": True, "y": 0, "zoom": 1},
        {"x": -1, "y": 0, "zoom": 1},
        {"x": 0, "y": 0, "zoom": 0.9},
        {"x": 0, "y": 0, "zoom": 6},
        {"x": float("nan"), "y": 0, "zoom": 1},
        {"x": 10**400, "y": 0, "zoom": 1},
    ],
)
def test_invalid_crop_never_saves(tmp_path, crop):
    with closing(Store(tmp_path / "cards.sqlite3")) as store:
        with pytest.raises(ValueError, match="position or zoom"):
            Game(store).handle(
                "left", {"type": "write", "body": "Hello", "crop": crop}, TOKEN
            )
        assert store.db.execute("SELECT COUNT(*) FROM postcards").fetchone()[0] == 0


def test_attachment_ownership_expiry_and_atomic_write(tmp_path):
    with closing(Store(tmp_path / "cards.sqlite3")) as store:
        owner = session_owner("left", TOKEN)
        store.add_image(PHOTO_ID, "left", owner, 100, 100, 1000)
        game = Game(store)
        message = {
            "type": "write",
            "body": "Hello",
            "imageId": PHOTO_ID,
            "requestId": "c" * 32,
        }
        with pytest.raises(ValueError, match="no longer available"):
            game.handle("left", message, "another-session-token")
        assert not store.summary("left")["carrying"]
        assert store.image_for(PHOTO_ID, "left", owner)
        with store.db:
            store.db.execute(
                "UPDATE images SET expires_at = ?", (int(time.time()) - 1,)
            )
        with pytest.raises(ValueError, match="no longer available"):
            game.handle("left", message, TOKEN)
        assert store.expired_images() == [PHOTO_ID]
        store.forget_image(PHOTO_ID)
        store.add_image(PHOTO_ID, "left", owner, 100, 100, 1000)
        assert game.handle("left", message, TOKEN)["type"] == "written"
        with pytest.raises(ValueError, match="already used"):
            game.handle("left", {**message, "body": "Different content"}, TOKEN)
        assert store.expired_images() == []


def test_normalize_orientation_metadata_transparency_and_heic():
    source = Image.new("RGB", (80, 120), "orange")
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "Private camera information"
    output = io.BytesIO()
    source.save(output, format="JPEG", exif=exif)
    data, width, height = normalize(output.getvalue())
    assert (width, height) == (120, 80)
    with Image.open(io.BytesIO(data)) as normalized:
        assert not normalized.getexif()
        assert "icc_profile" not in normalized.info
    transparent = io.BytesIO()
    Image.new("RGBA", (10, 10), (255, 0, 0, 0)).save(transparent, format="PNG")
    with Image.open(io.BytesIO(normalize(transparent.getvalue())[0])) as flattened:
        assert all(
            abs(a - b) < 4 for a, b in zip(flattened.getpixel((0, 0)), (248, 236, 212))
        )
    heic = io.BytesIO()
    from_pillow(source).save(heic, quality=80)
    assert normalize(heic.getvalue())[1:] == source.size


def test_large_and_animated_images():
    assert normalize(photo_bytes(size=(2000, 1000)))[1:] == (1600, 800)
    animation = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(
        animation,
        format="PNG",
        save_all=True,
        append_images=[Image.new("RGB", (10, 10), "blue")],
    )
    with pytest.raises(ValueError, match="still photo"):
        normalize(animation.getvalue())
    with pytest.raises(ValueError, match="valid JPEG"):
        normalize(photo_bytes()[:40])


def test_stream_limit_capacity_and_storage_failure(session, monkeypatch):
    app, client, _, _ = session
    monkeypatch.setattr("server.image_routes.MAX_UPLOAD", 100)
    response = client.post(
        "/api/images", headers=HEADERS, content=iter([b"x" * 60, b"y" * 60])
    )
    assert response.status_code == 413
    monkeypatch.setattr("server.image_routes.MAX_UPLOAD", MAX_UPLOAD)
    storage = app.state.images.storage
    original_save = storage.save

    def fail(*args):
        raise OSError("Storage disconnected")

    monkeypatch.setattr(storage, "save", fail)
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).status_code
        == 503
    )
    assert not app.state.images.busy
    monkeypatch.setattr(storage, "save", original_save)
    for image_id in ("1" * 32, "2" * 32):
        assert (
            client.post(
                "/api/images",
                headers={**HEADERS, "X-Upload-ID": image_id},
                content=photo_bytes(),
            ).status_code
            == 200
        )
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).status_code
        == 409
    )
    client.delete(f"/api/images/{'1' * 32}", headers=HEADERS)
    assert (
        client.post("/api/images", headers=HEADERS, content=photo_bytes()).status_code
        == 200
    )


def test_pending_expiry_orphan_cleanup_and_restart(tmp_path):
    path = tmp_path / "cards.sqlite3"
    app = create_app(path)
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/left?token={TOKEN}") as left:
            receive_type(left, "welcome")
            assert (
                client.post(
                    "/api/images", headers=HEADERS, content=photo_bytes()
                ).status_code
                == 200
            )
            left.send_json(
                {"type": "write", "body": "Still in my backpack", "imageId": PHOTO_ID}
            )
            receive_type(left, "written")
    # A fresh app lifespan retains the image and sender access, even under a new tab token.
    with TestClient(create_app(path)) as client:
        new_token = "a-new-left-session-token"
        with client.websocket_connect(f"/ws/left?token={new_token}") as left:
            welcome = receive_type(left, "welcome")
            assert welcome["players"][0]["carrying"]
            response = client.get(
                f"/api/images/{PHOTO_ID}",
                headers={**HEADERS, "Authorization": f"Bearer {new_token}"},
            )
            assert response.status_code == 200
    with closing(Store(path)) as store:
        pending_id = "d" * 32
        store.add_image(pending_id, "left", session_owner("left", TOKEN), 10, 10, 200)
        LocalImageStorage(tmp_path / "postcard-images").save(pending_id, photo_bytes())
        with store.db:
            store.db.execute(
                "UPDATE images SET expires_at = ? WHERE id = ?",
                (int(time.time()) - 1, pending_id),
            )
    with TestClient(create_app(path)):
        assert not (tmp_path / "postcard-images" / f"{pending_id}.jpg").exists()
        assert (tmp_path / "postcard-images" / f"{PHOTO_ID}.jpg").exists()


def test_failed_cleanup_retains_quota_and_retries_without_blocking_other_files(
    tmp_path, caplog
):
    async def check():
        with closing(Store(tmp_path / "cards.sqlite3")) as store:
            storage = MemoryImages()
            service = ImageService(Game(store), storage, 1024 * 1024)
            owner = session_owner("left", TOKEN)
            other_id = "e" * 32
            for image_id, size in ((PHOTO_ID, 1024 * 1024), (other_id, 100)):
                storage.save(image_id, b"photo")
                store.add_image(image_id, "left", owner, 10, 10, size)
            with store.db:
                store.db.execute("UPDATE images SET expires_at = 0")
            storage.fail_delete.add(PHOTO_ID)
            await service.cleanup()
            assert store.image_ids() == {PHOTO_ID}
            assert PHOTO_ID in storage.data and other_id not in storage.data
            assert not store.image_capacity("left", service.byte_limit)
            assert storage.orphan_checks[-1][0] == {PHOTO_ID}
            assert "will retry" in caplog.text
            storage.fail_delete.clear()
            await service.cleanup()
            assert not store.image_ids() and not storage.data
            assert store.image_capacity("left", service.byte_limit)

    asyncio.run(check())


def test_injected_storage_and_failed_discard_are_recoverable(tmp_path):
    storage = MemoryImages()
    app = create_app(tmp_path / "cards.sqlite3", image_storage=storage)
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/left?token={TOKEN}") as left:
            receive_type(left, "welcome")
            assert (
                client.post(
                    "/api/images", headers=HEADERS, content=photo_bytes()
                ).status_code
                == 200
            )
            assert (
                client.get(f"/api/images/{PHOTO_ID}", headers=HEADERS).content
                == storage.data[PHOTO_ID]
            )
            storage.fail_delete.add(PHOTO_ID)
            assert (
                client.delete(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code
                == 503
            )
            assert client.portal.call(app.state.game.store.image_exists, PHOTO_ID)
            assert PHOTO_ID in storage.data
            # A retired image cannot be packed while its physical deletion is pending.
            left.send_json({"type": "write", "body": "Hello", "imageId": PHOTO_ID})
            assert "no longer available" in receive_type(left, "error")["message"]
            storage.fail_delete.clear()
            client.portal.call(app.state.images.cleanup)
            assert not client.portal.call(app.state.game.store.image_exists, PHOTO_ID)
            assert PHOTO_ID not in storage.data
            assert (
                client.delete(f"/api/images/{PHOTO_ID}", headers=HEADERS).status_code
                == 204
            )


def test_local_orphan_cleanup_retains_known_recent_and_unrelated_files(tmp_path):
    import os

    storage = LocalImageStorage(tmp_path / "photos")
    known_id, orphan_id, recent_id = "1" * 32, "2" * 32, "3" * 32
    for image_id in (known_id, orphan_id, recent_id):
        storage.save(image_id, b"photo")
    old = time.time() - 90000
    for image_id in (known_id, orphan_id):
        os.utime(storage.path(image_id), (old, old))
    unrelated = storage.directory / "keep.txt"
    unrelated.write_text("Not a photo")
    storage.cleanup_orphans({known_id}, time.time() - 86400)
    assert storage.path(known_id).exists()
    assert not storage.path(orphan_id).exists()
    assert storage.path(recent_id).exists()
    assert unrelated.exists()
