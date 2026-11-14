"""The postcard journal. Live movement never touches the database."""

import sqlite3
from pathlib import Path


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
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
        if "stamp" not in {row["name"] for row in self.db.execute("PRAGMA table_info(postcards)")}:
            self.db.execute(
                "ALTER TABLE postcards ADD COLUMN stamp INTEGER NOT NULL DEFAULT 1 CHECK (stamp BETWEEN 1 AND 3)"
            )
        if "title" not in {row["name"] for row in self.db.execute("PRAGMA table_info(postcards)")}:
            self.db.execute("ALTER TABLE postcards ADD COLUMN title TEXT NOT NULL DEFAULT ''")
        self.db.commit()

    def summary(self, side: str) -> dict:
        carrying = self.db.execute(
            "SELECT 1 FROM postcards WHERE sender = ? AND delivered_at IS NULL",
            (side,),
        ).fetchone()
        unread = self.db.execute(
            """SELECT COUNT(*) FROM postcards
               WHERE sender != ? AND delivered_at IS NOT NULL AND read_at IS NULL""",
            (side,),
        ).fetchone()[0]
        return {"carrying": bool(carrying), "unread": unread}

    def write(self, side: str, body: str, stamp: int = 1, title: str = "") -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO postcards(sender, body, stamp, title) VALUES (?, ?, ?, ?)",
                (side, body, stamp, title),
            )

    def deliver(self, side: str) -> None:
        with self.db:
            self.db.execute(
                """UPDATE postcards SET delivered_at = CURRENT_TIMESTAMP
                   WHERE sender = ? AND delivered_at IS NULL""",
                (side,),
            )

    def inbox(self, side: str) -> list[dict]:
        rows = self.db.execute(
            """SELECT id, title, body, delivered_at AS date, stamp FROM postcards
               WHERE sender != ? AND delivered_at IS NOT NULL AND read_at IS NULL
               ORDER BY id""",
            (side,),
        ).fetchall()
        return [dict(row) for row in rows]

    def mark_read(self, side: str, postcard_id: int) -> None:
        with self.db:
            self.db.execute(
                """UPDATE postcards SET read_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND sender != ? AND delivered_at IS NOT NULL AND read_at IS NULL""",
                (postcard_id, side),
            )

    def close(self) -> None:
        self.db.close()
