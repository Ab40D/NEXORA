"""SE7ENX Bridge HTTP API (contract v1 — see docs/API.md in the repository)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from xknx.dpt import DPTArray, DPTBinary

from . import API_VERSION, __version__
from .api_auth import build_auth_router, identity_exception_handlers
from .api_building import build_building_router, building_exception_handlers
from .api_commissioning import build_commissioning_router
from .api_devices import build_device_router
from .api_knx import apply_stored_interface, build_knx_interface_router
from .api_tls import build_tls_router, mount_setup_page
from .assistant import LlmInterpreter, build_assistant_router
from .auth import Auth, client_ip
from .config import Settings
from .core.audit import AuditLog
from .core.building import BuildingService
from .core.commissioning import CommissioningService
from .core.db import Database
from .core.identity import IdentityService
from .core.rbac import PERMISSIONS, RoleMatrix
from .devices.adapters.base import AdapterCallbacks, DeviceAdapter
from .devices.model import DeviceError
from .devices.registry import DeviceRegistry
from .devices.store import ConfigStore
from .errors import ApiError, error_response
from .events import EventBroker
from .group_address import GroupAddressError, GroupAddressPolicy, parse_group_address
from .hosts import HostPolicy
from .knx import GatewayTarget, KnxError, KnxService, KnxStatus, gateway_allowed, now_iso
from .security import PairingManager, Session, SessionStore, SlidingWindowLimiter, format_code
from .stt import MAX_AUDIO_BYTES, SttClient

log = logging.getLogger("se7enx.api")
audit = logging.getLogger("se7enx.audit")

LIGHT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MAX_LIGHTS_PER_SESSION = 16
MAX_STREAMS_PER_SESSION = 3
MAX_STREAMS_TOTAL = 50
MAX_BODY_BYTES = 16 * 1024
# Endpoints that legitimately receive larger bodies (recorded voice commands).
BODY_LIMITS = {"/api/v1/assistant/transcribe": MAX_AUDIO_BYTES + 1024}
PING_INTERVAL_S = 15.0
IDEMPOTENCY_WINDOW_S = 120.0


# =============================================================================== errors


# =============================================================================== models


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PairRequest(_Strict):
    code: str = Field(min_length=4, max_length=40)
    clientName: str = Field(default="client", max_length=80)


class GatewayOverrideModel(_Strict):
    connectionType: Literal["tunneling", "tunneling_tcp", "routing"]
    host: str | None = Field(default=None, max_length=64)
    port: int = Field(default=3671, ge=1, le=65535)


class ConnectRequest(_Strict):
    override: GatewayOverrideModel | None = None


class TestRequest(_Strict):
    readAddress: str | None = Field(default=None, max_length=16)


class LightRequest(_Strict):
    switchAddress: str = Field(max_length=16)
    statusAddress: str | None = Field(default=None, max_length=16)
    dpt: Literal["1.001", "5.001"] = "1.001"
    onLevel: int = Field(default=100, ge=1, le=100)


class CommandRequest(_Strict):
    requestId: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    source: Literal["manual", "lamp", "keyboard", "gesture", "voice", "test"]


class EmptyBody(_Strict):
    pass


@dataclass
class LightConfig:
    id: str
    switch: str
    status: str | None
    dpt: str
    on_level: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "switchAddress": self.switch,
            "statusAddress": self.status,
            "dpt": self.dpt,
            "onLevel": self.on_level,
        }


# =============================================================================== middleware


class SecurityMiddleware:
    """Origin allowlist, CORS (incl. Private Network Access preflights), body size
    limit and security headers. Implemented as pure ASGI so streaming responses
    (SSE) are untouched."""

    ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS"
    ALLOW_HEADERS = "Authorization, Content-Type, Accept"

    def __init__(
        self,
        app: ASGIApp,
        allowed_origins: tuple[str, ...],
        hsts: bool,
        docs: bool,
        host_policy: HostPolicy | None = None,
    ) -> None:
        self.app = app
        self.allowed = {o.lower() for o in allowed_origins}
        self.hsts = hsts
        self.docs = docs
        self.host_policy = host_policy

    def _security_headers(self, h: MutableHeaders, path: str) -> None:
        h["X-Content-Type-Options"] = "nosniff"
        h.setdefault("Referrer-Policy", "no-referrer")
        h["X-Frame-Options"] = "DENY"
        h["Cross-Origin-Resource-Policy"] = "same-origin"
        h.setdefault("Cache-Control", "no-store")
        if not (self.docs and (path.startswith("/docs") or path.startswith("/openapi"))):
            # API responses get the strictest policy; UI pages set their own (see ui.py).
            h.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if self.hsts:
            h["Strict-Transport-Security"] = "max-age=31536000"

    def _origin_allowed(self, origin: str, host: str | None) -> bool:
        if origin.lower() in self.allowed:
            return True
        # Same-origin requests (the UI served by this hub). Only trusted when the Host header itself
        # was validated, otherwise DNS rebinding could make an attacker's page "same-origin".
        if self.host_policy is not None and host:
            netloc = urlsplit(origin).netloc.lower()
            return bool(netloc) and netloc == host.strip().lower()
        return False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        method = scope["method"]
        path = scope.get("path", "")

        host = headers.get("host")

        async def reply(resp: Response) -> None:
            self._security_headers(resp.headers, path)
            if origin and self._origin_allowed(origin, host):
                resp.headers["Access-Control-Allow-Origin"] = origin
                resp.headers["Vary"] = "Origin"
            await resp(scope, receive, send)

        if self.host_policy is not None and not self.host_policy.allows(host):
            log.warning("Rejected request with Host %r to %s %s", host, method, path)
            await reply(
                error_response(
                    421,
                    "HOST_NOT_ALLOWED",
                    "This host name is not allowed for the SE7ENX hub.",
                    "Open SE7ENX by its IP address, or add the host name to SE7ENX_ALLOWED_HOSTS.",
                )
            )
            return

        if origin is not None and not self._origin_allowed(origin, host):
            log.warning("Rejected request from origin %r to %s %s", origin, method, path)
            await reply(
                error_response(
                    403,
                    "ORIGIN_NOT_ALLOWED",
                    "This web origin is not allowed to use the bridge.",
                    f"Add {origin} to SE7ENX_ALLOWED_ORIGINS on the bridge if you trust it.",
                )
            )
            return

        if method == "OPTIONS" and "access-control-request-method" in headers:
            resp = Response(status_code=204)
            resp.headers["Access-Control-Allow-Methods"] = self.ALLOW_METHODS
            resp.headers["Access-Control-Allow-Headers"] = self.ALLOW_HEADERS
            resp.headers["Access-Control-Max-Age"] = "600"
            if headers.get("access-control-request-private-network") == "true":
                resp.headers["Access-Control-Allow-Private-Network"] = "true"
            await reply(resp)
            return

        if method in ("POST", "PUT", "PATCH"):
            cl = headers.get("content-length")
            if cl is None and headers.get("transfer-encoding"):
                await reply(error_response(411, "LENGTH_REQUIRED", "Content-Length is required."))
                return
            if cl is not None and (not cl.isdigit() or int(cl) > BODY_LIMITS.get(path, MAX_BODY_BYTES)):
                await reply(error_response(413, "PAYLOAD_TOO_LARGE", "Request body too large."))
                return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                self._security_headers(h, path)
                if origin:
                    h["Access-Control-Allow-Origin"] = origin
                    h.add_vary_header("Origin")
                    h["Access-Control-Expose-Headers"] = "Retry-After"
            await send(message)

        await self.app(scope, receive, send_wrapper)


# =============================================================================== app state


def default_adapter_factories(
    settings: Settings, store: ConfigStore, knx: KnxService, policy: GroupAddressPolicy
) -> dict[str, Callable[[AdapterCallbacks], DeviceAdapter]]:
    from .devices.adapters.homeassistant import HomeAssistantAdapter
    from .devices.adapters.knx import KnxDeviceAdapter
    from .devices.adapters.shelly import ShellyAdapter

    return {
        "shelly": lambda cb: ShellyAdapter(cb, settings, store),
        "homeassistant": lambda cb: HomeAssistantAdapter(cb, settings, store),
        "knx": lambda cb: KnxDeviceAdapter(cb, knx, policy),  # reuses the single xknx connection
    }


class BridgeState:
    def __init__(
        self,
        settings: Settings,
        knx: KnxService,
        adapter_factories: dict[str, Callable[[AdapterCallbacks], DeviceAdapter]] | None = None,
    ) -> None:
        self.settings = settings
        self.knx = knx
        self.broker = EventBroker()
        self.policy = GroupAddressPolicy(settings.allowed_group_addresses)
        self.store = ConfigStore(settings.data_dir)
        factories = default_adapter_factories(settings, self.store, knx, self.policy)
        factories.update(adapter_factories or {})
        self.registry = DeviceRegistry(settings, self.store, self.broker, factories)
        self.bridge_id = secrets.token_hex(6)
        # SE7ENX Core: identities, roles, audit ledger (created before the pairing manager announces its code)
        self.db = Database(settings.data_dir)
        self.identity = IdentityService(
            self.db,
            password_min_length=settings.password_min_length,
            session_ttl_s=settings.session_ttl_s,
            session_idle_s=settings.session_idle_s,
            remember_ttl_s=settings.remember_ttl_s,
            remember_idle_s=settings.remember_idle_s,
        )
        self.audit = AuditLog(self.db, settings.audit_retention_days)
        self.roles = RoleMatrix()
        self.pairing = PairingManager(settings.pairing_code, settings.pairing_ttl_s, on_new_code=self._announce_code)
        self.sessions = SessionStore(settings.session_ttl_s, settings.max_sessions)
        self.pair_limiter = SlidingWindowLimiter(5, 60.0)
        self.cmd_limiter = SlidingWindowLimiter(settings.command_limit, settings.command_window_s)
        self.global_cmd_limiter = SlidingWindowLimiter(settings.global_command_limit, 10.0)
        self.read_limiter = SlidingWindowLimiter(10, 10.0)
        self.discover_limiter = SlidingWindowLimiter(2, 10.0)
        self.connect_limiter = SlidingWindowLimiter(6, 60.0)
        self.streams: dict[str, int] = {}
        self.auth = Auth(self.identity, lambda: self.roles, self.sessions, self.audit)
        self.building = BuildingService(self.store, self.registry)
        self.commissioning = CommissioningService(self.db)
        knx.on_status(lambda st: self.broker.publish("knx.status", st.to_dict()))
        knx.on_value(lambda ga, gv: self.broker.publish("ga.value", {"ga": ga}))

    def _announce_code(self, code: str) -> None:
        if self.identity.count_users() > 0:
            return  # accounts exist: pairing is disabled and the code has no use
        ttl = (
            "fixed via SE7ENX_PAIRING_CODE"
            if self.settings.pairing_code
            else f"valid {self.settings.pairing_ttl_s // 60} min, single use"
        )
        log.warning(
            "\n\n    ┌──────────────────────────────────────────────┐\n"
            "    │  SE7ENX setup / pairing code:  %-12s  │\n"
            "    │  %-44s│\n"
            "    └──────────────────────────────────────────────┘\n",
            format_code(code),
            ttl,
        )

    def light_state(self, light: LightConfig) -> dict[str, Any]:
        address = light.status or light.switch
        gv = self.knx.values.get(address)
        if gv is None:
            return {"lightId": light.id, "value": "unknown", "via": "none", "at": None, "payload": None}
        if gv.kind == "response":
            via = "read_response"
        else:
            via = "status_address" if light.status else "switch_address"
        return {
            "lightId": light.id,
            "value": decode_on_off(light, gv.payload),
            "via": via,
            "at": gv.at,
            "payload": gv.payload,
        }


def decode_on_off(light: LightConfig, payload: int | list[int]) -> str:
    v: int | None
    if isinstance(payload, list):
        v = payload[0] if len(payload) == 1 else None
    else:
        v = payload
    if v is None:
        return "unknown"
    if light.dpt == "1.001":
        return "on" if v == 1 else "off" if v == 0 else "unknown"
    return "on" if 0 < v <= 255 else "off" if v == 0 else "unknown"


def encode_command(light: LightConfig, on: bool) -> DPTBinary | DPTArray:
    if light.dpt == "1.001":
        return DPTBinary(1 if on else 0)
    return DPTArray((round(light.on_level * 255 / 100) if on else 0,))


def iso_from_epoch(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


# =============================================================================== app factory


def create_app(
    settings: Settings,
    knx: KnxService | None = None,
    adapter_factories: dict[str, Callable[[AdapterCallbacks], DeviceAdapter]] | None = None,
    assistant: LlmInterpreter | None = None,
    speech: SttClient | None = None,
) -> FastAPI:
    knx_service = knx or KnxService(settings)
    state = BridgeState(settings, knx_service, adapter_factories)
    interpreter = assistant or LlmInterpreter(settings)
    stt = speech or SttClient(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if not state.policy.configured:
            log.warning("SE7ENX_ALLOWED_GROUP_ADDRESSES is empty — every light command will be refused (default deny).")
        log.info("Allowed origins: %s", ", ".join(settings.allowed_origins))
        if interpreter.enabled:
            log.info(
                "AI intent provider enabled: model %s at %s (typed/spoken requests are sent to it)",
                interpreter.model,
                interpreter.host,
            )
        if stt.enabled:
            log.info(
                "Local speech recognition enabled: model %s at %s (recorded commands are sent to it)",
                stt.model,
                stt.host,
            )
        if settings.allowed_hosts is not None:
            log.info("Allowed hosts: %s (same-origin requests accepted)", ", ".join(settings.allowed_hosts))
        await knx_service.start()
        await state.registry.start()
        state.roles = RoleMatrix(state.store.config.roles)
        await apply_stored_interface(settings, knx_service, state.registry)
        if state.identity.count_users() == 0:
            log.warning(
                "No SE7ENX account exists yet: open the web app and create the owner account with the setup code."
            )
        state.audit.purge()

        async def rotate_codes() -> None:
            ticks = 0
            while True:
                await asyncio.sleep(30)
                state.pairing.current_code()  # rotates (and announces) expired random codes
                state.sessions.purge_expired()
                state.identity.purge_expired()
                ticks += 1
                if ticks % 2880 == 0:  # once a day
                    state.audit.purge()

        rotator = asyncio.create_task(rotate_codes())
        try:
            yield
        finally:
            rotator.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await rotator
            await state.registry.stop()
            await knx_service.stop()
            await interpreter.aclose()
            await stt.aclose()
            state.db.close()

    app = FastAPI(
        title="SE7ENX Bridge",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.enable_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.enable_docs else None,
    )
    app.state.bridge = state
    app.add_middleware(
        SecurityMiddleware,
        allowed_origins=settings.allowed_origins,
        hsts=settings.tls_mode == "files",  # no HSTS for the local CA (IP hosts, easy to switch off)
        docs=settings.enable_docs,
        host_policy=HostPolicy(settings.allowed_hosts) if settings.allowed_hosts is not None else None,
    )

    # ------------------------------------------------------------------ errors
    @app.exception_handler(ApiError)
    async def _api_error(_r: Request, e: ApiError) -> JSONResponse:
        return error_response(e.status, e.code, e.message, e.hint, e.retry_after)

    @app.exception_handler(KnxError)
    async def _knx_error(_r: Request, e: KnxError) -> JSONResponse:
        return error_response(e.status, e.code, e.message, e.hint)

    @app.exception_handler(DeviceError)
    async def _device_error(_r: Request, e: DeviceError) -> JSONResponse:
        return error_response(e.status, e.code, e.message, e.hint)

    for exc_type, handler in {**identity_exception_handlers(), **building_exception_handlers()}.items():
        app.add_exception_handler(exc_type, handler)

    @app.exception_handler(RequestValidationError)
    async def _validation(_r: Request, e: RequestValidationError) -> JSONResponse:
        first = e.errors()[0] if e.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        return error_response(
            422, "VALIDATION_ERROR", f"Invalid request{f' ({loc})' if loc else ''}: {first.get('msg', 'invalid')}"
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_r: Request, e: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(e.status_code, f"HTTP_{e.status_code}")
        return error_response(e.status_code, code, str(e.detail))

    @app.exception_handler(Exception)
    async def _unexpected(_r: Request, e: Exception) -> JSONResponse:
        log.exception("Unhandled error: %s", e)
        return error_response(500, "INTERNAL_ERROR", "Unexpected bridge error. See the bridge logs.")

    # ------------------------------------------------------------------ auth
    auth = state.auth
    require = auth.require
    require_session = require()
    need = {p: require(p) for p in PERMISSIONS}

    def limit(limiter: SlidingWindowLimiter, key: str, what: str) -> None:
        ok, retry = limiter.hit(key)
        if not ok:
            raise ApiError(
                429, "RATE_LIMITED", f"Too many {what}. Try again in {max(1, round(retry))} s.", retry_after=retry
            )

    def parse_ga(value: str, field: str) -> str:
        try:
            return parse_group_address(value).canonical
        except GroupAddressError as err:
            raise ApiError(422, "INVALID_GROUP_ADDRESS", f"{field}: {err.message}") from err

    def require_allowed(ga: str) -> None:
        if not state.policy.allows(ga):
            allowed = ", ".join(state.policy.patterns) or "nothing (SE7ENX_ALLOWED_GROUP_ADDRESSES is empty)"
            raise ApiError(
                403,
                "GA_NOT_ALLOWED",
                f"Group address {ga} is not permitted by this bridge.",
                f"Allowed: {allowed}. The installer can extend SE7ENX_ALLOWED_GROUP_ADDRESSES.",
            )

    def get_light(session: Session, light_id: str) -> LightConfig:
        light = session.lights.get(light_id)
        if not isinstance(light, LightConfig):
            raise ApiError(
                404,
                "LIGHT_NOT_FOUND",
                f"Light {light_id!r} is not configured in this session.",
                "Register it with PUT /api/v1/lights/{id}.",
            )
        return light

    r = APIRouter(prefix="/api/v1")

    # ------------------------------------------------------------------ public
    @r.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "se7enx-bridge",
            "version": __version__,
            "apiVersion": API_VERSION,
            "pairingRequired": not auth.accounts_enabled,
            "auth": {
                "mode": "accounts" if auth.accounts_enabled else "pairing",
                "setupRequired": not auth.accounts_enabled,
            },
        }

    @r.post("/pair")
    async def pair(body: PairRequest, request: Request) -> dict[str, Any]:
        ip = client_ip(request)
        limit(state.pair_limiter, ip, "pairing attempts")
        if auth.accounts_enabled:
            raise ApiError(
                403,
                "PAIRING_DISABLED",
                "Pairing is disabled because SE7ENX accounts are set up.",
                "Sign in with your SE7ENX account instead.",
            )
        locked = state.pairing.locked_for()
        if locked > 0:
            raise ApiError(
                429, "PAIRING_LOCKED", "Pairing is temporarily locked after repeated failures.", retry_after=locked
            )
        if not state.pairing.verify(body.code):
            await asyncio.sleep(0.25)
            raise ApiError(
                401,
                "PAIRING_FAILED",
                "The pairing code is wrong or has expired.",
                "Use the current code printed in the bridge console. Codes are single-use and rotate periodically.",
            )
        token, session = state.sessions.create(body.clientName.strip(), ip)
        log.info("Paired client %r from %s (session %s)", session.client_name, ip, session.id)
        return {"token": token, "expiresAt": iso_from_epoch(session.expires_at), "bridgeId": state.bridge_id}

    # ------------------------------------------------------------------ session
    @r.get("/session")
    async def session_info(session: Session = Depends(require_session)) -> dict[str, Any]:
        return {
            "session": {"clientName": session.client_name, "expiresAt": iso_from_epoch(session.expires_at)},
            "bridge": {"id": state.bridge_id, "name": settings.bridge_name, "version": __version__},
            "knx": knx_service.status.to_dict(),
            "policy": {
                "allowedGroupAddresses": list(state.policy.patterns),
                "supportedDpts": ["1.001", "5.001"],
                "clientGatewayOverride": settings.allow_client_gateway,
                "discovery": settings.enable_discovery,
            },
        }

    @r.post("/session/revoke", status_code=204)
    async def revoke(session: Session = Depends(require_session)) -> Response:
        if session.kind == "account":
            state.identity.revoke_session(session.id)
            auth.forget(session.id)
        else:
            state.sessions.revoke(session)
        log.info("Session %s (%s) revoked by client", session.id, session.client_name)
        return Response(status_code=204)

    # ------------------------------------------------------------------ knx
    @r.get("/knx/status")
    async def knx_status(_s: Session = Depends(need["integration.view"])) -> dict[str, Any]:
        return knx_service.status.to_dict()

    @r.post("/knx/connect")
    async def knx_connect(
        body: ConnectRequest | None = None, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        limit(state.connect_limiter, session.id, "connection attempts")
        target: GatewayTarget | None = None
        if body and body.override:
            o = body.override
            if not settings.allow_client_gateway:
                raise ApiError(
                    403,
                    "GATEWAY_OVERRIDE_DISABLED",
                    "This bridge does not accept KNX interface settings from the browser.",
                    "The interface is configured on the bridge (SE7ENX_KNX_*). Set SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG=true to allow it.",
                )
            if o.connectionType != "routing":
                if not o.host:
                    raise ApiError(422, "VALIDATION_ERROR", "Interface IP address is required for tunnelling.")
                if not gateway_allowed(o.host, settings.client_gateway_cidrs):
                    raise ApiError(
                        403,
                        "GATEWAY_NOT_ALLOWED",
                        f"{o.host} is not an IPv4 address inside the networks this bridge may contact.",
                        "Use the interface's private LAN IP. Allowed networks: "
                        + ", ".join(str(n) for n in settings.client_gateway_cidrs),
                    )
            target = GatewayTarget(o.connectionType, o.host if o.connectionType != "routing" else None, o.port)
            audit.info("client %s requested KNX connection override %s", session.client_name, target)
        status: KnxStatus = await knx_service.connect(target)
        return status.to_dict()

    @r.post("/knx/disconnect")
    async def knx_disconnect(session: Session = Depends(need["integration.configure"])) -> dict[str, Any]:
        audit.info("client %s disconnected the KNX link", session.client_name)
        return (await knx_service.disconnect()).to_dict()

    @r.post("/knx/discover")
    async def knx_discover(session: Session = Depends(need["integration.configure"])) -> dict[str, Any]:
        if not settings.enable_discovery:
            raise ApiError(403, "DISCOVERY_DISABLED", "Interface discovery is disabled on this bridge.")
        limit(state.discover_limiter, session.id, "discovery requests")
        return {"gateways": await knx_service.discover()}

    @r.post("/knx/test")
    async def knx_test(
        body: TestRequest | None = None, session: Session = Depends(need["integration.configure"])
    ) -> dict[str, Any]:
        """Connectivity self-test. Never writes to the bus (reads only if asked)."""
        checks: list[dict[str, Any]] = []
        st = knx_service.status
        checks.append(
            {
                "id": "link",
                "label": "KNX link",
                "ok": knx_service.connected,
                "detail": f"{st.connection_type} — {st.state}"
                + (f" as {st.local_address}" if st.local_address else ""),
            }
        )
        if knx_service.connected:
            ok, detail = await knx_service.gateway_description()
            checks.append({"id": "interface", "label": "Interface responds", "ok": ok, "detail": detail})
        checks.append(
            {
                "id": "policy",
                "label": "Group address policy",
                "ok": state.policy.configured,
                "detail": ("Allowed: " + ", ".join(state.policy.patterns))
                if state.policy.configured
                else "No group addresses allowed — set SE7ENX_ALLOWED_GROUP_ADDRESSES on the bridge.",
            }
        )
        if st.secure:
            checks.append(
                {
                    "id": "secure",
                    "label": "KNX Secure",
                    "ok": knx_service.connected,
                    "detail": "Secure session configured on the bridge.",
                }
            )
        if body and body.readAddress:
            ga = parse_ga(body.readAddress, "readAddress")
            require_allowed(ga)
            limit(state.read_limiter, session.id, "read requests")
            gv = await knx_service.read(ga)
            checks.append(
                {
                    "id": "read",
                    "label": f"Read {ga}",
                    "ok": gv is not None,
                    "detail": f"Answer {gv.payload} from {gv.source}"
                    if gv
                    else "No device answered (read flag may be disabled).",
                }
            )
        return {"ok": all(c["ok"] for c in checks), "checks": checks}

    # ------------------------------------------------------------------ lights
    @r.put("/lights/{light_id}")
    async def put_light(
        light_id: str, body: LightRequest, session: Session = Depends(need["device.configure"])
    ) -> dict[str, Any]:
        if not LIGHT_ID_RE.match(light_id):
            raise ApiError(422, "INVALID_LIGHT_ID", "Light id must be 1-32 lowercase letters, digits or dashes.")
        switch = parse_ga(body.switchAddress, "switchAddress")
        status_ga = parse_ga(body.statusAddress, "statusAddress") if body.statusAddress else None
        require_allowed(switch)
        if status_ga:
            require_allowed(status_ga)
        if light_id not in session.lights and len(session.lights) >= MAX_LIGHTS_PER_SESSION:
            raise ApiError(409, "TOO_MANY_LIGHTS", f"At most {MAX_LIGHTS_PER_SESSION} lights per session.")
        light = LightConfig(id=light_id, switch=switch, status=status_ga, dpt=body.dpt, on_level=body.onLevel)
        session.lights[light_id] = light
        audit.info(
            "client %s configured light %s: switch=%s status=%s dpt=%s",
            session.client_name,
            light_id,
            switch,
            status_ga,
            body.dpt,
        )
        return {"light": light.to_dict(), "state": state.light_state(light)}

    @r.get("/lights/{light_id}")
    async def get_light_config(light_id: str, session: Session = Depends(need["device.view"])) -> dict[str, Any]:
        light = get_light(session, light_id)
        return {"light": light.to_dict(), "state": state.light_state(light)}

    @r.delete("/lights/{light_id}", status_code=204)
    async def delete_light(light_id: str, session: Session = Depends(need["device.configure"])) -> Response:
        session.lights.pop(light_id, None)
        return Response(status_code=204)

    @r.get("/lights/{light_id}/state")
    async def light_state(
        light_id: str, refresh: bool = False, session: Session = Depends(need["device.view"])
    ) -> dict[str, Any]:
        light = get_light(session, light_id)
        if refresh:
            limit(state.read_limiter, session.id, "read requests")
            address = light.status or light.switch
            require_allowed(address)
            gv = await knx_service.read(address)
            if gv is not None:
                knx_service.values[address] = gv
        return state.light_state(light)

    async def _command(light_id: str, on: bool, body: CommandRequest, session: Session) -> dict[str, Any]:
        light = get_light(session, light_id)
        cached = session.recent_requests.get(body.requestId)
        if cached and time.monotonic() - cached[0] < IDEMPOTENCY_WINDOW_S:
            return cached[1]  # retried request: never send the telegram twice
        if state.registry.safety is not None:  # the hub emergency stop also covers the per-session light API
            raise ApiError(
                423,
                "SAFETY_STOP_ACTIVE",
                "The hub emergency stop is active.",
                "Resume control in the Devices tab once it is safe.",
            )
        limit(state.cmd_limiter, session.id, "commands")
        limit(state.global_cmd_limiter, "global", "commands on this bridge")
        require_allowed(light.switch)
        value = encode_command(light, on)
        try:
            outcome, confirmation = await knx_service.write(light.switch, value)
        except KnxError as err:
            audit.warning(
                "command light=%s ga=%s value=%s source=%s client=%s FAILED %s",
                light.id,
                light.switch,
                "on" if on else "off",
                body.source,
                session.client_name,
                err.code,
            )
            raise
        if outcome == "bus_confirmed":
            detail = "The KNX interface confirmed transmission on the bus (positive L_Data.con). Device state is reported separately via the status address."
        elif confirmation == "local":
            detail = "Sent via KNX IP routing (multicast). Routing provides no bus-level confirmation — rely on the status address."
        else:
            detail = "Handed to the KNX interface, but no confirmation frame was received."
        resp = {
            "requestId": body.requestId,
            "lightId": light.id,
            "value": "on" if on else "off",
            "outcome": outcome,
            "confirmation": confirmation,
            "detail": detail,
            "telegram": {
                "destination": light.switch,
                "payload": value.value if isinstance(value, DPTBinary) else list(value.value),
            },
            "at": now_iso(),
        }
        session.recent_requests[body.requestId] = (time.monotonic(), resp)
        if len(session.recent_requests) > 100:
            for k in list(session.recent_requests)[:50]:
                session.recent_requests.pop(k, None)
        state.broker.publish(
            "light.command",
            {"requestId": body.requestId, "lightId": light.id, "value": resp["value"], "outcome": outcome},
            session_id=session.id,
        )
        audit.info(
            "command light=%s ga=%s value=%s source=%s client=%s outcome=%s",
            light.id,
            light.switch,
            resp["value"],
            body.source,
            session.client_name,
            outcome,
        )
        return resp

    @r.post("/lights/{light_id}/on")
    async def light_on(
        light_id: str, body: CommandRequest, session: Session = Depends(need["device.control"])
    ) -> dict[str, Any]:
        return await _command(light_id, True, body, session)

    @r.post("/lights/{light_id}/off")
    async def light_off(
        light_id: str, body: CommandRequest, session: Session = Depends(need["device.control"])
    ) -> dict[str, Any]:
        return await _command(light_id, False, body, session)

    # ------------------------------------------------------------------ events
    @r.get("/events")
    async def events(request: Request, session: Session = Depends(need["device.view"])) -> StreamingResponse:
        if (
            state.streams.get(session.id, 0) >= MAX_STREAMS_PER_SESSION
            or sum(state.streams.values()) >= MAX_STREAMS_TOTAL
        ):
            raise ApiError(429, "TOO_MANY_STREAMS", "Too many open event streams.")
        sub = state.broker.subscribe()
        state.streams[session.id] = state.streams.get(session.id, 0) + 1

        def sse(event: str, data: dict[str, Any]) -> bytes:
            return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()

        async def stream() -> AsyncIterator[bytes]:
            try:
                yield sse("hello", {"bridgeId": state.bridge_id, "knx": knx_service.status.to_dict()})
                while True:
                    if not auth.is_active(session):
                        break
                    try:
                        ev = await asyncio.wait_for(sub.get(), timeout=PING_INTERVAL_S)
                    except TimeoutError:
                        if await request.is_disconnected():
                            break
                        yield sse("ping", {"t": now_iso()})
                        continue
                    if ev.type == "knx.status":
                        yield sse("knx.status", ev.data)
                    elif ev.type == "ga.value":
                        ga = ev.data["ga"]
                        for light in list(session.lights.values()):
                            if isinstance(light, LightConfig) and ga in (light.status or light.switch,):
                                yield sse("light.state", state.light_state(light))
                    elif ev.type == "light.command" and ev.session_id == session.id:
                        yield sse("light.command", ev.data)
                    elif ev.type in ("device.state", "device.removed", "integration.status", "safety"):
                        yield sse(ev.type, ev.data)  # hub-wide device events, visible to every session
            finally:
                sub.close()
                state.streams[session.id] = max(0, state.streams.get(session.id, 1) - 1)

        # no-transform: compressing proxies (e.g. `next start`, CDNs) must not buffer the stream
        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
        )

    app.include_router(r)
    app.include_router(
        build_auth_router(
            settings=settings,
            auth=auth,
            identity=state.identity,
            audit=state.audit,
            store=state.store,
            roles_ref=lambda: state.roles,
            pairing=state.pairing,
            pairing_sessions=state.sessions,
            limit=limit,
        )
    )
    app.include_router(
        build_building_router(auth=auth, building=state.building, registry=state.registry, audit=state.audit)
    )
    app.include_router(
        build_device_router(
            state.registry,
            auth,
            state.audit,
            limit,
            state.cmd_limiter,
            state.global_cmd_limiter,
            on_removed=state.commissioning.forget,  # evidence never outlives the device
        )
    )
    app.include_router(
        build_commissioning_router(
            auth=auth, registry=state.registry, commissioning=state.commissioning, ledger=state.audit, limit=limit
        )
    )
    app.include_router(build_knx_interface_router(settings, knx_service, state.registry, require, limit))
    app.include_router(build_assistant_router(interpreter, require, limit, stt))
    app.include_router(build_tls_router(settings))
    mount_setup_page(app, settings)

    if settings.ui_dir:
        from .ui import mount_ui

        mount_ui(app, settings.ui_dir)  # catch-all route: must be registered after the API routes
    else:

        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, Any]:
            return {"service": "se7enx-bridge", "api": "/api/v1", "health": "/api/v1/health"}

    return app
