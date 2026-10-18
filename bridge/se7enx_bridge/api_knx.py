"""KNX/IP interface configuration from the hub UI, plus read-only KNX USB diagnostics.

* Environment configuration (``SE7ENX_KNX_*``) always wins and makes the UI read-only.
* A hub-configured interface is persisted in ``config.json`` and uses the same supervised
  connection (back-off + reconnect) as environment configuration.
* The interface address must be inside ``SE7ENX_CLIENT_GATEWAY_CIDRS`` (private networks by default).
* "Connected" means the KNXnet/IP connection handshake with the interface succeeded. It is not a
  ping, and it does not prove that any particular group address exists on the bus.
* Nothing is ever written to the bus by these routes.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import Field

from .config import Settings
from .core.rbac import PERMISSIONS
from .devices.knx_usb import scan_usb
from .devices.model import ApiModel, DeviceError
from .devices.registry import DeviceRegistry
from .devices.store import KnxInterfaceSettings
from .knx import GatewayTarget, KnxService, KnxStatus, gateway_allowed
from .security import Session, SlidingWindowLimiter

audit = logging.getLogger("se7enx.audit")

# How long POST /integrations/knx/test waits for the handshake to finish.
TEST_WAIT_S = 12.0


class KnxInterfaceRequest(ApiModel):
    connectionType: Literal["tunneling", "tunneling_tcp", "routing"]  # JSON field name
    host: str | None = Field(default=None, max_length=45)
    port: int = Field(default=3671, ge=1, le=65535)
    routeBack: bool = False  # JSON field name


def env_configured(settings: Settings) -> bool:
    """True when the operator configured the KNX interface through environment variables."""
    return settings.gateway_ip is not None or settings.connection_type != "automatic" or settings.autoconnect


def stored_target(registry: DeviceRegistry) -> GatewayTarget | None:
    k = registry.store.config.knx
    if k.connection_type is None:
        return None
    host = None if k.connection_type == "routing" else k.gateway_ip
    return GatewayTarget(k.connection_type, host, k.gateway_port, route_back=k.route_back)


async def apply_stored_interface(settings: Settings, knx: KnxService, registry: DeviceRegistry) -> None:
    """Called at start-up: connect to a UI-configured interface (environment config wins)."""
    if env_configured(settings):
        return
    target = stored_target(registry)
    if target is not None:
        await knx.reconfigure(target)


def _payload(settings: Settings, knx: KnxService, registry: DeviceRegistry) -> dict[str, Any]:
    if env_configured(settings):
        source = "environment"
        config: dict[str, Any] | None = {
            "connectionType": settings.connection_type,
            "host": settings.gateway_ip,
            "port": settings.gateway_port,
            "routeBack": settings.route_back,
        }
    else:
        k = registry.store.config.knx
        source = "hub" if k.connection_type else "none"
        config = (
            {
                "connectionType": k.connection_type,
                "host": k.gateway_ip,
                "port": k.gateway_port,
                "routeBack": k.route_back,
            }
            if k.connection_type
            else None
        )
    return {
        "source": source,
        "editable": source != "environment",
        "config": config,
        "secure": bool(settings.keyring_path or settings.secure_user_id or settings.backbone_key),
        "status": knx.status.to_dict(),
        "allowedNetworks": [str(n) for n in settings.client_gateway_cidrs],
        "usbSupported": False,
    }


def build_knx_interface_router(
    settings: Settings,
    knx: KnxService,
    registry: DeviceRegistry,
    require: Callable[[str], Callable[..., Awaitable[Session]]],
    limit: Callable[[SlidingWindowLimiter, str, str], None],
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    need = {p: require(p) for p in PERMISSIONS}
    config_limiter = SlidingWindowLimiter(10, 60.0)
    usb_limiter = SlidingWindowLimiter(10, 60.0)

    @r.get("/integrations/knx")
    async def get_knx(_s: Session = Depends(need["integration.view"])) -> dict[str, Any]:
        return _payload(settings, knx, registry)

    @r.put("/integrations/knx")
    async def put_knx(
        body: KnxInterfaceRequest, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        limit(config_limiter, session.id, "KNX interface changes")
        if env_configured(settings):
            raise DeviceError(
                "KNX_CONFIGURED_BY_ENV",
                "The KNX interface is configured on the hub with environment variables (SE7ENX_KNX_*).",
                hint="Change it in the hub's .env file, or remove those variables to configure it here.",
                status=409,
            )
        host: str | None = None
        if body.connectionType != "routing":
            raw = (body.host or "").strip()
            try:
                host = str(ipaddress.IPv4Address(raw))
            except ValueError as err:
                raise DeviceError(
                    "VALIDATION_ERROR",
                    "Enter the KNX/IP interface's IPv4 address (for example 192.168.1.50).",
                    status=422,
                ) from err
            if not gateway_allowed(host, settings.client_gateway_cidrs):
                raise DeviceError(
                    "GATEWAY_NOT_ALLOWED",
                    f"{host} is outside the networks this hub may contact.",
                    hint="Use the interface's private LAN address. Allowed networks: "
                    + ", ".join(str(n) for n in settings.client_gateway_cidrs),
                    status=403,
                )
        registry.store.config.knx = KnxInterfaceSettings(
            connection_type=body.connectionType,
            gateway_ip=host,
            gateway_port=body.port,
            route_back=body.routeBack,
        )
        registry.store.save()
        audit.info(
            "client %r configured the KNX interface type=%s host=%s port=%s",
            session.client_name,
            body.connectionType,
            host,
            body.port,
        )
        target = stored_target(registry)
        await knx.reconfigure(target)
        return _payload(settings, knx, registry)

    @r.delete("/integrations/knx", status_code=204)
    async def delete_knx(session: Session = Depends(need["integration.configure"])) -> Response:
        limit(config_limiter, session.id, "KNX interface changes")
        if env_configured(settings):
            raise DeviceError(
                "KNX_CONFIGURED_BY_ENV",
                "The KNX interface is configured with environment variables and cannot be removed here.",
                status=409,
            )
        registry.store.config.knx = KnxInterfaceSettings()
        registry.store.save()
        audit.info("client %r removed the KNX interface configuration", session.client_name)
        await knx.reconfigure(None)
        return Response(status_code=204)

    @r.post("/integrations/knx/test")
    async def test_knx(_s: Session = Depends(need["integration.configure"])) -> dict[str, Any]:
        """Wait for the current connection attempt to finish and report the real handshake result."""
        if knx.status.state == "connecting":
            finished = asyncio.Event()

            def listener(status: KnxStatus) -> None:
                if status.state != "connecting":
                    finished.set()

            knx.on_status(listener)
            try:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(finished.wait(), TEST_WAIT_S)
            finally:
                knx.off_status(listener)
        return _payload(settings, knx, registry)

    @r.get("/integrations/knx/usb")
    async def knx_usb(session: Session = Depends(need["integration.view"])) -> dict[str, Any]:
        limit(usb_limiter, session.id, "USB scans")
        return scan_usb()

    return r
