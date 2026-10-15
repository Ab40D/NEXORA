"""KNX group address parsing and allowlist policy.

Mirrors ``src/lib/knx/group-address.ts`` in the web app; both are tested
against the same vectors (``tests/fixtures/group-address-vectors.json``).

Syntax validation only proves that an address is well formed — it does not
prove that the address exists in the installation or controls a light.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_THREE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{1,3})$")
_TWO = re.compile(r"^(\d{1,2})/(\d{1,4})$")
_FREE = re.compile(r"^\d{1,5}$")
_MAX_LEN = 16


class GroupAddressError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ParsedGroupAddress:
    raw: int
    style: str
    canonical: str
    display: str


def raw_to_three_level(raw: int) -> str:
    return f"{(raw >> 11) & 0x1F}/{(raw >> 8) & 0x07}/{raw & 0xFF}"


def raw_to_two_level(raw: int) -> str:
    return f"{(raw >> 11) & 0x1F}/{raw & 0x7FF}"


def parse_group_address(value: object) -> ParsedGroupAddress:
    if not isinstance(value, str):
        raise GroupAddressError("format", "Group address must be text.")
    text = value.strip()
    if not text:
        raise GroupAddressError("empty", "Enter a group address, e.g. 0/0/1.")
    if len(text) > _MAX_LEN:
        raise GroupAddressError("format", "Group address is too long.")

    if m := _THREE.match(text):
        main, middle, sub = (int(g) for g in m.groups())
        if main > 31:
            raise GroupAddressError("range", "Main group must be between 0 and 31.")
        if middle > 7:
            raise GroupAddressError("range", "Middle group must be between 0 and 7.")
        if sub > 255:
            raise GroupAddressError("range", "Sub group must be between 0 and 255.")
        raw, style = (main << 11) | (middle << 8) | sub, "three-level"
    elif m := _TWO.match(text):
        main, sub = (int(g) for g in m.groups())
        if main > 31:
            raise GroupAddressError("range", "Main group must be between 0 and 31.")
        if sub > 2047:
            raise GroupAddressError("range", "Sub group must be between 0 and 2047 in two-level format.")
        raw, style = (main << 11) | sub, "two-level"
    elif _FREE.match(text):
        raw, style = int(text), "free"
        if raw > 65535:
            raise GroupAddressError("range", "Free-format group address must be between 1 and 65535.")
    else:
        raise GroupAddressError(
            "format",
            "Use the KNX format main/middle/sub (e.g. 1/2/3), main/sub (e.g. 1/515) or a number 1-65535.",
        )

    if raw == 0:
        raise GroupAddressError("reserved", "0/0/0 is the KNX broadcast address and cannot be used for a light.")

    display = (
        raw_to_three_level(raw)
        if style == "three-level"
        else raw_to_two_level(raw)
        if style == "two-level"
        else str(raw)
    )
    return ParsedGroupAddress(raw=raw, style=style, canonical=raw_to_three_level(raw), display=display)


# --------------------------------------------------------------------------- allowlist

_SEGMENT = re.compile(r"^(\*|\d{1,3}|\d{1,3}-\d{1,3})$")
_LIMITS = (31, 7, 255)


def validate_pattern(pattern: str) -> str:
    """Validate one allowlist pattern. Grammar: ``*`` or ``main/middle/sub`` where each
    segment is a number, ``*`` or an inclusive range ``a-b``."""
    p = pattern.strip()
    if p == "*":
        return p
    parts = p.split("/")
    if len(parts) != 3:
        raise ValueError(
            f"Invalid group address pattern {pattern!r}: use main/middle/sub, e.g. 1/2/3, 1/2/*, 1/2/10-20 or *"
        )
    for seg, limit in zip(parts, _LIMITS, strict=True):
        if not _SEGMENT.match(seg):
            raise ValueError(f"Invalid segment {seg!r} in pattern {pattern!r}")
        if seg == "*":
            continue
        if "-" in seg:
            lo, hi = (int(x) for x in seg.split("-"))
            if lo > hi or hi > limit:
                raise ValueError(f"Invalid range {seg!r} in pattern {pattern!r}")
        elif int(seg) > limit:
            raise ValueError(f"Segment {seg!r} out of range in pattern {pattern!r}")
    return p


def _segment_matches(seg: str, value: int) -> bool:
    if seg == "*":
        return True
    if "-" in seg:
        lo, hi = (int(x) for x in seg.split("-"))
        return lo <= value <= hi
    return int(seg) == value


def ga_matches(canonical: str, pattern: str) -> bool:
    if pattern == "*":
        return True
    parts = pattern.split("/")
    values = [int(x) for x in canonical.split("/")]
    return len(parts) == 3 and all(_segment_matches(s, v) for s, v in zip(parts, values, strict=True))


@dataclass(frozen=True)
class GroupAddressPolicy:
    """Default deny: with no patterns configured, no address may be written or read."""

    patterns: tuple[str, ...]

    def allows(self, canonical: str) -> bool:
        return any(ga_matches(canonical, p) for p in self.patterns)

    @property
    def configured(self) -> bool:
        return len(self.patterns) > 0
