"""HTTP API of the device layer (mounted by ``create_app``).

Every route requires a session holding a specific permission (see ``core/rbac.py``). Commands
share the existing per-session and global rate limits; configuration changes have their own limit.
Credentials are accepted on input only: they are written to ``secrets.json`` and never returned.
Configuration changes and every command (with its real outcome) go to the audit ledger.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from .auth import Auth, client_ip
from .config import normalize_ha_url
from .core.audit import AuditLog
from .core.rbac import PERMISSIONS
from .devices.adapters.homeassistant import HomeAssistantAdapter
from .devices.model import DEVICE_ID_PATTERN, ApiModel, DeviceCommand, DeviceConfig, DeviceError, DevicePatch
from .devices.registry import DeviceRegistry
from .security import Session, SlidingWindowLimiter

audit = logging.getLogger("se7enx.audit")


class Credentials(ApiModel):
    username: str | None = Field(default=None, min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class AddDeviceRequest(ApiModel):
    device: DeviceConfig
    credentials: Credentials | None = None


class HomeAssistantConfigRequest(ApiModel):
    url: str = Field(min_length=1, max_length=300)
    # Write-only: stored in secrets.json, never returned. Omit to keep the stored token.
    token: str | None = Field(default=None, min_length=8, max_length=4096)
    verify_tls: bool = True


class HomeAssistantTestRequest(ApiModel):
    url: str | None = Field(default=None, min_length=1, max_length=300)
    token: str | None = Field(default=None, min_length=8, max_length=4096)
    verify_tls: bool = True


class ShellyIdentifyRequest(ApiModel):
    host: str = Field(min_length=1, max_length=253)
    username: str | None = Field(default=None, min_length=1, max_length=64)
    password: str | None = Field(default=None, min_length=1, max_length=128)


DeviceId = Path(pattern=DEVICE_ID_PATTERN, max_length=48)
# Command source (DeviceCommand.source) → audit ledger source
LEDGER_SOURCE = {"gesture": "gesture", "voice": "voice", "assistant": "assistant", "test": "test"}


def build_device_router(
    registry: DeviceRegistry,
    auth: Auth,
    ledger: AuditLog,
    limit: Callable[[SlidingWindowLimiter, str, str], None],
    cmd_limiter: SlidingWindowLimiter,
    global_cmd_limiter: SlidingWindowLimiter,
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    require: Callable[[str], Callable[..., Awaitable[Session]]] = auth.require
    need = {p: require(p) for p in PERMISSIONS}

    def record(session: Session, request: Request, action: str, target_id: str | None, **details: Any) -> None:
        ledger.record(
            action,
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="device",
            target_id=target_id,
            details=details,
        )

    config_limiter = SlidingWindowLimiter(30, 60.0)
    read_limiter = SlidingWindowLimiter(20, 10.0)
    identify_limiter = SlidingWindowLimiter(10, 60.0)

    @r.get("/devices")
    async def list_devices(_s: Session = Depends(need["device.view"])) -> dict[str, Any]:
        return {"devices": registry.list_json(), "safety": registry.safety_json()}

    @r.get("/devices/{device_id}")
    async def get_device(device_id: str = DeviceId, _s: Session = Depends(need["device.view"])) -> dict[str, Any]:
        return registry.device_json(device_id)

    @r.post("/devices", status_code=201)
    async def add_device(
        body: AddDeviceRequest, request: Request, session: Session = Depends(need["device.configure"])
    ) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        creds = body.credentials.model_dump(exclude_none=True) if body.credentials else None
        result = await registry.add(body.device, creds, session.client_name)
        record(
            session, request, "device.added", body.device.id, integration=body.device.integration, type=body.device.type
        )
        return result

    @r.patch("/devices/{device_id}")
    async def patch_device(
        body: DevicePatch,
        request: Request,
        device_id: str = DeviceId,
        session: Session = Depends(need["device.configure"]),
    ) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        result = await registry.update(device_id, body, session.client_name)
        changed = sorted(body.model_dump(exclude_unset=True, exclude={"acknowledge_real_control"}))
        action = "device.control_enabled" if body.control_enabled else "device.updated"
        record(session, request, action, device_id, fields=changed, controlEnabled=body.control_enabled)
        return result

    @r.delete("/devices/{device_id}", status_code=204)
    async def delete_device(
        request: Request, device_id: str = DeviceId, session: Session = Depends(need["device.configure"])
    ) -> Response:
        limit(config_limiter, session.id, "configuration changes")
        await registry.remove(device_id, session.client_name)
        record(session, request, "device.removed", device_id)
        return Response(status_code=204)

    @r.post("/devices/{device_id}/commands")
    async def device_command(
        body: DeviceCommand,
        request: Request,
        device_id: str = DeviceId,
        session: Session = Depends(need["device.control"]),
    ) -> dict[str, Any]:
        limit(cmd_limiter, session.id, "commands")
        limit(global_cmd_limiter, "global", "commands on this hub")
        source = LEDGER_SOURCE.get(body.source, "ui")
        try:
            result = await registry.execute(device_id, body, session.client_name)
        except DeviceError as err:
            ledger.record(
                "device.command",
                actor=auth.actor(session),
                source=source,
                ip=client_ip(request),
                outcome="denied" if err.status in (403, 423) else "failed",
                target_type="device",
                target_id=device_id,
                details={"command": body.command, "params": body.params, "error": err.code},
            )
            raise
        ledger.record(
            "device.command",
            actor=auth.actor(session),
            source=source,
            ip=client_ip(request),
            outcome=str(result.get("outcome", "ok")),
            target_type="device",
            target_id=device_id,
            details={"command": body.command, "params": body.params, "delivery": result.get("delivery")},
        )
        return result

    @r.post("/devices/{device_id}/refresh")
    async def refresh_device(
        device_id: str = DeviceId, session: Session = Depends(need["device.view"])
    ) -> dict[str, Any]:
        limit(read_limiter, session.id, "refresh requests")
        return await registry.refresh(device_id)

    @r.post("/integrations/shelly/identify")
    async def shelly_identify(
        body: ShellyIdentifyRequest, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        """Read model, firmware, generation and channels of ONE explicitly entered device. Nothing is saved."""
        limit(identify_limiter, session.id, "identify requests")
        adapter = registry.adapters.get("shelly")
        identify = getattr(adapter, "identify", None)
        if identify is None:
            raise DeviceError("INTEGRATION_UNAVAILABLE", "The Shelly integration is not available.", status=404)
        return await identify(body.host, body.username, body.password)

    def ha_adapter() -> HomeAssistantAdapter:
        adapter = registry.adapters.get("homeassistant")
        if not isinstance(adapter, HomeAssistantAdapter):
            raise DeviceError("INTEGRATION_UNAVAILABLE", "The Home Assistant integration is not available.", status=404)
        return adapter

    def ha_url(value: str) -> str:
        try:
            return normalize_ha_url(value)
        except ValueError as err:
            raise DeviceError("VALIDATION_ERROR", f"Home Assistant URL {err}.", status=422) from err

    @r.get("/integrations/homeassistant")
    async def ha_get(_s: Session = Depends(need["integration.view"])) -> dict[str, Any]:
        a = ha_adapter()
        return {"status": a.status().to_dict(), "config": a.config_json()}

    @r.put("/integrations/homeassistant")
    async def ha_put(
        body: HomeAssistantConfigRequest, request: Request, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        a = ha_adapter()
        await a.configure(ha_url(body.url), body.token, body.verify_tls)
        audit.info("client %r configured Home Assistant at %s", session.client_name, a.config_json()["url"])
        ledger.record(
            "integration.configured",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="integration",
            target_id="homeassistant",
            details={"url": a.config_json()["url"], "tokenChanged": body.token is not None},
        )
        return {"status": a.status().to_dict(), "config": a.config_json()}

    @r.delete("/integrations/homeassistant", status_code=204)
    async def ha_delete(request: Request, session: Session = Depends(need["integration.configure"])) -> Response:
        limit(config_limiter, session.id, "configuration changes")
        await ha_adapter().unconfigure()
        audit.info("client %r removed the Home Assistant configuration", session.client_name)
        ledger.record(
            "integration.removed",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="integration",
            target_id="homeassistant",
        )
        return Response(status_code=204)

    @r.post("/integrations/homeassistant/test")
    async def ha_test(
        body: HomeAssistantTestRequest, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        limit(identify_limiter, session.id, "connection tests")
        return await ha_adapter().test(ha_url(body.url) if body.url else None, body.token, body.verify_tls)

    @r.get("/integrations/homeassistant/entities")
    async def ha_entities(_s: Session = Depends(need["integration.configure"])) -> dict[str, Any]:
        return {"entities": ha_adapter().entities()}

    @r.get("/integrations")
    async def integrations(_s: Session = Depends(need["integration.view"])) -> dict[str, Any]:
        return {"integrations": registry.integrations_json(), "persistent": registry.store.persistent}

    @r.get("/safety")
    async def safety(_s: Session = Depends(need["device.view"])) -> dict[str, Any]:
        return registry.safety_json()

    @r.post("/safety/stop")
    async def safety_stop(request: Request, session: Session = Depends(need["safety.stop"])) -> dict[str, Any]:
        result = registry.set_safety(True, session.client_name)
        ledger.record("safety.stop", actor=auth.actor(session), source="ui", ip=client_ip(request))
        return result

    @r.post("/safety/resume")
    async def safety_resume(request: Request, session: Session = Depends(need["safety.release"])) -> dict[str, Any]:
        result = registry.set_safety(False, session.client_name)
        ledger.record("safety.release", actor=auth.actor(session), source="ui", ip=client_ip(request))
        return result

    @r.get("/config/export")
    async def export_config(request: Request, session: Session = Depends(need["system.backup"])) -> JSONResponse:
        ledger.record("config.exported", actor=auth.actor(session), source="ui", ip=client_ip(request))
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        return JSONResponse(
            registry.store.export(),
            headers={"Content-Disposition": f'attachment; filename="se7enx-config-{stamp}.json"'},
        )

    return r
