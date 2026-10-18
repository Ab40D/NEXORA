"""Notifications: what needs a person's attention (device offline, emergency stop, failed
automations, commissioning problems). Stored in SQLite, pushed live over the event stream, and
read/unread per user. Audiences limit who sees what: everyone, holders of a permission, or one user.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from .db import Database

LEVELS = ("info", "warning", "critical")
RETENTION_S = 30 * 86400
MAX_LIST = 200


class NotificationService:
    def __init__(self, db: Database, publish: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.db = db
        self.publish = publish

    def notify(
        self,
        level: str,
        category: str,
        title: str,
        body: str = "",
        *,
        target_type: str | None = None,
        target_id: str | None = None,
        audience: str = "all",
        dedupe_key: str | None = None,
        dedupe_window_s: float = 300.0,
    ) -> dict[str, Any] | None:
        if level not in LEVELS:
            raise ValueError(f"unknown level {level!r}")
        now = time.time()
        if dedupe_key:
            dup = self.db.one(
                "SELECT id FROM notifications WHERE dedupe_key = ? AND ts > ?", (dedupe_key, now - dedupe_window_s)
            )
            if dup is not None:
                return None  # the same problem was reported recently: no notification storm
        with self.db.transaction() as conn:
            cur = conn.execute(
                "INSERT INTO notifications (ts, level, category, title, body, target_type, target_id, audience, dedupe_key) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (now, level, category, title[:120], body[:500], target_type, target_id, audience, dedupe_key),
            )
            nid = int(cur.lastrowid or 0)
        item = self._json(self.db.one("SELECT * FROM notifications WHERE id = ?", (nid,)), read=False)
        if self.publish is not None:
            self.publish(item)
        return item

    @staticmethod
    def visible_to(audience: str, user_id: str | None, permissions: frozenset[str] | set[str]) -> bool:
        if audience == "all":
            return True
        if audience.startswith("perm:"):
            return audience[5:] in permissions
        if audience.startswith("user:"):
            return user_id is not None and audience[5:] == user_id
        return False

    @staticmethod
    def _json(row: Any, read: bool) -> dict[str, Any]:
        return {
            "id": row["id"],
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["ts"])),
            "level": row["level"],
            "category": row["category"],
            "title": row["title"],
            "body": row["body"],
            "target": {"type": row["target_type"], "id": row["target_id"]} if row["target_type"] else None,
            "audience": row["audience"],
            "read": read,
        }

    def list_for(
        self, user_id: str | None, permissions: frozenset[str] | set[str], *, unread_only: bool = False, limit: int = 50
    ) -> list[dict[str, Any]]:
        rows = self.db.all(
            "SELECT n.*, r.read_at FROM notifications n LEFT JOIN notification_reads r "
            "ON r.notification_id = n.id AND r.user_id = ? ORDER BY n.ts DESC, n.id DESC LIMIT ?",
            (user_id or "-", MAX_LIST),
        )
        out = []
        for r in rows:
            if not self.visible_to(r["audience"], user_id, permissions):
                continue
            read = r["read_at"] is not None
            if unread_only and read:
                continue
            out.append(self._json(r, read))
            if len(out) >= limit:
                break
        return out

    def unread_count(self, user_id: str | None, permissions: frozenset[str] | set[str]) -> int:
        return len(self.list_for(user_id, permissions, unread_only=True, limit=MAX_LIST))

    def mark_read(self, user_id: str, ids: list[int] | None = None) -> int:
        now = time.time()
        rows = self.db.all("SELECT id FROM notifications") if ids is None else [{"id": i} for i in ids]
        with self.db.transaction() as conn:
            for r in rows:
                conn.execute(
                    "INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) "
                    "SELECT id, ?, ? FROM notifications WHERE id = ?",
                    (user_id, now, r["id"]),
                )
        return len(rows)

    def purge(self) -> int:
        return self.db.execute("DELETE FROM notifications WHERE ts < ?", (time.time() - RETENTION_S,))
