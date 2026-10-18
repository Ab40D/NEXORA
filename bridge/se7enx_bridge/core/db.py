"""SQLite store for operational data: identities, sessions, one-time codes and the audit ledger.

Configuration (devices, building model, role matrix) stays in ``config.json``. This database holds
data that changes often or must never be exported: password hashes, session-token hashes and audit
history. Each domain has exactly one owner, so there is no duplicate source of truth.

* File: ``$SE7ENX_DATA_DIR/se7enx.db`` (created 0600, WAL journal). Without a data directory the
  database lives in memory (development and tests).
* Schema changes are append-only migrations tracked with ``PRAGMA user_version``. A database
  written by a newer SE7ENX version is refused instead of being silently downgraded.
"""

from __future__ import annotations

import contextlib
import logging
import os
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

log = logging.getLogger("se7enx.db")

DB_FILE = "se7enx.db"

# Append only. Never edit a migration that has shipped.
MIGRATIONS: tuple[str, ...] = (
    # 1 — identity, sessions, one-time codes, audit ledger
    """
    CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        last_login_at REAL,
        preferences TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at REAL NOT NULL,
        last_seen_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        idle_s INTEGER NOT NULL,
        remember INTEGER NOT NULL DEFAULT 0,
        transport TEXT NOT NULL,
        client TEXT NOT NULL,
        ip TEXT NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE one_time_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT,
        created_by TEXT,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        used_at REAL
    );
    CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        actor_role TEXT,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        outcome TEXT NOT NULL,
        ip TEXT,
        details TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX audit_ts ON audit(ts);
    CREATE INDEX audit_action ON audit(action);
    CREATE INDEX audit_target ON audit(target_type, target_id);
    """,
    # 2 — commissioning evidence (device verification)
    """
    CREATE TABLE commissioning (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        step TEXT NOT NULL,
        ok INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT,
        actor_name TEXT,
        ts REAL NOT NULL
    );
    CREATE INDEX commissioning_device ON commissioning(device_id, ts);
    """,
)


class DatabaseError(RuntimeError):
    pass


class Database:
    def __init__(self, data_dir: str | Path | None) -> None:
        self.path: Path | None = Path(data_dir) / DB_FILE if data_dir else None
        self._lock = threading.RLock()
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if not self.path.exists():
                # Password and token hashes live here: create the file owner-only before SQLite opens it.
                os.close(os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        target = str(self.path) if self.path is not None else ":memory:"
        self.conn = sqlite3.connect(target, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        if self.path is not None:
            self.conn.execute("PRAGMA journal_mode = WAL")
            self.conn.execute("PRAGMA synchronous = NORMAL")
        self._migrate()

    @property
    def persistent(self) -> bool:
        return self.path is not None

    @property
    def schema_version(self) -> int:
        return int(self.conn.execute("PRAGMA user_version").fetchone()[0])

    def _migrate(self) -> None:
        with self._lock:
            version = self.schema_version
            if version > len(MIGRATIONS):
                raise DatabaseError(
                    f"{self.path} uses schema {version}, newer than this SE7ENX version supports "
                    f"({len(MIGRATIONS)}). Upgrade SE7ENX or restore a backup."
                )
            for number in range(version + 1, len(MIGRATIONS) + 1):
                script = f"BEGIN;\n{MIGRATIONS[number - 1]}\nPRAGMA user_version = {number};\nCOMMIT;"
                try:
                    self.conn.executescript(script)
                except sqlite3.Error as err:
                    if self.conn.in_transaction:
                        self.conn.execute("ROLLBACK")
                    raise DatabaseError(f"Database migration {number} failed: {err}") from err
                log.info("Database schema migrated to version %s", number)

    @contextlib.contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Serialised read-modify-write block (BEGIN IMMEDIATE … COMMIT / ROLLBACK)."""
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Run one statement; returns the number of affected rows."""
        with self._lock:
            return self.conn.execute(sql, params).rowcount

    def one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            row: sqlite3.Row | None = self.conn.execute(sql, params).fetchone()
            return row

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self.conn.execute(sql, params).fetchall())

    def close(self) -> None:
        with self._lock:
            self.conn.close()
