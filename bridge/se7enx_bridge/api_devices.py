"""HTTP API of the device layer (mounted by ``create_app``).

All routes require a paired session. Commands share the existing per-session and global rate
limits; configuration changes have their own limit. Credentials are accepted on input only: they
are written to ``secrets.json`` and never returned.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Path
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from .config import normalize_ha_url
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


def build_device_router(
    registry: DeviceRegistry,
    require_session: Callable[..., Awaitable[Session]],
    limit: Callable[[SlidingWindowLimiter, str, str], None],
    cmd_limiter: SlidingWindowLimiter,
    global_cmd_limiter: SlidingWindowLimiter,
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    config_limiter = SlidingWindowLimiter(30, 60.0)
    read_limiter = SlidingWindowLimiter(20, 10.0)
    identify_limiter = SlidingWindowLimiter(10, 60.0)

    @r.get("/devices")
    async def list_devices(_s: Session = Depends(require_session)) -> dict[str, Any]:
        return {"devices": registry.list_json(), "safety": registry.safety_json()}

    @r.get("/devices/{device_id}")
    async def get_device(device_id: str = DeviceId, _s: Session = Depends(require_session)) -> dict[str, Any]:
        return registry.device_json(device_id)

    @r.post("/devices", status_code=201)
    async def add_device(body: AddDeviceRequest, session: Session = Depends(require_session)) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        creds = body.credentials.model_dump(exclude_none=True) if body.credentials else None
        return await registry.add(body.device, creds, session.client_name)

    @r.patch("/devices/{device_id}")
    async def patch_device(
        body: DevicePatch, device_id: str = DeviceId, session: Session = Depends(require_session)
    ) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        return await registry.update(device_id, body, session.client_name)

    @r.delete("/devices/{device_id}", status_code=204)
    async def delete_device(device_id: str = DeviceId, session: Session = Depends(require_session)) -> Response:
        limit(config_limiter, session.id, "configuration changes")
        await registry.remove(device_id, session.client_name)
        return Response(status_code=204)

    @r.post("/devices/{device_id}/commands")
    async def device_command(
        body: DeviceCommand, device_id: str = DeviceId, session: Session = Depends(require_session)
    ) -> dict[str, Any]:
        limit(cmd_limiter, session.id, "commands")
        limit(global_cmd_limiter, "global", "commands on this hub")
        return await registry.execute(device_id, body, session.client_name)

    @r.post("/devices/{device_id}/refresh")
    async def refresh_device(device_id: str = DeviceId, session: Session = Depends(require_session)) -> dict[str, Any]:
        limit(read_limiter, session.id, "refresh requests")
        return await registry.refresh(device_id)

    @r.post("/integrations/shelly/identify")
    async def shelly_identify(
        body: ShellyIdentifyRequest, session: Session = Depends(require_session)
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
    async def ha_get(_s: Session = Depends(require_session)) -> dict[str, Any]:
        a = ha_adapter()
        return {"status": a.status().to_dict(), "config": a.config_json()}

    @r.put("/integrations/homeassistant")
    async def ha_put(body: HomeAssistantConfigRequest, session: Session = Depends(require_session)) -> dict[str, Any]:
        limit(config_limiter, session.id, "configuration changes")
        a = ha_adapter()
        await a.configure(ha_url(body.url), body.token, body.verify_tls)
        audit.info("client %r configured Home Assistant at %s", session.client_name, a.config_json()["url"])
        return {"status": a.status().to_dict(), "config": a.config_json()}

    @r.delete("/integrations/homeassistant", status_code=204)
    async def ha_delete(session: Session = Depends(require_session)) -> Response:
        limit(config_limiter, session.id, "configuration changes")
        await ha_adapter().unconfigure()
        audit.info("client %r removed the Home Assistant configuration", session.client_name)
        return Response(status_code=204)

    @r.post("/integrations/homeassistant/test")
    async def ha_test(body: HomeAssistantTestRequest, session: Session = Depends(require_session)) -> dict[str, Any]:
        limit(identify_limiter, session.id, "connection tests")
        return await ha_adapter().test(ha_url(body.url) if body.url else None, body.token, body.verify_tls)

    @r.get("/integrations/homeassistant/entities")
    async def ha_entities(_s: Session = Depends(require_session)) -> dict[str, Any]:
        return {"entities": ha_adapter().entities()}

    @r.get("/integrations")
    async def integrations(_s: Session = Depends(require_session)) -> dict[str, Any]:
        return {"integrations": registry.integrations_json(), "persistent": registry.store.persistent}

    @r.get("/safety")
    async def safety(_s: Session = Depends(require_session)) -> dict[str, Any]:
        return registry.safety_json()

    @r.post("/safety/stop")
    async def safety_stop(session: Session = Depends(require_session)) -> dict[str, Any]:
        return registry.set_safety(True, session.client_name)

    @r.post("/safety/resume")
    async def safety_resume(session: Session = Depends(require_session)) -> dict[str, Any]:
        return registry.set_safety(False, session.client_name)

    @r.get("/config/export")
    async def export_config(_s: Session = Depends(require_session)) -> JSONResponse:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        return JSONResponse(
            registry.store.export(),
            headers={"Content-Disposition": f'attachment; filename="se7enx-config-{stamp}.json"'},
        )

    return r
