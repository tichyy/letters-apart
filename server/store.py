"""The postcard journal. Live movement never touches the database."""

import hashlib
import sqlite3
import time
from pathlib import Path

# The card a player has written but not yet delivered or dropped.
CARRIED = "sender = ? AND delivered_at IS NULL AND deleted_at IS NULL"


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        # Commits run on the game loop's thread. WAL makes each one a single append,
        # and NORMAL skips its fsync: a power loss may drop the newest commits but
        # can't corrupt the database, and an app crash loses nothing.
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute("PRAGMA foreign_keys = ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        # Add later schema changes as `if version < 2:` blocks, each ending by
        # raising user_version, so every database migrates exactly once in order.
        if version < 1:
            self._migrate_to_v1()
            self.db.execute("PRAGMA user_version = 1")
        if version < 2:
            # A dropped card keeps its row as the write's retry record, so it must
            # no longer count as the one card a player carries.
            self.db.execute("DROP INDEX one_carried_postcard")
            self.db.execute("""CREATE UNIQUE INDEX one_carried_postcard ON postcards(sender)
                               WHERE delivered_at IS NULL AND deleted_at IS NULL""")
            self.db.execute("PRAGMA user_version = 2")
        self.db.commit()

    def _migrate_to_v1(self) -> None:
        """Bring any pre-versioning database (including an empty one) to schema 1."""
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS postcards (
                id INTEGER PRIMARY KEY,
                sender TEXT NOT NULL CHECK (sender IN ('left', 'right')),
                body TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                delivered_at TEXT,
                read_at TEXT
            )
        """)
        self.db.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS one_carried_postcard
            ON postcards(sender) WHERE delivered_at IS NULL
        """)
        if "stamp" not in {
            row["name"] for row in self.db.execute("PRAGMA table_info(postcards)")
        }:
            self.db.execute(
                "ALTER TABLE postcards ADD COLUMN stamp INTEGER NOT NULL DEFAULT 1 CHECK (stamp BETWEEN 1 AND 3)"
            )
        if "title" not in {
            row["name"] for row in self.db.execute("PRAGMA table_info(postcards)")
        }:
            self.db.execute(
                "ALTER TABLE postcards ADD COLUMN title TEXT NOT NULL DEFAULT ''"
            )
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY,
                sender TEXT NOT NULL,
                owner TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                size INTEGER NOT NULL,
                expires_at INTEGER
            )
        """)
        columns = {
            row["name"] for row in self.db.execute("PRAGMA table_info(postcards)")
        }
        for name, definition in {
            "deleted_at": "TEXT",
            "image_id": "TEXT REFERENCES images(id)",
            "photo_x": "REAL NOT NULL DEFAULT 0.5",
            "photo_y": "REAL NOT NULL DEFAULT 0.5",
            "photo_zoom": "REAL NOT NULL DEFAULT 1",
            "request_id": "TEXT",
            "request_owner": "TEXT",
            "payload_hash": "TEXT",
        }.items():
            if name not in columns:
                self.db.execute(f"ALTER TABLE postcards ADD COLUMN {name} {definition}")
        self.db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS one_image_per_card ON postcards(image_id)"
        )
        self.db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS postcard_requests
                           ON postcards(request_owner, request_id)""")

    def summary(self, side: str) -> dict:
        carrying = self.db.execute(
            f"SELECT 1 FROM postcards WHERE {CARRIED}",
            (side,),
        ).fetchone()
        unread = self.db.execute(
            """SELECT COUNT(*) FROM postcards
               WHERE sender != ? AND delivered_at IS NOT NULL AND read_at IS NULL AND deleted_at IS NULL""",
            (side,),
        ).fetchone()[0]
        return {"carrying": bool(carrying), "unread": unread}

    def completed_write(self, owner: str, request_id: str, payload_hash: str) -> bool:
        row = self.db.execute(
            "SELECT payload_hash FROM postcards WHERE request_owner = ? AND request_id = ?",
            (owner, request_id),
        ).fetchone()
        if row and row["payload_hash"] != payload_hash:
            raise ValueError(
                "This postcard request was already used. Reopen your draft."
            )
        return row is not None

    def write(
        self,
        side: str,
        body: str,
        stamp: int = 1,
        title: str = "",
        *,
        image_id: str | None = None,
        crop: tuple = (0.5, 0.5, 1),
        owner: str | None = None,
        request_id: str | None = None,
        payload_hash: str | None = None,
    ) -> None:
        with self.db:
            if image_id:
                image = self.db.execute(
                    """SELECT 1 FROM images WHERE id = ? AND sender = ? AND owner = ?
                       AND expires_at > ?""",
                    (image_id, side, owner, int(time.time())),
                ).fetchone()
                if not image:
                    raise ValueError(
                        "That photo is no longer available. Please choose it again."
                    )
            self.db.execute(
                """INSERT INTO postcards(sender, body, stamp, title, image_id,
                   photo_x, photo_y, photo_zoom, request_owner, request_id, payload_hash)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    side,
                    body,
                    stamp,
                    title,
                    image_id,
                    *crop,
                    owner,
                    request_id,
                    payload_hash,
                ),
            )
            if image_id:
                self.db.execute(
                    "UPDATE images SET expires_at = NULL WHERE id = ?", (image_id,)
                )

    def deliver(self, side: str) -> None:
        with self.db:
            self.db.execute(
                f"UPDATE postcards SET delivered_at = CURRENT_TIMESTAMP WHERE {CARRIED}",
                (side,),
            )

    def drop(self, side: str) -> None:
        """Discard the carried postcard and let photo cleanup remove its image.

        The row stays, marked deleted, so a replay of its write is still recognized
        as completed instead of writing the card again."""
        with self.db:
            self.db.execute(
                f"""UPDATE images SET expires_at = 0 WHERE id = (
                   SELECT image_id FROM postcards WHERE {CARRIED})""",
                (side,),
            )
            self.db.execute(
                f"""UPDATE postcards SET deleted_at = CURRENT_TIMESTAMP, image_id = NULL
                   WHERE {CARRIED}""",
                (side,),
            )

    def inbox(
        self, side: str, *, include_read: bool = False, limit: int = -1, offset: int = 0
    ) -> list[dict]:
        rows = self.db.execute(
            f"""SELECT p.id, title, body, delivered_at AS date, stamp,
                      image_id, i.width, i.height, photo_x, photo_y, photo_zoom
               FROM postcards p LEFT JOIN images i ON p.image_id = i.id
               WHERE p.sender != ? AND delivered_at IS NOT NULL AND deleted_at IS NULL
               {"" if include_read else "AND read_at IS NULL"}
               ORDER BY p.id {"DESC" if include_read else "ASC"} LIMIT ? OFFSET ?""",
            (side, limit, offset),
        ).fetchall()
        cards = []
        for row in rows:
            card = {key: row[key] for key in ("id", "title", "body", "date", "stamp")}
            card["image"] = (
                None
                if not row["image_id"]
                else {
                    "id": row["image_id"],
                    "width": row["width"],
                    "height": row["height"],
                    "crop": {
                        "x": row["photo_x"],
                        "y": row["photo_y"],
                        "zoom": row["photo_zoom"],
                    },
                }
            )
            cards.append(card)
        return cards

    def add_image(
        self, image_id: str, side: str, owner: str, width: int, height: int, size: int
    ) -> dict:
        expires = int(time.time()) + 86400
        with self.db:
            self.db.execute(
                "INSERT INTO images VALUES (?, ?, ?, ?, ?, ?, ?)",
                (image_id, side, owner, width, height, size, expires),
            )
        return {"id": image_id, "width": width, "height": height, "expiresAt": expires}

    def image_for(self, image_id: str, side: str, owner: str) -> dict | None:
        row = self.db.execute(
            """SELECT i.*, p.id AS postcard_id, p.delivered_at, p.deleted_at
               FROM images i LEFT JOIN postcards p ON p.image_id = i.id WHERE i.id = ?""",
            (image_id,),
        ).fetchone()
        if row:
            pending = row["postcard_id"] is None
            if (
                pending
                and row["owner"] == owner
                and row["sender"] == side
                and row["expires_at"] > time.time()
            ) or (
                not pending
                and (
                    row["sender"] == side
                    or (row["delivered_at"] is not None and row["deleted_at"] is None)
                )
            ):
                return dict(row)
        return None

    def image_exists(self, image_id: str) -> bool:
        return (
            self.db.execute("SELECT 1 FROM images WHERE id = ?", (image_id,)).fetchone()
            is not None
        )

    def retire_image(self, image_id: str, side: str, owner: str) -> bool:
        """Prevent attachment immediately; keep the quota charged until storage deletion succeeds."""
        with self.db:
            return (
                self.db.execute(
                    "UPDATE images SET expires_at = 0 WHERE id = ? AND sender = ? AND owner = ? AND expires_at IS NOT NULL",
                    (image_id, side, owner),
                ).rowcount
                > 0
            )

    def expired_images(self) -> list[str]:
        return [
            row[0]
            for row in self.db.execute(
                "SELECT id FROM images WHERE expires_at <= ? LIMIT 100",
                (int(time.time()),),
            )
        ]

    def forget_image(self, image_id: str) -> None:
        with self.db:
            self.db.execute(
                "DELETE FROM images WHERE id = ? AND expires_at <= ?",
                (image_id, int(time.time())),
            )

    def image_ids(self) -> set[str]:
        return {row[0] for row in self.db.execute("SELECT id FROM images")}

    def image_capacity(self, side: str, byte_limit: int) -> bool:
        pending = self.db.execute(
            "SELECT COUNT(*) FROM images WHERE sender = ? AND expires_at IS NOT NULL",
            (side,),
        ).fetchone()[0]
        size = self.db.execute("SELECT COALESCE(SUM(size), 0) FROM images").fetchone()[
            0
        ]
        return pending < 2 and size + 1024 * 1024 <= byte_limit

    def mark_read(self, side: str, postcard_id: int) -> None:
        with self.db:
            self.db.execute(
                """UPDATE postcards SET read_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND sender != ? AND delivered_at IS NOT NULL AND read_at IS NULL AND deleted_at IS NULL""",
                (postcard_id, side),
            )

    def delete(self, side: str, postcard_id: int) -> None:
        with self.db:
            self.db.execute(
                """UPDATE postcards SET deleted_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND sender != ? AND delivered_at IS NOT NULL AND deleted_at IS NULL""",
                (postcard_id, side),
            )

    def close(self) -> None:
        self.db.close()


def session_owner(side: str, token: str) -> str:
    return hashlib.sha256(f"{side}:{token}".encode()).hexdigest()
