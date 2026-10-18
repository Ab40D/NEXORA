"""Accounts, persistent sessions and one-time codes (invitations, password resets).

Security properties:
* Passwords: Argon2id (see ``passwords.py``). Unknown accounts take the same time as wrong
  passwords, and every failure returns the same generic error, so accounts cannot be enumerated.
* Brute force: failed sign-ins are counted per login name, including names that do not exist, so
  the behaviour reveals nothing. After 5 failures the name is locked progressively (60 s doubling,
  up to 15 min). The HTTP layer adds a per-IP limit.
* Sessions: 256-bit random tokens, only their SHA-256 is stored. Each session has an absolute
  expiry and an idle timeout. Sessions survive a hub restart, and are revoked on logout, password
  change/reset, account disable or delete.
* One-time codes (invitations, password resets): 80-bit random, stored hashed, single use, short
  expiry. The plain code is shown once to the person who created it.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .db import Database
from .passwords import PasswordRejectedError, burn_verification_time, check_password, hash_password, verify_password
from .rbac import ROLES, outranks

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
UNUSABLE_HASH = "!no-password"  # never verifies: the user must redeem a reset code first
MAX_SESSIONS_PER_USER = 20
TOUCH_INTERVAL_S = 60
LOCK_AFTER_FAILURES = 5
LOCK_BASE_S = 60
LOCK_MAX_S = 900
MAX_PREFERENCES_BYTES = 4096


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_login(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip().casefold()


def normalize_code(value: str) -> str:
    return "".join(ch for ch in (value or "").upper() if ch.isalnum())


def format_code(code: str) -> str:
    return "-".join(code[i : i + 4] for i in range(0, len(code), 4))


class IdentityError(Exception):
    def __init__(
        self, status: int, code: str, message: str, hint: str | None = None, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.retry_after = retry_after


@dataclass
class User:
    id: str
    username: str
    email: str | None
    display_name: str
    role: str
    disabled: bool
    must_change_password: bool
    has_password: bool
    created_at: float
    updated_at: float
    last_login_at: float | None
    preferences: dict[str, Any]

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "displayName": self.display_name,
            "role": self.role,
            "disabled": self.disabled,
            "mustChangePassword": self.must_change_password,
            "hasPassword": self.has_password,
            "createdAt": iso(self.created_at),
            "lastLoginAt": iso(self.last_login_at),
        }


@dataclass
class AccountSession:
    id: str
    user_id: str
    created_at: float
    last_seen_at: float
    expires_at: float
    idle_s: int
    remember: bool
    transport: str
    client: str
    ip: str

    def public(self, current_id: str | None = None) -> dict[str, Any]:
        return {
            "id": self.id,
            "client": self.client,
            "ip": self.ip,
            "transport": self.transport,
            "remember": self.remember,
            "createdAt": iso(self.created_at),
            "lastSeenAt": iso(self.last_seen_at),
            "expiresAt": iso(min(self.expires_at, self.last_seen_at + self.idle_s)),
            "current": self.id == current_id,
        }


class LoginGuard:
    """Progressive lockout per login name (existing or not). In memory, bounded."""

    def __init__(self, clock: Callable[[], float], max_entries: int = 10_000) -> None:
        self.clock = clock
        self.max_entries = max_entries
        self._state: OrderedDict[str, tuple[int, float]] = OrderedDict()

    def locked_for(self, key: str) -> float:
        failures, until = self._state.get(key, (0, 0.0))
        return max(0.0, until - self.clock()) if failures >= LOCK_AFTER_FAILURES else 0.0

    def failure(self, key: str) -> None:
        failures, _ = self._state.pop(key, (0, 0.0))
        failures += 1
        until = 0.0
        if failures >= LOCK_AFTER_FAILURES:
            until = self.clock() + min(LOCK_MAX_S, LOCK_BASE_S * 2 ** (failures - LOCK_AFTER_FAILURES))
        self._state[key] = (failures, until)
        while len(self._state) > self.max_entries:
            self._state.popitem(last=False)

    def success(self, key: str) -> None:
        self._state.pop(key, None)


class IdentityService:
    def __init__(
        self,
        db: Database,
        *,
        password_min_length: int = 15,
        session_ttl_s: int = 12 * 3600,
        session_idle_s: int = 2 * 3600,
        remember_ttl_s: int = 30 * 86400,
        remember_idle_s: int = 7 * 86400,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db = db
        self.password_min_length = password_min_length
        self.session_ttl_s = session_ttl_s
        self.session_idle_s = session_idle_s
        self.remember_ttl_s = remember_ttl_s
        self.remember_idle_s = remember_idle_s
        self.clock = clock
        self.guard = LoginGuard(clock)

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _user(row: Any) -> User:
        return User(
            id=row["id"],
            username=row["username"],
            email=row["email"],
            display_name=row["display_name"],
            role=row["role"],
            disabled=bool(row["disabled"]),
            must_change_password=bool(row["must_change_password"]),
            has_password=row["password_hash"] != UNUSABLE_HASH,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_login_at=row["last_login_at"],
            preferences=json.loads(row["preferences"] or "{}"),
        )

    @staticmethod
    def _session(row: Any) -> AccountSession:
        return AccountSession(
            id=row["id"],
            user_id=row["user_id"],
            created_at=row["created_at"],
            last_seen_at=row["last_seen_at"],
            expires_at=row["expires_at"],
            idle_s=row["idle_s"],
            remember=bool(row["remember"]),
            transport=row["transport"],
            client=row["client"],
            ip=row["ip"],
        )

    @staticmethod
    def clean_username(value: str) -> str:
        v = normalize_login(value)
        if not USERNAME_RE.match(v):
            raise IdentityError(
                422,
                "USERNAME_INVALID",
                "Usernames have 3 to 32 characters: letters a-z, digits, dot, dash or underscore, starting with a letter or digit.",
            )
        return v

    @staticmethod
    def clean_email(value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        v = normalize_login(value)
        if len(v) > 254 or not EMAIL_RE.match(v):
            raise IdentityError(422, "EMAIL_INVALID", "Enter a valid e-mail address, or leave it empty.")
        return v

    @staticmethod
    def clean_display_name(value: str) -> str:
        v = unicodedata.normalize("NFKC", value or "").strip()
        if not v or len(v) > 64 or _CONTROL.search(v):
            raise IdentityError(422, "DISPLAY_NAME_INVALID", "Display names have 1 to 64 characters.")
        return v

    def check_new_password(self, password: str, *, username: str, email: str | None, display_name: str) -> None:
        context = (username, email.split("@", 1)[0] if email else None, *display_name.split())
        try:
            check_password(password, min_length=self.password_min_length, context=context)
        except PasswordRejectedError as err:
            raise IdentityError(422, err.code, err.message) from err

    # ------------------------------------------------------------------ users

    def count_users(self) -> int:
        row = self.db.one("SELECT COUNT(*) AS n FROM users")
        return int(row["n"]) if row else 0

    def active_owners(self) -> int:
        row = self.db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0")
        return int(row["n"]) if row else 0

    def get_user(self, user_id: str) -> User | None:
        row = self.db.one("SELECT * FROM users WHERE id = ?", (user_id,))
        return self._user(row) if row else None

    def require_user(self, user_id: str) -> User:
        user = self.get_user(user_id)
        if user is None:
            raise IdentityError(404, "USER_NOT_FOUND", "This user does not exist.")
        return user

    def find_by_login(self, login: str) -> tuple[User, str] | None:
        key = normalize_login(login)
        column = "email" if "@" in key else "username"
        row = self.db.one(f"SELECT * FROM users WHERE {column} = ?", (key,))  # noqa: S608 (fixed column name)
        return (self._user(row), row["password_hash"]) if row else None

    def list_users(self) -> list[User]:
        return [self._user(r) for r in self.db.all("SELECT * FROM users ORDER BY created_at")]

    def create_user(
        self,
        *,
        username: str,
        display_name: str,
        role: str,
        password: str | None,
        email: str | None = None,
        must_change_password: bool = False,
    ) -> User:
        """Create an account. Without a password the account cannot sign in until a reset code is redeemed."""
        if role not in ROLES:
            raise IdentityError(422, "ROLE_UNKNOWN", f"Unknown role {role!r}.")
        uname = self.clean_username(username)
        mail = self.clean_email(email)
        name = self.clean_display_name(display_name)
        if password is not None:
            self.check_new_password(password, username=uname, email=mail, display_name=name)
            pw_hash = hash_password(password)
        else:
            pw_hash = UNUSABLE_HASH
        now = self.clock()
        user_id = secrets.token_hex(8)
        with self.db.transaction() as conn:
            if conn.execute("SELECT 1 FROM users WHERE username = ?", (uname,)).fetchone():
                raise IdentityError(409, "USERNAME_TAKEN", "This username is already taken.")
            if mail and conn.execute("SELECT 1 FROM users WHERE email = ?", (mail,)).fetchone():
                raise IdentityError(409, "EMAIL_TAKEN", "This e-mail address is already used by another account.")
            conn.execute(
                "INSERT INTO users (id, username, email, display_name, role, password_hash, must_change_password,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, uname, mail, name, role, pw_hash, int(must_change_password), now, now),
            )
        return self.require_user(user_id)

    def _ensure_owner_remains(self, user: User, *, new_role: str | None = None, disable: bool = False) -> None:
        losing_owner = user.role == "owner" and not user.disabled and ((new_role and new_role != "owner") or disable)
        if losing_owner and self.active_owners() <= 1:
            raise IdentityError(
                409,
                "LAST_OWNER",
                "This is the last owner account.",
                "Make another user owner first; the system must always have an owner.",
            )

    def update_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        email: str | object | None = ...,
        role: str | None = None,
        disabled: bool | None = None,
    ) -> User:
        user = self.require_user(user_id)
        if role is not None and role not in ROLES:
            raise IdentityError(422, "ROLE_UNKNOWN", f"Unknown role {role!r}.")
        self._ensure_owner_remains(user, new_role=role, disable=bool(disabled))
        fields: dict[str, Any] = {}
        if display_name is not None:
            fields["display_name"] = self.clean_display_name(display_name)
        if email is not ...:
            mail = self.clean_email(email if isinstance(email, str) else None)
            if mail and mail != user.email and self.db.one("SELECT 1 FROM users WHERE email = ?", (mail,)):
                raise IdentityError(409, "EMAIL_TAKEN", "This e-mail address is already used by another account.")
            fields["email"] = mail
        if role is not None:
            fields["role"] = role
        if disabled is not None:
            fields["disabled"] = int(disabled)
        if fields:
            fields["updated_at"] = self.clock()
            assignments = ", ".join(f"{k} = ?" for k in fields)  # keys are fixed column names above
            self.db.execute(f"UPDATE users SET {assignments} WHERE id = ?", (*fields.values(), user_id))  # noqa: S608
        if disabled:
            self.revoke_user_sessions(user_id)
        return self.require_user(user_id)

    def delete_user(self, user_id: str) -> None:
        user = self.require_user(user_id)
        if user.role == "owner" and not user.disabled and self.active_owners() <= 1:
            raise IdentityError(409, "LAST_OWNER", "The last owner account cannot be deleted.")
        self.db.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def set_password(self, user_id: str, new_password: str, *, keep_session_id: str | None = None) -> User:
        user = self.require_user(user_id)
        self.check_new_password(new_password, username=user.username, email=user.email, display_name=user.display_name)
        self.db.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
            (hash_password(new_password), self.clock(), user_id),
        )
        self.revoke_user_sessions(user_id, except_session_id=keep_session_id)
        return self.require_user(user_id)

    def change_password(self, user_id: str, current: str, new_password: str, *, session_id: str | None) -> User:
        row = self.db.one("SELECT password_hash FROM users WHERE id = ?", (user_id,))
        if row is None:
            raise IdentityError(404, "USER_NOT_FOUND", "This user does not exist.")
        ok, _ = verify_password(row["password_hash"], current)
        if not ok:
            raise IdentityError(403, "CURRENT_PASSWORD_WRONG", "The current password is not correct.")
        if current == new_password:
            raise IdentityError(422, "PASSWORD_UNCHANGED", "Choose a password different from the current one.")
        return self.set_password(user_id, new_password, keep_session_id=session_id)

    def set_preferences(self, user_id: str, preferences: dict[str, Any]) -> User:
        text = json.dumps(preferences, separators=(",", ":"), ensure_ascii=False)
        if len(text.encode()) > MAX_PREFERENCES_BYTES:
            raise IdentityError(413, "PREFERENCES_TOO_LARGE", "Preferences are too large.")
        self.db.execute("UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?", (text, self.clock(), user_id))
        return self.require_user(user_id)

    # ------------------------------------------------------------------ sign-in

    def verify_login(self, login: str, password: str) -> User:
        key = normalize_login(login)[:254]
        locked = self.guard.locked_for(key)
        if locked > 0:
            raise IdentityError(
                429,
                "TOO_MANY_ATTEMPTS",
                "Too many failed sign-in attempts. Wait a moment and try again.",
                retry_after=locked,
            )
        found = self.find_by_login(key) if key else None
        if found is None:
            burn_verification_time(password)
            self.guard.failure(key)
            raise self._login_failed()
        user, stored = found
        ok, needs_rehash = verify_password(stored, password)
        if not ok:
            self.guard.failure(key)
            raise self._login_failed()
        if user.disabled:
            raise IdentityError(403, "ACCOUNT_DISABLED", "This account is disabled.", "Ask an administrator.")
        self.guard.success(key)
        now = self.clock()
        if needs_rehash:
            self.db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), user.id))
        self.db.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now, user.id))
        return self.require_user(user.id)

    @staticmethod
    def _login_failed() -> IdentityError:
        return IdentityError(401, "LOGIN_FAILED", "The username or password is incorrect.")

    # ------------------------------------------------------------------ sessions

    def create_session(
        self, user: User, *, remember: bool, transport: str, client: str, ip: str
    ) -> tuple[str, AccountSession]:
        now = self.clock()
        ttl, idle = (
            (self.remember_ttl_s, self.remember_idle_s) if remember else (self.session_ttl_s, self.session_idle_s)
        )
        token = secrets.token_urlsafe(32)
        session_id = secrets.token_hex(8)
        with self.db.transaction() as conn:
            rows = conn.execute(
                "SELECT id FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC", (user.id,)
            ).fetchall()
            for old in rows[MAX_SESSIONS_PER_USER - 1 :]:
                conn.execute("DELETE FROM sessions WHERE id = ?", (old["id"],))
            conn.execute(
                "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, idle_s, remember,"
                " transport, client, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    user.id,
                    hash_token(token),
                    now,
                    now,
                    now + ttl,
                    idle,
                    int(remember),
                    transport,
                    (client or "client")[:80],
                    ip,
                ),
            )
        session = self.get_session(session_id)
        assert session is not None
        return token, session

    def get_session(self, session_id: str) -> AccountSession | None:
        row = self.db.one("SELECT * FROM sessions WHERE id = ?", (session_id,))
        return self._session(row) if row else None

    def authenticate(self, token: str) -> tuple[User, AccountSession] | None:
        if not token or len(token) > 200:
            return None
        row = self.db.one("SELECT * FROM sessions WHERE token_hash = ?", (hash_token(token),))
        if row is None:
            return None
        session = self._session(row)
        now = self.clock()
        if session.expires_at <= now or session.last_seen_at + session.idle_s <= now:
            self.revoke_session(session.id)
            return None
        user = self.get_user(session.user_id)
        if user is None or user.disabled:
            self.revoke_session(session.id)
            return None
        if now - session.last_seen_at >= TOUCH_INTERVAL_S:
            self.db.execute("UPDATE sessions SET last_seen_at = ? WHERE id = ?", (now, session.id))
            session.last_seen_at = now
        return user, session

    def session_active(self, session_id: str) -> bool:
        row = self.db.one("SELECT expires_at, last_seen_at, idle_s FROM sessions WHERE id = ?", (session_id,))
        if row is None:
            return False
        now = self.clock()
        return bool(row["expires_at"] > now and row["last_seen_at"] + row["idle_s"] > now)

    def list_sessions(self, user_id: str) -> list[AccountSession]:
        now = self.clock()
        rows = self.db.all("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC", (user_id,))
        return [s for s in map(self._session, rows) if s.expires_at > now and s.last_seen_at + s.idle_s > now]

    def revoke_session(self, session_id: str) -> bool:
        return self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,)) > 0

    def revoke_user_sessions(self, user_id: str, *, except_session_id: str | None = None) -> int:
        return self.db.execute("DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?", (user_id, except_session_id))

    def purge_expired(self) -> int:
        now = self.clock()
        n = self.db.execute("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at + idle_s <= ?", (now, now))
        n += self.db.execute("DELETE FROM one_time_codes WHERE expires_at <= ? OR used_at IS NOT NULL", (now - 86400,))
        return n

    # ------------------------------------------------------------------ one-time codes

    def issue_code(
        self,
        kind: str,
        *,
        ttl_s: int,
        role: str | None = None,
        user_id: str | None = None,
        created_by: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        if kind not in ("invite", "reset"):
            raise ValueError(kind)
        if kind == "invite" and role not in ROLES:
            raise IdentityError(422, "ROLE_UNKNOWN", f"Unknown role {role!r}.")
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(16))
        now = self.clock()
        code_id = secrets.token_hex(6)
        if kind == "reset":
            # A new reset code replaces any older unused one for the same user.
            self.db.execute(
                "DELETE FROM one_time_codes WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL", (user_id,)
            )
        self.db.execute(
            "INSERT INTO one_time_codes (id, code_hash, kind, user_id, role, created_by, created_at, expires_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (code_id, hash_token(code), kind, user_id, role, created_by, now, now + ttl_s),
        )
        return format_code(code), {"id": code_id, "kind": kind, "role": role, "expiresAt": iso(now + ttl_s)}

    def _consume(self, kind: str, code: str) -> Any:
        normalized = normalize_code(code)
        if len(normalized) != 16:
            return None
        now = self.clock()
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM one_time_codes WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
                (hash_token(normalized), kind, now),
            ).fetchone()
            if row is None:
                return None
            conn.execute("UPDATE one_time_codes SET used_at = ? WHERE id = ?", (now, row["id"]))
            return row

    def peek_code(self, kind: str, code: str) -> Any:
        normalized = normalize_code(code)
        if len(normalized) != 16:
            return None
        return self.db.one(
            "SELECT * FROM one_time_codes WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
            (hash_token(normalized), kind, self.clock()),
        )

    def redeem_invite(self, code: str, *, username: str, display_name: str, password: str, email: str | None) -> User:
        invite = self.peek_code("invite", code)
        if invite is None:
            raise IdentityError(403, "INVITE_INVALID", "This invitation code is invalid, used or expired.")
        # Validate everything (including the password) before the code is spent.
        uname = self.clean_username(username)
        mail = self.clean_email(email)
        name = self.clean_display_name(display_name)
        self.check_new_password(password, username=uname, email=mail, display_name=name)
        if self._consume("invite", code) is None:
            raise IdentityError(403, "INVITE_INVALID", "This invitation code is invalid, used or expired.")
        return self.create_user(username=uname, display_name=name, role=invite["role"], password=password, email=mail)

    def redeem_reset(self, code: str, new_password: str) -> User:
        reset = self.peek_code("reset", code)
        if reset is None or reset["user_id"] is None:
            raise IdentityError(403, "RESET_CODE_INVALID", "This reset code is invalid, used or expired.")
        user = self.require_user(reset["user_id"])
        self.check_new_password(new_password, username=user.username, email=user.email, display_name=user.display_name)
        if self._consume("reset", code) is None:
            raise IdentityError(403, "RESET_CODE_INVALID", "This reset code is invalid, used or expired.")
        return self.set_password(user.id, new_password)

    def list_invites(self) -> list[dict[str, Any]]:
        now = self.clock()
        rows = self.db.all(
            "SELECT * FROM one_time_codes WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at",
            (now,),
        )
        return [
            {"id": r["id"], "role": r["role"], "createdAt": iso(r["created_at"]), "expiresAt": iso(r["expires_at"])}
            for r in rows
        ]

    def revoke_invite(self, code_id: str) -> bool:
        return self.db.execute("DELETE FROM one_time_codes WHERE id = ? AND kind = 'invite'", (code_id,)) > 0


def can_manage(actor_role: str, target_role: str) -> bool:
    return outranks(actor_role, target_role)
