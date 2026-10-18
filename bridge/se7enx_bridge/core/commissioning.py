"""Commissioning and verification of devices (evidence-based).

Every device has a verification level that says how much SE7ENX actually knows about it:

* ``simulated``  - a simulated device; never presented as real.
* ``configured`` - the configuration exists, but SE7ENX has not received real data from the device.
* ``connected``  - the integration is up and the device has reported its actual state (Shelly poll,
  Home Assistant event, KNX status/read response). Syntax-valid addresses alone do not count.
* ``verified``   - a commissioning switch test got *feedback from the device itself* (outcome
  ``confirmed``) AND a person confirmed the physical effect ("I saw the light turn on").

Evidence is tied to a fingerprint of the device configuration: changing a group address, host,
entity or channel invalidates the verification. Nothing here bypasses the command pipeline: switch
tests go through ``DeviceRegistry.execute`` (permissions, emergency stop, KNX address allowlist,
rate limits) with source ``test`` and require an explicit confirmation flag.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any

from .db import Database

STEPS = ("read", "switch", "observe", "reset")
OBSERVE_WINDOW_S = 15 * 60
DEVICE_DATA_SOURCES = ("event", "status", "read", "poll")
_FINGERPRINT_EXCLUDE = {"name", "metadata", "hidden", "controlEnabled", "control_enabled"}


def fingerprint(device: dict[str, Any]) -> str:
    """Stable hash of what identifies the physical endpoint (integration + config), not cosmetics."""
    cfg = {k: v for k, v in (device.get("config") or {}).items() if k not in _FINGERPRINT_EXCLUDE}
    blob = json.dumps(
        {"integration": device.get("integration"), "type": device.get("type"), "config": cfg}, sort_keys=True
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Evidence:
    id: int
    device_id: str
    fingerprint: str
    step: str
    ok: bool
    detail: dict[str, Any]
    actor_name: str | None
    ts: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "step": self.step,
            "ok": self.ok,
            "detail": self.detail,
            "actor": self.actor_name,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.ts)),
            "fingerprint": self.fingerprint,
        }


class CommissioningService:
    def __init__(self, db: Database) -> None:
        self.db = db

    def record(
        self,
        device_id: str,
        fp: str,
        step: str,
        ok: bool,
        detail: dict[str, Any],
        actor_id: str | None,
        actor_name: str | None,
    ) -> Evidence:
        if step not in STEPS:
            raise ValueError(f"unknown commissioning step {step!r}")
        ts = time.time()
        with self.db.transaction() as conn:
            cur = conn.execute(
                "INSERT INTO commissioning (device_id, fingerprint, step, ok, detail, actor_id, actor_name, ts) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (device_id, fp, step, int(ok), json.dumps(detail, default=str)[:4000], actor_id, actor_name, ts),
            )
            row_id = int(cur.lastrowid or 0)
        return Evidence(row_id, device_id, fp, step, ok, detail, actor_name, ts)

    def history(self, device_id: str, limit: int = 50) -> list[Evidence]:
        rows = self.db.all(
            "SELECT * FROM commissioning WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT ?", (device_id, limit)
        )
        return [
            Evidence(
                r["id"],
                r["device_id"],
                r["fingerprint"],
                r["step"],
                bool(r["ok"]),
                json.loads(r["detail"]),
                r["actor_name"],
                r["ts"],
            )
            for r in rows
        ]

    def forget(self, device_id: str) -> None:
        self.db.execute("DELETE FROM commissioning WHERE device_id = ?", (device_id,))

    def last_switch(self, device_id: str, fp: str) -> Evidence | None:
        for e in self.history(device_id, 20):
            if e.fingerprint != fp or e.step == "reset":
                return None
            if e.step == "switch":
                return e
        return None

    def assess(self, device: dict[str, Any]) -> dict[str, Any]:
        """Verification level + the evidence it rests on."""
        fp = fingerprint(device)
        evidence = self.history(device["id"], 50)
        current = []
        for e in evidence:  # newest first, stop at a reset or a config change
            if e.step == "reset" or e.fingerprint != fp:
                break
            current.append(e)
        verified: Evidence | None = None
        for i, e in enumerate(current):
            if e.step == "observe":
                if not e.ok:
                    break  # the most recent observation failed: not verified
                switch = next((s for s in current[i + 1 :] if s.step == "switch"), None)
                if switch and switch.ok and e.ts - switch.ts <= OBSERVE_WINDOW_S:
                    verified = e
                break
        failure = next((e for e in current if not e.ok), None)
        state = device.get("state") or {}
        connection = (device.get("connection") or {}).get("status")
        has_device_data = bool(state.get("reportedAt")) and state.get("source") in DEVICE_DATA_SOURCES
        if device.get("simulated"):
            level = "simulated"
        elif verified is not None:
            level = "verified"
        elif connection == "online" and has_device_data:
            level = "connected"
        else:
            level = "configured"
        return {
            "level": level,
            "fingerprint": fp,
            "verifiedAt": verified.to_dict()["at"] if verified else None,
            "verifiedBy": verified.actor_name if verified else None,
            "lastFailure": failure.to_dict() if failure and (verified is None or failure.ts > verified.ts) else None,
            "history": [e.to_dict() for e in evidence[:20]],
        }
