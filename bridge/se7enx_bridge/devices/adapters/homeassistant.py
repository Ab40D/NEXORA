"""Home Assistant integration, server-side. The access token never reaches the browser.

The hub opens HA's WebSocket API (``/api/websocket``) with a long-lived access token taken from
``SE7ENX_HA_TOKEN`` / ``SE7ENX_HA_TOKEN_FILE`` or from ``secrets.json`` (set through the hub UI).
It then:

* authenticates (``auth_required`` -> ``auth`` -> ``auth_ok`` / ``auth_invalid``);
* loads entity states (``get_states``) and follows ``state_changed`` events;
* calls services (``call_service``) **only for entities explicitly added as devices** (server-side
  allowlist, unlike the legacy browser path);
* reports a command as *confirmed* only when HA reports the new entity state.

Reconnects use back-off. A rejected token is **not** retried until the configuration changes:
HA can ban IPs after repeated failed logins, and an expired or revoked token will not start
working by itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import ssl
import time
from typing import Any

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidURI

from ...config import Settings
from ..model import (
    Capability,
    CommandResult,
    DeviceCommand,
    DeviceConfig,
    DeviceError,
    HomeAssistantDevice,
    expected_state,
    state_matches,
)
from ..store import ConfigStore, HomeAssistantSettings
from .base import DeviceAdapter, IntegrationState, IntegrationStatus, error_info

log = logging.getLogger("se7enx.homeassistant")

RECONNECT_DELAYS_S = (1, 2, 5, 10, 30, 60)
CALL_TIMEOUT_S = 10.0
CONFIRM_TIMEOUT_S = 5.0
MAX_MESSAGE_BYTES = 32 * 2**20  # get_states of a large installation can be several MB
SUPPORTED_DOMAINS = ("light", "switch", "input_boolean", "cover", "sensor", "binary_sensor")
_SENSOR_CLASSES = {
    "temperature": Capability.TEMPERATURE,
    "humidity": Capability.HUMIDITY,
    "illuminance": Capability.ILLUMINANCE,
    "power": Capability.POWER,
    "energy": Capability.ENERGY,
}
_DEFAULT_TYPE = {
    "light": "light",
    "switch": "switch",
    "input_boolean": "switch",
    "cover": "cover",
    "sensor": "sensor",
    "binary_sensor": "sensor",
}


class _AuthFailed(Exception):
    pass


# =============================================================================== mapping


def entity_capabilities(entity_id: str, st: dict[str, Any]) -> frozenset[Capability]:
    domain = entity_id.split(".", 1)[0]
    attrs = st.get("attributes") or {}
    caps: set[Capability] = set()
    if domain == "light":
        caps.add(Capability.ON_OFF)
        modes = attrs.get("supported_color_modes") or []
        if any(m != "onoff" for m in modes) or (not modes and isinstance(attrs.get("brightness"), int | float)):
            caps.add(Capability.BRIGHTNESS)
    elif domain in ("switch", "input_boolean"):
        caps.add(Capability.ON_OFF)
    elif domain == "cover":
        sf = int(attrs.get("supported_features") or 0)  # CoverEntityFeature: OPEN 1, CLOSE 2, SET_POSITION 4, STOP 8
        if sf & 1 and sf & 2:
            caps.add(Capability.OPEN_CLOSE)
        if sf & 4:
            caps.add(Capability.POSITION)
        if sf & 8:
            caps.add(Capability.STOP)
    elif domain == "sensor":
        caps.add(_SENSOR_CLASSES.get(str(attrs.get("device_class")), Capability.VALUE))
    elif domain == "binary_sensor":
        caps.add(Capability.BINARY)
    return frozenset(caps)


def entity_state(entity_id: str, st: dict[str, Any]) -> dict[str, Any]:
    domain = entity_id.split(".", 1)[0]
    state = st.get("state")
    attrs = st.get("attributes") or {}
    if state in (None, "unknown", "unavailable"):
        return {}
    if domain == "light":
        out: dict[str, Any] = {"on": state == "on"}
        if Capability.BRIGHTNESS in entity_capabilities(entity_id, st):
            b = attrs.get("brightness")
            out["brightness"] = round(b * 100 / 255) if state == "on" and isinstance(b, int | float) else 0
        return out
    if domain in ("switch", "input_boolean", "binary_sensor"):
        return {"on": state == "on"}
    if domain == "cover":
        out = {"moving": state if state in ("opening", "closing") else "stopped", "coverState": state}
        if isinstance(attrs.get("current_position"), int | float):
            out["position"] = int(attrs["current_position"])  # HA: 100 = open, same as SE7ENX
        return out
    if domain == "sensor":
        try:
            value: Any = float(state)
        except (TypeError, ValueError):
            value = str(state)[:64]
        out = {"value": value}
        if attrs.get("unit_of_measurement"):
            out["unit"] = str(attrs["unit_of_measurement"])[:12]
        return out
    return {}


def service_for(entity_id: str, cmd: DeviceCommand) -> tuple[str, dict[str, Any]]:
    domain = entity_id.split(".", 1)[0]
    c, p = cmd.command, cmd.params
    if domain in ("light", "switch", "input_boolean") and c in ("turn_on", "turn_off", "toggle"):
        return c, {}
    if domain == "light" and c == "set_brightness":
        return ("turn_off", {}) if p["brightness"] == 0 else ("turn_on", {"brightness_pct": p["brightness"]})
    if domain == "cover":
        if c in ("open", "close", "stop"):
            return f"{c}_cover", {}
        if c == "set_position":
            return "set_cover_position", {"position": p["position"]}
    raise DeviceError("UNSUPPORTED_COMMAND", f"'{c}' is not supported for {entity_id}.", status=400)


# =============================================================================== adapter


class HomeAssistantAdapter(DeviceAdapter):
    integration = "homeassistant"

    def __init__(self, callbacks: Any, settings: Settings, store: ConfigStore) -> None:
        super().__init__(callbacks)
        self.settings = settings
        self.store = store
        self._task: asyncio.Task[None] | None = None
        self._ws: ClientConnection | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._states: dict[str, dict[str, Any]] = {}
        self._devices: dict[str, HomeAssistantDevice] = {}
        self._by_entity: dict[str, list[str]] = {}
        self._waiters: dict[str, list[tuple[dict[str, Any], asyncio.Future[bool]]]] = {}
        self._reconfigured = asyncio.Event()
        self._state: IntegrationState = "not_configured"
        self._detail = "Home Assistant is not configured"
        self._last_success: float | None = None
        self._last_error: dict[str, str] | None = None
        self._ha_version: str | None = None

    # ------------------------------------------------------------------ configuration

    def config(self) -> tuple[str | None, str | None, bool, str]:
        if self.settings.ha_url:
            return self.settings.ha_url, self.settings.ha_token, self.settings.ha_verify_tls, "environment"
        ha = self.store.config.homeassistant
        return ha.url, self.store.ha_token(), ha.verify_tls, "stored"

    def config_json(self) -> dict[str, Any]:
        url, token, verify, source = self.config()
        return {
            "url": url,
            "verifyTls": verify,
            "tokenStored": bool(token),
            "source": source,
            "readOnly": source == "environment",
        }

    async def configure(self, url: str, token: str | None, verify_tls: bool) -> None:
        if self.settings.ha_url:
            raise DeviceError(
                "HA_CONFIGURED_BY_ENV", "Home Assistant is configured through environment variables.", status=409
            )
        if not token and not self.store.ha_token():
            raise DeviceError(
                "HA_TOKEN_REQUIRED",
                "A long-lived access token is required.",
                hint="Create one in Home Assistant: Profile -> Security.",
                status=400,
            )
        self.store.config.homeassistant = HomeAssistantSettings(url=url, verify_tls=verify_tls)
        if token:
            self.store.set_ha_token(token)
        self.store.save()
        await self._restart_session()

    async def unconfigure(self) -> None:
        if self.settings.ha_url:
            raise DeviceError(
                "HA_CONFIGURED_BY_ENV", "Home Assistant is configured through environment variables.", status=409
            )
        self.store.config.homeassistant = HomeAssistantSettings()
        self.store.set_ha_token(None)
        self.store.save()
        await self._restart_session()

    async def _restart_session(self) -> None:
        self._reconfigured.set()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self._task = asyncio.create_task(self._supervise(), name="homeassistant-supervisor")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()

    def _set(self, state: IntegrationState, detail: str, error: dict[str, str] | None = None) -> None:
        self._state, self._detail = state, detail
        if error is not None:
            self._last_error = error
        elif state == "connected":
            self._last_error = None
        self.cb.integration_changed(self.integration)

    def _mark_devices(self, status: str, error: dict[str, str] | None) -> None:
        for dev_id in self._devices:
            self.cb.device_connection(dev_id, status, error)  # type: ignore[arg-type]

    async def _wait_reconfigured(self, wait_s: float | None) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._reconfigured.wait(), timeout=wait_s)
        self._reconfigured.clear()

    async def _supervise(self) -> None:
        attempt = 0
        while True:
            url, token, verify, _source = self.config()
            if not url or not token:
                self._set("not_configured", "Home Assistant URL and access token are not configured")
                self._mark_devices("error", error_info("HA_NOT_CONFIGURED", "Home Assistant is not configured"))
                await self._wait_reconfigured(None)
                attempt = 0
                continue
            self._set("connecting", f"Connecting to {url}")
            connected_at = time.monotonic()
            try:
                await self._session(url, token, verify)
                err = error_info("HA_DISCONNECTED", "Connection to Home Assistant closed")
                self._set("disconnected", "Connection to Home Assistant closed; reconnecting", err)
                self._mark_devices("offline", err)
            except _AuthFailed as auth_err:
                err = error_info("HA_AUTH_FAILED", f"Home Assistant rejected the access token ({auth_err})")
                self._set("auth_failed", "Access token rejected: update it in the hub settings", err)
                self._mark_devices("unauthorized", err)
                await self._wait_reconfigured(None)  # never hammer HA with a bad token
                attempt = 0
                continue
            except (OSError, TimeoutError, InvalidHandshake, InvalidURI, ConnectionClosed, ValueError) as conn_err:
                err = error_info("HA_UNREACHABLE", f"Cannot reach Home Assistant at {url}: {self._describe(conn_err)}")
                self._set("disconnected", f"Cannot reach Home Assistant at {url}", err)
                self._mark_devices("offline", err)
            if time.monotonic() - connected_at > 60:
                attempt = 0  # it was a long-lived session: start the back-off again
            delay = RECONNECT_DELAYS_S[min(attempt, len(RECONNECT_DELAYS_S) - 1)]
            attempt += 1
            await self._wait_reconfigured(delay)

    @staticmethod
    def _describe(err: BaseException) -> str:
        if isinstance(err, TimeoutError):
            return "timed out"
        if isinstance(err, ssl.SSLError):
            return f"TLS error ({err.reason or err.__class__.__name__})"
        return (str(err) or err.__class__.__name__)[:160]

    async def _open(self, url: str, verify: bool) -> ClientConnection:
        ws_url = url.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/api/websocket"
        kwargs: dict[str, Any] = {}
        if ws_url.startswith("wss://"):
            ctx = ssl.create_default_context()
            if not verify:  # self-signed certificate on the LAN, explicitly allowed by the operator
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            kwargs["ssl"] = ctx
        return await connect(
            ws_url,
            open_timeout=10,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
            max_size=MAX_MESSAGE_BYTES,
            proxy=None,  # never route LAN traffic (and the token) through an environment proxy
            **kwargs,
        )

    @staticmethod
    async def _handshake(ws: ClientConnection, token: str) -> str | None:
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if first.get("type") != "auth_required":
            raise ValueError("not a Home Assistant WebSocket endpoint")
        await ws.send(json.dumps({"type": "auth", "access_token": token}))
        result = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if result.get("type") == "auth_invalid":
            raise _AuthFailed(str(result.get("message") or "invalid token")[:160])
        if result.get("type") != "auth_ok":
            raise ValueError("unexpected authentication response from Home Assistant")
        return result.get("ha_version")

    async def _session(self, url: str, token: str, verify: bool) -> None:
        ws = await self._open(url, verify)
        try:
            self._ha_version = await self._handshake(ws, token)
            self._last_success = time.time()
            self._ws = ws
            reader = asyncio.create_task(self._reader(ws))
            try:
                states = await self._call({"type": "get_states"})
                self._states = {s["entity_id"]: s for s in states or [] if isinstance(s, dict) and "entity_id" in s}
                await self._call({"type": "subscribe_events", "event_type": "state_changed"})
                self._set("connected", f"Connected to Home Assistant {self._ha_version or ''}".strip())
                for entity_id in list(self._by_entity):
                    self._apply(entity_id)
                await reader
            finally:
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await reader
        finally:
            self._ws = None
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(DeviceError("HA_NOT_CONNECTED", "Home Assistant connection closed.", status=503))
            self._pending.clear()
            with contextlib.suppress(Exception):
                await ws.close()

    async def _reader(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                self._last_success = time.time()
                if msg.get("type") in ("result", "pong"):
                    fut = self._pending.pop(msg.get("id"), None)
                    if fut is not None and not fut.done():
                        fut.set_result(msg)
                elif msg.get("type") == "event":
                    ev = msg.get("event") or {}
                    if ev.get("event_type") == "state_changed":
                        data = ev.get("data") or {}
                        entity_id = data.get("entity_id")
                        if isinstance(entity_id, str):
                            new = data.get("new_state")
                            if isinstance(new, dict):
                                self._states[entity_id] = new
                            else:
                                self._states.pop(entity_id, None)
                            if entity_id in self._by_entity:
                                self._apply(entity_id)
        except ConnectionClosed:
            return

    async def _call(self, payload: dict[str, Any], wait_s: float = CALL_TIMEOUT_S) -> Any:
        ws = self._ws
        if ws is None:
            raise DeviceError("HA_NOT_CONNECTED", "Home Assistant is not connected.", hint=self._detail, status=503)
        mid = next(self._ids)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        try:
            await ws.send(json.dumps({**payload, "id": mid}))
            msg = await asyncio.wait_for(fut, timeout=wait_s)
        except TimeoutError as err:
            raise DeviceError("HA_TIMEOUT", "Home Assistant did not answer in time.", status=504) from err
        except ConnectionClosed as err:
            raise DeviceError("HA_NOT_CONNECTED", "Home Assistant connection closed.", status=503) from err
        finally:
            self._pending.pop(mid, None)
        if msg.get("type") == "result" and not msg.get("success", False):
            error = msg.get("error") or {}
            raise DeviceError(
                "HA_SERVICE_FAILED",
                f"Home Assistant refused the request: {str(error.get('message') or error.get('code') or 'error')[:200]}",
                status=502,
            )
        return msg.get("result")

    # ------------------------------------------------------------------ device mapping

    def _apply(self, entity_id: str) -> None:
        st = self._states.get(entity_id)
        for dev_id in self._by_entity.get(entity_id, []):
            if st is None:
                self.cb.device_connection(
                    dev_id, "error", error_info("HA_ENTITY_NOT_FOUND", f"{entity_id} does not exist in Home Assistant")
                )
                continue
            caps = entity_capabilities(entity_id, st)
            attrs = st.get("attributes") or {}
            diag = {"entityId": entity_id, "friendlyName": attrs.get("friendly_name"), "haVersion": self._ha_version}
            if st.get("state") == "unavailable":
                self.cb.device_connection(
                    dev_id,
                    "unavailable",
                    error_info("HA_ENTITY_UNAVAILABLE", f"{entity_id} is unavailable in Home Assistant"),
                    capabilities=caps,
                    diagnostics=diag,
                )
                continue
            self.cb.device_connection(
                dev_id,
                "online",
                capabilities=caps,
                model=f"Home Assistant {entity_id.split('.', 1)[0]}",
                diagnostics=diag,
            )
            reported = entity_state(entity_id, st)
            if reported:
                self.cb.device_state(dev_id, reported, "event")
            for want, fut in self._waiters.get(entity_id, []):
                if not fut.done() and state_matches(want, reported):
                    fut.set_result(True)

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        assert isinstance(device, HomeAssistantDevice)
        st = self._states.get(device.entity_id)
        return entity_capabilities(device.entity_id, st) if st else frozenset()

    async def sync(self, devices: list[DeviceConfig]) -> None:
        self._devices = {d.id: d for d in devices if isinstance(d, HomeAssistantDevice)}
        self._by_entity = {}
        for d in self._devices.values():
            self._by_entity.setdefault(d.entity_id, []).append(d.id)
        if self._ws is not None:
            for entity_id in self._by_entity:
                self._apply(entity_id)
        else:
            status = {"auth_failed": "unauthorized", "not_configured": "error"}.get(
                self._state, "offline" if self._state == "disconnected" else "unknown"
            )
            self._mark_devices(status, self._last_error)

    async def validate_new(self, device: DeviceConfig, credentials: dict[str, str] | None) -> DeviceConfig:
        assert isinstance(device, HomeAssistantDevice)
        if self._ws is None:
            raise DeviceError(
                "HA_NOT_CONNECTED", "Connect Home Assistant before adding its entities.", hint=self._detail, status=409
            )
        if device.entity_id not in self._states:
            raise DeviceError(
                "HA_ENTITY_NOT_FOUND", f"{device.entity_id} does not exist in Home Assistant.", status=404
            )
        return device

    def entities(self) -> list[dict[str, Any]]:
        out = []
        for entity_id, st in sorted(self._states.items()):
            domain = entity_id.split(".", 1)[0]
            if domain not in SUPPORTED_DOMAINS:
                continue
            attrs = st.get("attributes") or {}
            out.append(
                {
                    "entityId": entity_id,
                    "name": str(attrs.get("friendly_name") or entity_id)[:64],
                    "domain": domain,
                    "state": st.get("state"),
                    "suggestedType": _DEFAULT_TYPE[domain],
                    "capabilities": sorted(c.value for c in entity_capabilities(entity_id, st)),
                    "added": entity_id in self._by_entity,
                }
            )
        return out[:2000]

    async def test(self, url: str | None, token: str | None, verify: bool) -> dict[str, Any]:
        stored_url, stored_token, stored_verify, _ = self.config()
        url, token = url or stored_url, token or stored_token
        if not url or not token:
            raise DeviceError("HA_NOT_CONFIGURED", "Enter the Home Assistant URL and an access token.", status=400)
        try:
            ws = await self._open(url, verify if url else stored_verify)
        except (OSError, TimeoutError, InvalidHandshake, InvalidURI, ValueError) as err:
            raise DeviceError(
                "HA_UNREACHABLE", f"Cannot reach Home Assistant at {url}: {self._describe(err)}", status=502
            ) from err
        try:
            version = await self._handshake(ws, token)
            await ws.send(json.dumps({"id": 1, "type": "get_config"}))
            cfg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            result = cfg.get("result") or {}
            return {"ok": True, "version": version, "locationName": result.get("location_name")}
        except _AuthFailed as err:
            raise DeviceError("HA_AUTH_FAILED", "Home Assistant rejected the access token.", status=400) from err
        except (TimeoutError, ValueError, ConnectionClosed) as err:
            raise DeviceError(
                "HA_UNREACHABLE", f"Home Assistant handshake failed: {self._describe(err)}", status=502
            ) from err
        finally:
            with contextlib.suppress(Exception):
                await ws.close()

    # ------------------------------------------------------------------ commands

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        assert isinstance(device, HomeAssistantDevice)
        if self._ws is None:
            raise DeviceError("HA_NOT_CONNECTED", "Home Assistant is not connected.", hint=self._detail, status=503)
        entity_id = device.entity_id
        service, data = service_for(entity_id, cmd)
        before = entity_state(entity_id, self._states.get(entity_id) or {})
        want = expected_state(cmd, before)
        fut: asyncio.Future[bool] | None = None
        if want:
            fut = asyncio.get_running_loop().create_future()
            self._waiters.setdefault(entity_id, []).append((want, fut))
        try:
            await self._call(
                {
                    "type": "call_service",
                    "domain": entity_id.split(".", 1)[0],
                    "service": service,
                    "service_data": data,
                    "target": {"entity_id": entity_id},
                }
            )
            if fut is None:
                return CommandResult("accepted", "service_call_ok", "Home Assistant accepted the service call.")
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout=CONFIRM_TIMEOUT_S)
                return CommandResult("confirmed", "service_call_ok", "Home Assistant reported the new state.")
            except TimeoutError:
                return CommandResult(
                    "accepted",
                    "service_call_ok",
                    "Home Assistant accepted the call but has not reported the new state yet.",
                )
        finally:
            if fut is not None:
                waiters = self._waiters.get(entity_id, [])
                self._waiters[entity_id] = [w for w in waiters if w[1] is not fut]
                if not fut.done():
                    fut.cancel()

    # ------------------------------------------------------------------ status

    def status(self) -> IntegrationStatus:
        url, _token, _verify, source = self.config()
        return IntegrationStatus(
            "homeassistant",
            self._state,
            self._detail,
            self._last_success,
            self._last_error,
            {"url": url, "source": source, "haVersion": self._ha_version, "entities": len(self._states)},
        )
