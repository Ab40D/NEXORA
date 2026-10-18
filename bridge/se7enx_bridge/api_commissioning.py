"""Commissioning API: evidence-based device verification (see core/commissioning.py)."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from .auth import Auth, client_ip
from .core.audit import AuditLog
from .core.commissioning import DEVICE_DATA_SOURCES, OBSERVE_WINDOW_S, CommissioningService, fingerprint
from .core.rbac import PERMISSIONS
from .devices.model import ApiModel, DeviceCommand, DeviceError
from .devices.registry import DeviceRegistry
from .security import Session, SlidingWindowLimiter

DEVICE_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,47}$"


class CommissioningRequest(ApiModel):
    step: Literal["read", "switch", "observe", "reset"]
    request_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    value: Literal["on", "off"] | None = None
    observed: bool | None = None
    # switch tests move real equipment: the client must confirm explicitly
    confirm: bool = False


def _ts(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def build_commissioning_router(
    *,
    auth: Auth,
    registry: DeviceRegistry,
    commissioning: CommissioningService,
    ledger: AuditLog,
    limit: Callable[[SlidingWindowLimiter, str, str], None],
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    need = {p: auth.require(p) for p in PERMISSIONS}
    limiter = SlidingWindowLimiter(20, 60.0)

    def assessment(device_id: str) -> dict[str, Any]:
        return commissioning.assess(registry.device_json(device_id))

    @r.get("/commissioning")
    async def levels(_s: Session = Depends(need["device.view"])) -> dict[str, Any]:
        out = {}
        for d in registry.list_json():
            a = commissioning.assess(d)
            out[d["id"]] = {"level": a["level"], "verifiedAt": a["verifiedAt"]}
        return {"devices": out}

    @r.get("/devices/{device_id}/commissioning")
    async def get_commissioning(device_id: str, _s: Session = Depends(need["device.view"])) -> dict[str, Any]:
        return assessment(device_id)

    @r.post("/devices/{device_id}/commissioning")
    async def run_step(
        device_id: str,
        body: CommissioningRequest,
        request: Request,
        session: Session = Depends(need["device.configure"]),
    ) -> dict[str, Any]:
        limit(limiter, session.id, "commissioning steps")
        device = registry.device_json(device_id)  # 404 for unknown devices
        fp = fingerprint(device)
        actor = auth.actor(session)
        detail: dict[str, Any] = {}
        ok = False

        if body.step == "read":
            started = time.time()
            try:
                dev = await registry.refresh(device_id)
            except DeviceError as err:
                detail = {"error": err.code, "message": err.message}
            else:
                st = dev["state"]
                fresh = (_ts(st.get("reportedAt")) or 0) >= started - 1
                ok = dev["connection"]["status"] == "online" and fresh and st.get("source") in DEVICE_DATA_SOURCES
                detail = {
                    "connection": dev["connection"]["status"],
                    "source": st.get("source"),
                    "reported": st.get("reported"),
                    "fresh": fresh,
                }
                if not ok:
                    detail["message"] = (
                        "The device did not report its actual state."
                        if dev["connection"]["status"] == "online"
                        else f"The device is {dev['connection']['status']}."
                    )
        elif body.step == "switch":
            if body.value is None:
                raise DeviceError("VALUE_REQUIRED", "Choose 'on' or 'off' for the switch test.", status=400)
            if not body.confirm:
                raise DeviceError(
                    "CONFIRMATION_REQUIRED",
                    "A switch test operates real equipment and must be confirmed.",
                    hint="Make sure nobody is at risk, then confirm the test.",
                    status=400,
                )
            cmd = DeviceCommand(
                command="turn_on" if body.value == "on" else "turn_off", request_id=body.request_id, source="test"
            )
            t0 = time.monotonic()
            try:
                res = await registry.execute(device_id, cmd, session.client_name)
            except DeviceError as err:
                detail = {"command": cmd.command, "error": err.code, "message": err.message}
            else:
                outcome = res["outcome"]
                ok = outcome == "confirmed" or (device["simulated"] and outcome == "simulated")
                detail = {
                    "command": cmd.command,
                    "outcome": outcome,
                    "delivery": res.get("delivery"),
                    "latencyMs": int((time.monotonic() - t0) * 1000),
                    "reported": res["device"]["state"]["reported"],
                    "message": res.get("detail"),
                }
                if outcome == "accepted":
                    detail["message"] = (
                        "The command was sent, but the device did not confirm it (no feedback): "
                        "SE7ENX cannot verify that it took effect."
                    )
                elif outcome == "already_satisfied":
                    detail["message"] = "The device already reports this state. Test the other direction."
        elif body.step == "observe":
            if body.observed is None:
                raise DeviceError("OBSERVATION_REQUIRED", "Say whether the physical change was observed.", status=400)
            last = commissioning.last_switch(device_id, fp)
            if last is None or not last.ok or time.time() - last.ts > OBSERVE_WINDOW_S:
                raise DeviceError(
                    "NO_RECENT_SWITCH_TEST",
                    "Run a successful switch test first (within the last 15 minutes).",
                    status=409,
                )
            ok = body.observed
            detail = {"observed": body.observed, "switch": last.detail.get("command")}
            if not ok:
                detail["message"] = (
                    "The device reported the change, but nothing changed physically: check the wiring, "
                    "the channel, or which group address the actuator really uses."
                )
        else:  # reset
            ok = True
            detail = {"message": "Verification cleared."}

        ev = commissioning.record(device_id, fp, body.step, ok, detail, actor.id, actor.name)
        ledger.record(
            "device.commissioning",
            actor=actor,
            source="ui",
            ip=client_ip(request),
            outcome="ok" if ok else "failed",
            target_type="device",
            target_id=device_id,
            details={"step": body.step, "result": "ok" if ok else "failed", "outcome": detail.get("outcome")},
        )
        return {"evidence": ev.to_dict(), "assessment": assessment(device_id)}

    return r
