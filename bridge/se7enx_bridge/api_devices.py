"""HTTP API of the device layer (mounted by ``create_app``).

All routes require a paired session. Commands share the existing per-session and global rate
limits; configuration changes have their own limit. Credentials are accepted on input only: they
are written to ``secrets.json`` and never returned.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Path
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from .devices.model import DEVICE_ID_PATTERN, ApiModel, DeviceCommand, DeviceConfig, DevicePatch
from .devices.registry import DeviceRegistry
from .security import Session, SlidingWindowLimiter


class Credentials(ApiModel):
    username: str | None = Field(default=None, min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class AddDeviceRequest(ApiModel):
    device: DeviceConfig
    credentials: Credentials | None = None


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
