"""Password hashing (Argon2id) and password rules (NIST SP 800-63B-4).

* Hashing: Argon2id with the OWASP Password Storage Cheat Sheet minimum, m = 19 MiB, t = 2, p = 1,
  which is affordable on a Raspberry Pi. Hashes created with older parameters are upgraded on the
  next successful login (``needs_rehash``).
* Input is NFKC-normalised before hashing, as NIST recommends, so the same passphrase typed on
  different keyboards verifies.
* Rules: at least ``min_length`` code points (default 15 for single-factor accounts), at most 256.
  Unicode and spaces are allowed. There are no composition rules and no expiry (both are SHALL NOT
  in NIST 800-63B-4). Passwords are checked against a built-in offline blocklist of common
  passwords and trivial patterns, and against context words (username, e-mail, product name).
  Every rejection says why.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

HASHER = PasswordHasher(time_cost=2, memory_cost=19 * 1024, parallelism=1, hash_len=32, salt_len=16, type=Type.ID)
MAX_LENGTH = 256
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# Common passwords and base words (lower-case). Passwords whose letters reduce to one of these, or to
# repetitions of one, are refused. This is a small offline list, not a breach database (SE7ENX does
# not send passwords or password hashes to any online service).
COMMON_WORDS = frozenset(
    {
        "password",
        "passw0rd",
        "motdepasse",
        "contrasena",
        "kennwort",
        "passwort",
        "parola",
        "qwerty",
        "azerty",
        "qwertz",
        "asdfgh",
        "zxcvbn",
        "letmein",
        "welcome",
        "bienvenue",
        "iloveyou",
        "jetaime",
        "admin",
        "administrator",
        "root",
        "user",
        "guest",
        "login",
        "dragon",
        "monkey",
        "football",
        "baseball",
        "soccer",
        "superman",
        "batman",
        "master",
        "sunshine",
        "princess",
        "shadow",
        "trustno",
        "starwars",
        "whatever",
        "freedom",
        "secret",
        "changeme",
        "default",
        "abc",
        "abcdef",
        "test",
        "testing",
        "hello",
        "bonjour",
        "salam",
        "salut",
        "marhaba",
        "algerie",
        "algeria",
        "dzair",
        "blida",
        "alger",
        "oran",
        "paris",
        "london",
        "smarthome",
        "smartlight",
        "homeassistant",
        "knx",
        "shelly",
        "correcthorsebatterystaple",
        "thequickbrownfoxjumpsoverthelazydog",
    }
)
_SEQUENCES = (
    "0123456789",
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiopasdfghjklzxcvbnm",
    "azertyuiopqsdfghjklmwxcvbn",
    "qwertzuiopasdfghjklyxcvbnm",
)
CONTEXT_WORDS = ("se7enx", "sevenx")


class PasswordRejectedError(ValueError):
    """Raised with a machine-readable code and a human explanation."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def normalize(password: str) -> str:
    return unicodedata.normalize("NFKC", password)


def hash_password(password: str) -> str:
    return HASHER.hash(normalize(password))


def verify_password(stored_hash: str, password: str) -> tuple[bool, bool]:
    """Return ``(valid, needs_rehash)``. Never raises on malformed hashes."""
    try:
        HASHER.verify(stored_hash, normalize(password))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False, False
    return True, HASHER.check_needs_rehash(stored_hash)


@lru_cache(maxsize=1)
def _timing_hash() -> str:
    return HASHER.hash("se7enx timing equaliser")


def burn_verification_time(password: str) -> None:
    """Spend the same work as a real verification, so unknown accounts cannot be detected by timing."""
    verify_password(_timing_hash(), password)


def _is_repetition(text: str) -> bool:
    """True if ``text`` is one shorter unit repeated, e.g. 'aaaa', 'abcabcabc', 'passwordpassword'."""
    n = len(text)
    return any(n % unit == 0 and text[:unit] * (n // unit) == text for unit in range(1, n // 2 + 1))


def _is_sequence(text: str) -> bool:
    if len(text) < 4:
        return False
    for seq in _SEQUENCES:
        for s in (seq, seq[::-1]):
            if text in s * (len(text) // len(s) + 2):
                return True
    return False


def check_password(password: str, *, min_length: int, context: tuple[str | None, ...] = ()) -> None:
    """Validate a new password. Raises :class:`PasswordRejectedError`."""
    if not isinstance(password, str) or not password:
        raise PasswordRejectedError("PASSWORD_REQUIRED", "Enter a password.")
    value = normalize(password)
    length = len(value)  # each Unicode code point counts as one character (NIST)
    if length < min_length:
        raise PasswordRejectedError(
            "PASSWORD_TOO_SHORT",
            f"Use at least {min_length} characters. A few unrelated words make a strong, memorable passphrase.",
        )
    if length > MAX_LENGTH:
        raise PasswordRejectedError("PASSWORD_TOO_LONG", f"Use at most {MAX_LENGTH} characters.")
    if _CONTROL.search(value):
        raise PasswordRejectedError("PASSWORD_INVALID", "The password contains control characters.")
    folded = value.casefold()
    compact = re.sub(r"\s+", "", folded)
    letters = "".join(ch for ch in folded if ch.isalpha())
    if (
        compact in COMMON_WORDS
        or _is_repetition(compact)
        or _is_sequence(compact)
        or (letters and (letters in COMMON_WORDS or (_is_repetition(letters) and len(set(letters)) <= 8)))
        or (letters and any(_is_repetition(letters) and letters[: len(w)] == w for w in COMMON_WORDS))
    ):
        raise PasswordRejectedError(
            "PASSWORD_TOO_COMMON",
            "This password is too common or too predictable. Choose something others are unlikely to guess.",
        )
    words = [w.casefold() for w in (*context, *CONTEXT_WORDS) if w]
    for word in words:
        if len(word) >= 4 and word in compact:
            raise PasswordRejectedError(
                "PASSWORD_CONTAINS_CONTEXT",
                "Do not use your username, e-mail address or the product name in your password.",
            )
