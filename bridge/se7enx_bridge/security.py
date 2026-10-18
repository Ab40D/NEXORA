"""Pairing, sessions and rate limiting.

Threat model highlights:
  * Every state-changing endpoint requires a Bearer session token. Tokens are
    obtained only by presenting the pairing code that the bridge prints on its
    own console — proof of physical/administrative access to the bridge.
  * Bearer tokens are sent in a header (never cookies), so classic CSRF does
    not apply; the Origin allowlist additionally blocks foreign web pages.
  * Pairing attempts are rate limited per client and globally; repeated
    failures rotate the code and lock pairing temporarily.
  * Tokens are stored only as SHA-256 hashes and expire.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from .core.rbac import ALL as ALL_PERMISSIONS

log = logging.getLogger("se7enx.security")

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I
CODE_LENGTH = 8


def normalize_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def format_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}" if len(code) == 8 else code


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


class SlidingWindowLimiter:
    """Allows at most `limit` hits per `window_s` seconds per key."""

    def __init__(self, limit: int, window_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window = window_s
        self.clock = clock
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> tuple[bool, float]:
        now = self.clock()
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] >= self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False, max(0.0, self.window - (now - q[0]))
        q.append(now)
        if len(self._hits) > 10_000:  # bound memory under abuse
            for k in [k for k, v in self._hits.items() if not v][:5_000]:
                self._hits.pop(k, None)
        return True, 0.0

    def blocked_for(self, key: str) -> float:
        """Seconds until `key` may hit again (0 = not blocked). Does not record a hit."""
        now = self.clock()
        q = self._hits.get(key)
        if not q:
            return 0.0
        while q and now - q[0] >= self.window:
            q.popleft()
        return max(0.0, self.window - (now - q[0])) if len(q) >= self.limit else 0.0


class PairingManager:
    """Holds the current pairing code; random codes rotate on use and on expiry."""

    def __init__(
        self,
        fixed_code: str | None,
        ttl_s: int,
        on_new_code: Callable[[str], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_failures: int = 20,
        lockout_s: float = 300.0,
    ) -> None:
        self._fixed = normalize_code(fixed_code) if fixed_code else None
        self._ttl = ttl_s
        self._clock = clock
        self._on_new_code = on_new_code
        self._code = ""
        self._issued = 0.0
        self._failures = 0
        self._max_failures = max_failures
        self._lockout_s = lockout_s
        self._locked_until = 0.0
        self._rotate(reason="startup")

    @property
    def fixed(self) -> bool:
        return self._fixed is not None

    def _rotate(self, reason: str) -> None:
        self._code = self._fixed or generate_code()
        self._issued = self._clock()
        if self._on_new_code and (not self._fixed or reason == "startup"):
            self._on_new_code(self._code)

    def current_code(self) -> str:
        if not self._fixed and self._clock() - self._issued > self._ttl:
            self._rotate(reason="expired")
        return self._code

    def locked_for(self) -> float:
        return max(0.0, self._locked_until - self._clock())

    def verify(self, candidate: str) -> bool:
        if self.locked_for() > 0:
            return False
        expected = self.current_code()
        ok = hmac.compare_digest(normalize_code(candidate).encode(), expected.encode())
        if ok:
            self._failures = 0
            if not self._fixed:
                self._rotate(reason="used")  # one-time use
            return True
        self._failures += 1
        if self._failures >= self._max_failures:
            self._failures = 0
            self._locked_until = self._clock() + self._lockout_s
            log.warning("Too many failed pairing attempts — pairing locked for %.0f s", self._lockout_s)
            if not self._fixed:
                self._rotate(reason="lockout")
        return False


@dataclass
class Session:
    id: str
    token_hash: str
    client_name: str
    created_at: float
    expires_at: float
    ip: str
    lights: dict[str, object] = field(default_factory=dict)
    recent_requests: dict[str, tuple[float, dict]] = field(default_factory=dict)
    # Identity of the caller. Legacy pairing sessions (only possible while no owner account exists)
    # act with full rights; account sessions carry the user's role and permissions, refreshed per request.
    kind: str = "pairing"
    user_id: str | None = None
    username: str | None = None
    role: str = "owner"
    permissions: frozenset[str] = ALL_PERMISSIONS
    transport: str = "bearer"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class SessionStore:
    def __init__(self, ttl_s: int, max_sessions: int, clock: Callable[[], float] = time.time) -> None:
        self.ttl = ttl_s
        self.max_sessions = max_sessions
        self.clock = clock
        self._by_hash: dict[str, Session] = {}
        self._revoked_listeners: list[Callable[[Session], None]] = []

    def on_revoked(self, fn: Callable[[Session], None]) -> None:
        self._revoked_listeners.append(fn)

    def create(self, client_name: str, ip: str) -> tuple[str, Session]:
        self.purge_expired()
        while len(self._by_hash) >= self.max_sessions:
            oldest = min(self._by_hash.values(), key=lambda s: s.created_at)
            self.revoke(oldest)
        token = secrets.token_urlsafe(32)
        now = self.clock()
        session = Session(
            id=secrets.token_hex(8),
            token_hash=_hash(token),
            client_name=client_name[:80] or "client",
            created_at=now,
            expires_at=now + self.ttl,
            ip=ip,
        )
        self._by_hash[session.token_hash] = session
        return token, session

    def authenticate(self, token: str) -> Session | None:
        if not token or len(token) > 200:
            return None
        s = self._by_hash.get(_hash(token))
        if s is None:
            return None
        if s.expires_at <= self.clock():
            self.revoke(s)
            return None
        return s

    def revoke(self, session: Session) -> None:
        if self._by_hash.pop(session.token_hash, None) is not None:
            for fn in self._revoked_listeners:
                fn(session)

    def revoke_all(self) -> int:
        sessions = list(self._by_hash.values())
        for s in sessions:
            self.revoke(s)
        return len(sessions)

    def purge_expired(self) -> None:
        now = self.clock()
        for s in [s for s in self._by_hash.values() if s.expires_at <= now]:
            self.revoke(s)

    def is_active(self, session: Session) -> bool:
        return self._by_hash.get(session.token_hash) is session and session.expires_at > self.clock()

    def __len__(self) -> int:
        return len(self._by_hash)
