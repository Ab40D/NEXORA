"""Audit ledger: who did what, through which interface, and what actually happened.

Each entry records the actor (user and role), the **source** (ui, voice, gesture, assistant,
automation, api, cli, system), the action, the target, the **outcome** (ok, denied, failed, or a
device outcome such as confirmed or unconfirmed) and sanitised details.

Rules:
* Secrets never enter the ledger. Keys that look like credentials are dropped, long strings are
  truncated, and nesting is bounded.
* Free text the user typed or said (assistant messages) is not stored.
* Entries older than the retention period are purged (``SE7ENX_AUDIT_RETENTION_DAYS``).
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .db import Database

log = logging.getLogger("se7enx.ledger")

_SENSITIVE = re.compile(r"pass|token|secret|code|key|auth|cookie|credential|hash", re.IGNORECASE)
SOURCES = frozenset({"ui", "voice", "gesture", "assistant", "automation", "api", "cli", "system", "manual", "test"})


@dataclass(frozen=True)
class Actor:
    id: str | None
    name: str
    role: str | None


SYSTEM = Actor(None, "system", None)


def sanitize(value: Any, depth: int = 0) -> Any:
    if depth > 3:
        return "…"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in list(value.items())[:30]:
            key = str(k)[:40]
            if _SENSITIVE.search(key):
                continue
            out[key] = sanitize(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [sanitize(v, depth + 1) for v in list(value)[:20]]
    if isinstance(value, str):
        return value if len(value) <= 200 else value[:199] + "…"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:200]


class AuditLog:
    def __init__(self, db: Database, retention_days: int, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self.retention_s = retention_days * 86400
        self.clock = clock

    def record(
        self,
        action: str,
        *,
        actor: Actor = SYSTEM,
        source: str = "api",
        outcome: str = "ok",
        target_type: str | None = None,
        target_id: str | None = None,
        ip: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        src = source if source in SOURCES else "api"
        payload = json.dumps(sanitize(details or {}), separators=(",", ":"), ensure_ascii=False)
        try:
            self.db.execute(
                "INSERT INTO audit (ts, actor_id, actor_name, actor_role, source, action, target_type, target_id,"
                " outcome, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    self.clock(),
                    actor.id,
                    actor.name[:80],
                    actor.role,
                    src,
                    action[:64],
                    target_type,
                    (target_id or "")[:80] or None,
                    outcome[:32],
                    ip,
                    payload,
                ),
            )
        except Exception:  # the ledger must never break the action it records
            log.exception("Could not write audit entry %s", action)
            return
        log.info(
            "%s %s by %s (%s) via %s%s",
            action,
            outcome,
            actor.name,
            actor.role or "-",
            src,
            f" → {target_type}:{target_id}" if target_type else "",
        )

    def query(
        self,
        *,
        limit: int = 100,
        before_id: int | None = None,
        action: str | None = None,
        actor_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        outcome: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if before_id is not None:
            clauses.append("id < ?")
            params.append(before_id)
        if action:
            clauses.append("action LIKE ? ESCAPE '\\'")
            params.append(action.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if actor_id:
            clauses.append("actor_id = ?")
            params.append(actor_id)
        if target_type:
            clauses.append("target_type = ?")
            params.append(target_type)
        if target_id:
            clauses.append("target_id = ?")
            params.append(target_id)
        if outcome:
            clauses.append("outcome = ?")
            params.append(outcome)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""  # fixed fragments, values are parameters
        params.append(max(1, min(limit, 500)))
        rows = self.db.all(f"SELECT * FROM audit {where} ORDER BY id DESC LIMIT ?", params)  # noqa: S608
        return [
            {
                "id": r["id"],
                "at": r["ts"],
                "actor": {"id": r["actor_id"], "name": r["actor_name"], "role": r["actor_role"]},
                "source": r["source"],
                "action": r["action"],
                "target": {"type": r["target_type"], "id": r["target_id"]} if r["target_type"] else None,
                "outcome": r["outcome"],
                "details": json.loads(r["details"] or "{}"),
            }
            for r in rows
        ]

    def purge(self) -> int:
        removed = self.db.execute("DELETE FROM audit WHERE ts < ?", (self.clock() - self.retention_s,))
        if removed:
            log.info("Purged %s audit entries older than the retention period", removed)
        return removed
