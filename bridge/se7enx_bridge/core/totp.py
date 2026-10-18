"""Time-based one-time passwords (RFC 6238 / RFC 4226) with the Python standard library only.

Parameters are the ones every authenticator app supports: HMAC-SHA1, 30-second steps, 6 digits.
Verification accepts one step of clock drift on either side and never accepts the same (or an
older) step twice for the same account (replay protection).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP_S = 30
DIGITS = 6
DRIFT_STEPS = 1
RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I


def new_secret() -> str:
    """160-bit secret, base32 without padding (what authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def hotp(secret: str, counter: int, digits: int = DIGITS) -> str:
    mac = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    value = struct.unpack(">I", mac[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10**digits)).zfill(digits)


def step_at(ts: float) -> int:
    return int(ts // STEP_S)


def verify(secret: str, code: str, *, now: float | None = None, last_step: int | None = None) -> int | None:
    """Return the matched time step, or None. Steps <= last_step are rejected (no replay)."""
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != DIGITS:
        return None
    current = step_at(time.time() if now is None else now)
    for step in range(current - DRIFT_STEPS, current + DRIFT_STEPS + 1):
        if last_step is not None and step <= last_step:
            continue
        if hmac.compare_digest(hotp(secret, step), digits):
            return step
    return None


def provisioning_uri(secret: str, account: str, issuer: str = "SE7ENX") -> str:
    label = quote(f"{issuer}:{account}", safe="")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits={DIGITS}&period={STEP_S}"


def new_recovery_code() -> str:
    raw = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def normalize_recovery_code(value: str) -> str:
    return "".join(ch for ch in value.upper() if ch in RECOVERY_ALPHABET)
