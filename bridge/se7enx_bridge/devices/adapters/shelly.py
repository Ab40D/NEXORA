"""Shelly integration over the documented local APIs (no cloud).

* **Gen1**: HTTP API: ``GET /shelly`` (identity), ``/status``, ``/settings``, ``/relay/N``,
  ``/light/N``, ``/roller/N``; optional HTTP Basic auth.
* **Gen2+** (Plus, Pro, Gen3, Gen4): JSON-RPC over ``POST /rpc``; optional digest auth (SHA-256,
  user ``admin``, realm = device id). ``/shelly`` is always unauthenticated.

Capabilities are derived from what the device actually reports (``Shelly.GetStatus`` / ``/status``
and ``Shelly.ListMethods``). Nothing is assumed from the model name: no power reading unless the
device reports power, no positioning unless the cover is calibrated, no dimming unless the method
exists. Commands are confirmed by reading the status back, never by the HTTP response alone.

Only explicitly entered local addresses are contacted (``hosts.check_device_host``); there is no
network scanning.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx2

from ...config import Settings
from ...hosts import DeviceHostError, check_device_host, ip_literal
from ..model import (
    Capability,
    CommandResult,
    DeviceCommand,
    DeviceConfig,
    DeviceError,
    ShellyDevice,
    expected_state,
    state_matches,
)
from ..store import ConfigStore
from .base import DeviceAdapter, IntegrationStatus, error_info

log = logging.getLogger("se7enx.shelly")

TransportFactory = Callable[[str], httpx2.AsyncBaseTransport]
REQUEST_TIMEOUT_S = 5.0
MAX_BACKOFF_S = 60.0
SUPPORTED_COMPONENTS = ("switch", "light", "cover")


# =============================================================================== client


class ShellyClient:
    """Minimal async client for one Shelly device (Gen1 HTTP or Gen2+ RPC)."""

    def __init__(
        self,
        address: str,
        *,
        gen: int | None = None,
        username: str | None = None,
        password: str | None = None,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self.address = address
        self.gen = gen
        self.username = username
        self.password = password
        host = f"[{address}]" if ":" in address and ip_literal(address) is not None else address
        self._http = httpx2.AsyncClient(
            base_url=f"http://{host}", transport=transport, timeout=httpx2.Timeout(REQUEST_TIMEOUT_S)
        )
        self._ids = itertools.count(1)

    async def close(self) -> None:
        await self._http.aclose()

    def _auth(self) -> httpx2.Auth | None:
        if not self.password:
            return None
        if self.gen is not None and self.gen >= 2:
            return httpx2.DigestAuth("admin", self.password)  # Gen2+: user is always "admin"
        return httpx2.BasicAuth(self.username or "admin", self.password)

    async def _request(self, method: str, path: str, *, auth: bool = True, **kw: Any) -> httpx2.Response:
        try:
            return await self._http.request(method, path, auth=self._auth() if auth else None, **kw)
        except httpx2.TimeoutException as err:
            raise DeviceError(
                "SHELLY_TIMEOUT",
                f"Shelly at {self.address} did not answer in time.",
                hint="Is the device powered and on this network?",
                status=504,
            ) from err
        except httpx2.TransportError as err:
            raise DeviceError(
                "SHELLY_UNREACHABLE",
                f"Cannot reach the Shelly at {self.address}.",
                hint="Check the IP address and that SE7ENX can reach that network.",
                status=503,
            ) from err

    @staticmethod
    def _json(resp: httpx2.Response, what: str) -> Any:
        try:
            return resp.json()
        except ValueError as err:
            raise DeviceError("SHELLY_BAD_RESPONSE", f"Unexpected response to {what} (not JSON).", status=502) from err

    def _check_status(self, resp: httpx2.Response, what: str) -> None:
        if resp.status_code == 401:
            raise DeviceError(
                "SHELLY_AUTH_FAILED",
                "The Shelly rejected the credentials." if self.password else "The Shelly requires a password.",
                hint="Enter the device password (Gen2+: user 'admin').",
                status=502,  # not 401: that would look like an expired SE7ENX session to the UI
            )
        if resp.status_code == 429:
            raise DeviceError(
                "SHELLY_THROTTLED",
                "The Shelly is throttling requests (too many failed logins?).",
                hint="Wait a few minutes.",
                status=503,
            )
        if resp.status_code == 404:
            raise DeviceError("UNSUPPORTED_ON_DEVICE", f"This Shelly does not support {what}.", status=400)
        if resp.status_code >= 400:
            detail = ""
            with contextlib.suppress(ValueError):
                body = resp.json()
                detail = str(body.get("error") or body.get("message") or "") if isinstance(body, dict) else ""
            raise DeviceError("SHELLY_ERROR", f"Shelly refused {what}{f': {detail}' if detail else ''}.", status=400)

    async def identity(self) -> dict[str, Any]:
        resp = await self._request("GET", "/shelly", auth=False)
        self._check_status(resp, "GET /shelly")
        body = self._json(resp, "GET /shelly")
        if not isinstance(body, dict) or not ("gen" in body or "type" in body):
            raise DeviceError("NOT_A_SHELLY", f"{self.address} does not look like a Shelly device.", status=400)
        return body

    async def rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        frame = {"id": next(self._ids), "method": method, "params": params or {}}
        resp = await self._request("POST", "/rpc", json=frame)
        if resp.status_code in (401, 429):
            self._check_status(resp, method)
        body = self._json(resp, method)
        if not isinstance(body, dict):
            raise DeviceError("SHELLY_BAD_RESPONSE", f"Unexpected response to {method}.", status=502)
        if "error" in body and isinstance(body["error"], dict):
            code, msg = body["error"].get("code"), str(body["error"].get("message", ""))
            if code in (404, -114):
                raise DeviceError(
                    "UNSUPPORTED_ON_DEVICE", f"This Shelly does not support {method}.", hint=msg, status=400
                )
            if code == -105:
                raise DeviceError("SHELLY_COMPONENT_NOT_FOUND", msg or "Component not found on the device.", status=400)
            if code == -109:
                raise DeviceError("SHELLY_PRECONDITION_FAILED", msg or "The device refused (precondition).", status=409)
            if code == -103:
                raise DeviceError("SHELLY_INVALID_ARGUMENT", msg or "Invalid argument.", status=400)
            raise DeviceError("SHELLY_RPC_ERROR", f"{method} failed: {msg or code}", status=502)
        self._check_status(resp, method)
        # Real devices answer with "result"; some documentation examples show "params".
        return body.get("result", body.get("params"))

    async def gen1(self, path: str, params: dict[str, Any] | None = None) -> Any:
        resp = await self._request("GET", path, params=params)
        self._check_status(resp, f"GET {path}")
        return self._json(resp, f"GET {path}")

    async def status(self) -> dict[str, Any]:
        data = await self.rpc("Shelly.GetStatus") if (self.gen or 1) >= 2 else await self.gen1("/status")
        if not isinstance(data, dict):
            raise DeviceError("SHELLY_BAD_RESPONSE", "Status is not an object.", status=502)
        return data


# =============================================================================== capability detection + state parsing


@dataclass
class ShellyChannel:
    component: str  # switch | light | cover
    channel: int
    capabilities: frozenset[Capability]
    state: dict[str, Any]

    def suggested_type(self) -> str:
        if self.component == "cover":
            return "cover"
        if self.component == "light":
            return "light"
        return "outlet" if Capability.POWER in self.capabilities else "switch"


@dataclass
class ShellyIdentity:
    address: str
    gen: int
    model: str
    shelly_id: str
    mac: str | None
    firmware: str | None
    app: str | None
    auth_required: bool
    profile: str | None
    channels: list[ShellyChannel] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "host": self.address,
            "gen": self.gen,
            "model": self.model,
            "shellyId": self.shelly_id,
            "mac": self.mac,
            "firmware": self.firmware,
            "app": self.app,
            "authRequired": self.auth_required,
            "profile": self.profile,
            "channels": [
                {
                    "component": c.component,
                    "channel": c.channel,
                    "capabilities": sorted(x.value for x in c.capabilities),
                    "suggestedType": c.suggested_type(),
                    "state": c.state,
                }
                for c in self.channels
            ],
            "unsupportedComponents": self.unsupported,
        }


def _metering(st: dict[str, Any]) -> set[Capability]:
    caps: set[Capability] = set()
    if isinstance(st.get("apower"), int | float):
        caps.add(Capability.POWER)
    if isinstance(st.get("aenergy"), dict) and isinstance(st["aenergy"].get("total"), int | float):
        caps.add(Capability.ENERGY)
    return caps


def gen2_channels(status: dict[str, Any], methods: set[str] | None) -> tuple[list[ShellyChannel], list[str]]:
    def allowed(m: str) -> bool:
        return methods is None or m in methods

    channels: list[ShellyChannel] = []
    unsupported: list[str] = []
    for key, st in sorted(status.items()):
        if ":" not in key or not isinstance(st, dict):
            continue
        comp, _, idx = key.partition(":")
        if not idx.isdigit():
            continue
        caps: set[Capability] = set()
        if comp == "switch" and allowed("Switch.Set"):
            caps = {Capability.ON_OFF, *_metering(st)}
        elif comp == "light" and allowed("Light.Set"):
            caps = {Capability.ON_OFF, *_metering(st)}
            if isinstance(st.get("brightness"), int | float):
                caps.add(Capability.BRIGHTNESS)
            if all(allowed(m) for m in ("Light.DimUp", "Light.DimDown", "Light.DimStop")) and methods is not None:
                caps.add(Capability.DIM_RELATIVE)
        elif comp == "cover" and allowed("Cover.Open"):
            caps = {Capability.OPEN_CLOSE, Capability.STOP, *_metering(st)}
            if st.get("pos_control") is True and allowed("Cover.GoToPosition"):
                caps.add(Capability.POSITION)
        elif comp in ("input", "sys", "wifi", "cloud", "mqtt", "ble", "ws", "eth", "temperature", "humidity"):
            continue  # infrastructure or not (yet) exposed as devices
        else:
            unsupported.append(key)
            continue
        if caps:
            channels.append(ShellyChannel(comp, int(idx), frozenset(caps), gen2_state(comp, st)))
    return channels, unsupported


def gen2_state(component: str, st: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if component in ("switch", "light") and isinstance(st.get("output"), bool):
        out["on"] = st["output"]
    if component == "light" and isinstance(st.get("brightness"), int | float):
        out["brightness"] = int(st["brightness"])
    if component == "cover":
        state = st.get("state")
        out["moving"] = state if state in ("opening", "closing") else "stopped"
        if isinstance(state, str):
            out["coverState"] = state
        if isinstance(st.get("current_pos"), int | float):
            out["position"] = int(st["current_pos"])
        out["calibrated"] = st.get("pos_control") is True
    if isinstance(st.get("apower"), int | float):
        out["power"] = float(st["apower"])
    if isinstance(st.get("aenergy"), dict) and isinstance(st["aenergy"].get("total"), int | float):
        out["energy"] = round(float(st["aenergy"]["total"]), 3)  # Wh
    temp = st.get("temperature")
    if isinstance(temp, dict) and isinstance(temp.get("tC"), int | float):
        out["temperature"] = float(temp["tC"])
    if isinstance(st.get("errors"), list) and st["errors"]:
        out["errors"] = [str(e) for e in st["errors"]][:8]
    return out


def gen1_channels(model: str, status: dict[str, Any], mode: str | None) -> list[ShellyChannel]:
    meters = status.get("meters") if isinstance(status.get("meters"), list) else []
    channels: list[ShellyChannel] = []

    def meter_caps(i: int) -> set[Capability]:
        m = meters[i] if i < len(meters) and isinstance(meters[i], dict) else {}
        caps: set[Capability] = set()
        if isinstance(m.get("power"), int | float):
            caps.add(Capability.POWER)
        if isinstance(m.get("total"), int | float):
            caps.add(Capability.ENERGY)
        return caps

    if isinstance(status.get("relays"), list) and mode != "roller":
        for i, r in enumerate(status["relays"]):
            if isinstance(r, dict):
                caps = frozenset({Capability.ON_OFF, *meter_caps(i)})
                channels.append(ShellyChannel("switch", i, caps, gen1_state("switch", r, meters, i)))
    if isinstance(status.get("lights"), list):
        for i, li in enumerate(status["lights"]):
            if isinstance(li, dict):
                caps = {Capability.ON_OFF, *meter_caps(i)}
                if isinstance(li.get("brightness"), int | float):
                    caps.add(Capability.BRIGHTNESS)
                    if model.upper().startswith("SHDM"):  # Shelly Dimmer 1/2 support dim=up|down|stop
                        caps.add(Capability.DIM_RELATIVE)
                channels.append(ShellyChannel("light", i, frozenset(caps), gen1_state("light", li, meters, i)))
    if isinstance(status.get("rollers"), list) and mode in (None, "roller"):
        for i, ro in enumerate(status["rollers"]):
            if isinstance(ro, dict):
                caps = {Capability.OPEN_CLOSE, Capability.STOP, *meter_caps(i)}
                if ro.get("positioning") is True:
                    caps.add(Capability.POSITION)
                channels.append(ShellyChannel("cover", i, frozenset(caps), gen1_state("cover", ro, meters, i)))
    return channels


def gen1_state(component: str, st: dict[str, Any], meters: list[Any], index: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if component in ("switch", "light") and isinstance(st.get("ison"), bool):
        out["on"] = st["ison"]
    if component == "light" and isinstance(st.get("brightness"), int | float):
        out["brightness"] = int(st["brightness"])
    if component == "cover":
        # Gen1 "state" is the movement: open = opening, close = closing, stop = not moving
        out["moving"] = {"open": "opening", "close": "closing"}.get(str(st.get("state")), "stopped")
        out["calibrated"] = st.get("positioning") is True
        if st.get("positioning") is True and isinstance(st.get("current_pos"), int | float) and st["current_pos"] >= 0:
            out["position"] = int(st["current_pos"])
    m = meters[index] if index < len(meters) and isinstance(meters[index], dict) else {}
    power = m.get("power", st.get("power"))
    if isinstance(power, int | float):
        out["power"] = float(power)
    if isinstance(m.get("total"), int | float):
        out["energy"] = round(float(m["total"]) / 60.0, 3)  # Gen1 meters report watt-minutes -> Wh
    return out


async def identify(client: ShellyClient) -> ShellyIdentity:
    info = await client.identity()
    if "gen" in info and isinstance(info["gen"], int) and info["gen"] >= 2:
        client.gen = info["gen"]
        status = await client.status()
        methods: set[str] | None = None
        with contextlib.suppress(DeviceError):
            listed = await client.rpc("Shelly.ListMethods")
            if isinstance(listed, dict) and isinstance(listed.get("methods"), list):
                methods = {str(m) for m in listed["methods"]}
        channels, unsupported = gen2_channels(status, methods)
        return ShellyIdentity(
            address=client.address,
            gen=info["gen"],
            model=str(info.get("model") or "Shelly"),
            shelly_id=str(info.get("id") or info.get("mac") or client.address),
            mac=info.get("mac"),
            firmware=info.get("ver") or info.get("fw_id"),
            app=info.get("app"),
            auth_required=bool(info.get("auth_en")),
            profile=info.get("profile"),
            channels=channels,
            unsupported=unsupported,
        )
    client.gen = 1
    status = await client.status()
    mode = info.get("mode") if isinstance(info.get("mode"), str) else None
    if mode is None and isinstance(status.get("rollers"), list) and isinstance(status.get("relays"), list):
        with contextlib.suppress(DeviceError):
            settings = await client.gen1("/settings")
            mode = settings.get("mode") if isinstance(settings, dict) else None
    unsupported = [k for k in ("emeters", "adcs", "ext_temperature") if k in status]
    model = str(info.get("type") or "Shelly Gen1")
    return ShellyIdentity(
        address=client.address,
        gen=1,
        model=model,
        shelly_id=f"shelly-{str(info.get('mac', client.address)).lower()}",
        mac=info.get("mac"),
        firmware=info.get("fw"),
        app=None,
        auth_required=bool(info.get("auth")),
        profile=mode,
        channels=gen1_channels(model, status, mode),
        unsupported=unsupported,
    )


# =============================================================================== adapter


@dataclass
class _Host:
    address: str
    client: ShellyClient
    devices: dict[str, ShellyDevice] = field(default_factory=dict)  # device id -> config
    task: asyncio.Task[None] | None = None
    last_success: float | None = None
    last_error: dict[str, str] | None = None
    failures: int = 0
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    methods: set[str] | None = None  # Gen2+: allowed RPC methods (None = unknown)
    methods_checked: bool = False


class ShellyAdapter(DeviceAdapter):
    integration = "shelly"

    def __init__(
        self,
        callbacks: Any,
        settings: Settings,
        store: ConfigStore,
        transport_factory: TransportFactory | None = None,
    ) -> None:
        super().__init__(callbacks)
        self.settings = settings
        self.store = store
        self.transport_factory = transport_factory
        self.hosts: dict[str, _Host] = {}
        self._caps: dict[str, frozenset[Capability]] = {}
        self._states: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------ helpers

    def _client(self, address: str, gen: int | None, creds: dict[str, str]) -> ShellyClient:
        transport = self.transport_factory(address) if self.transport_factory else None
        return ShellyClient(
            address, gen=gen, username=creds.get("username"), password=creds.get("password"), transport=transport
        )

    async def _address(self, host: str) -> str:
        try:
            return await check_device_host(host)
        except DeviceHostError as err:
            raise DeviceError("INVALID_DEVICE_HOST", err.message, hint=err.hint, status=400) from err

    async def identify(self, host: str, username: str | None = None, password: str | None = None) -> dict[str, Any]:
        address = await self._address(host)
        client = self._client(address, None, {"username": username or "", "password": password or ""})
        try:
            return (await identify(client)).to_dict()
        finally:
            await client.close()

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        assert isinstance(device, ShellyDevice)
        known = self._caps.get(device.id)
        if known is not None:
            return known
        return frozenset(
            {
                "switch": {Capability.ON_OFF},
                "light": {Capability.ON_OFF},
                "cover": {Capability.OPEN_CLOSE, Capability.STOP},
            }[device.component]
        )

    async def validate_new(self, device: DeviceConfig, credentials: dict[str, str] | None) -> DeviceConfig:
        assert isinstance(device, ShellyDevice)
        creds = credentials or {}
        if creds.get("username") and device.gen >= 2 and creds["username"] != "admin":
            raise DeviceError(
                "SHELLY_INVALID_USERNAME", "Gen2+ Shelly devices always use the user 'admin'.", status=400
            )
        ident = await self.identify(device.host, creds.get("username"), creds.get("password"))
        match = next(
            (c for c in ident["channels"] if c["component"] == device.component and c["channel"] == device.channel),
            None,
        )
        if match is None:
            available = ", ".join(f"{c['component']}:{c['channel']}" for c in ident["channels"]) or "none"
            raise DeviceError(
                "SHELLY_CHANNEL_NOT_FOUND",
                f"This Shelly has no {device.component} channel {device.channel}.",
                hint=f"Available channels: {available}.",
                status=400,
            )
        if ident["authRequired"] and not creds.get("password"):
            raise DeviceError("SHELLY_AUTH_FAILED", "The Shelly requires a password.", status=400)
        return device.model_copy(
            update={"gen": ident["gen"], "model": ident["model"][:64], "shelly_id": ident["shellyId"][:64]}
        )

    # ------------------------------------------------------------------ lifecycle

    async def stop(self) -> None:
        for h in list(self.hosts.values()):
            await self._drop_host(h)
        self.hosts.clear()

    async def _drop_host(self, h: _Host) -> None:
        if h.task is not None:
            h.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await h.task
        await h.client.close()

    async def sync(self, devices: list[DeviceConfig]) -> None:
        wanted: dict[str, list[ShellyDevice]] = {}
        for d in devices:
            assert isinstance(d, ShellyDevice)
            wanted.setdefault(d.host, []).append(d)
        for host in [h for h in self.hosts if h not in wanted]:
            await self._drop_host(self.hosts.pop(host))
        for host, devs in wanted.items():
            creds = next(
                (
                    self.store.device_secret(d.id)
                    for d in sorted(devs, key=lambda x: x.id)
                    if self.store.device_secret(d.id)
                ),
                {},
            )
            gen = devs[0].gen
            existing = self.hosts.get(host)
            if (
                existing is not None
                and (existing.client.password or "") == creds.get("password", "")
                and existing.client.gen == gen
            ):
                existing.devices = {d.id: d for d in devs}
                existing.wake.set()
                continue
            if existing is not None:
                await self._drop_host(existing)
            try:
                address = await self._address(host)
            except DeviceError as err:
                for d in devs:
                    self.cb.device_connection(d.id, "error", error_info(err.code, err.message))
                continue
            h = _Host(address=address, client=self._client(address, gen, creds), devices={d.id: d for d in devs})
            self.hosts[host] = h
            h.task = asyncio.create_task(self._poll(h), name=f"shelly-poll-{host}")

    def _interval(self, h: _Host) -> float:
        custom = [d.poll_interval_s for d in h.devices.values() if d.poll_interval_s]
        return float(min(custom) if custom else self.settings.shelly_poll_s)

    async def _poll(self, h: _Host) -> None:
        while True:
            try:
                await self._refresh_host(h)
                h.failures = 0
                delay = self._interval(h)
            except DeviceError as err:
                h.failures += 1
                h.last_error = error_info(err.code, err.message)
                status = "unauthorized" if err.code == "SHELLY_AUTH_FAILED" else "offline"
                for d in h.devices.values():
                    self.cb.device_connection(d.id, status, h.last_error)
                self.cb.integration_changed(self.integration)
                delay = min(MAX_BACKOFF_S, self._interval(h) * 2 ** min(h.failures, 5))
            except Exception as err:  # pragma: no cover - defensive: never kill the poller
                log.exception("Shelly poll failed for %s", h.address)
                h.last_error = error_info("SHELLY_ERROR", str(err)[:200])
                delay = MAX_BACKOFF_S
            h.wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(h.wake.wait(), timeout=delay)

    async def _refresh_host(self, h: _Host) -> dict[str, dict[str, Any]]:
        status = await h.client.status()
        if (h.client.gen or 1) >= 2:
            if not h.methods_checked:
                h.methods_checked = True
                with contextlib.suppress(DeviceError):
                    listed = await h.client.rpc("Shelly.ListMethods")
                    if isinstance(listed, dict) and isinstance(listed.get("methods"), list):
                        h.methods = {str(m) for m in listed["methods"]}
            channels, _unsupported = gen2_channels(status, h.methods)
        else:
            mode = None
            if isinstance(status.get("rollers"), list) and isinstance(status.get("relays"), list):
                mode = "roller" if any(d.component == "cover" for d in h.devices.values()) else "relay"
            channels = gen1_channels(next((d.model or "" for d in h.devices.values()), ""), status, mode)
        by_key = {(c.component, c.channel): c for c in channels}
        h.last_success = time.time()
        h.last_error = None
        states: dict[str, dict[str, Any]] = {}
        for d in h.devices.values():
            ch = by_key.get((d.component, d.channel))
            if ch is None:
                self.cb.device_connection(
                    d.id,
                    "error",
                    error_info(
                        "SHELLY_CHANNEL_NOT_FOUND", f"{d.component}:{d.channel} no longer reported by the device"
                    ),
                )
                continue
            self._caps[d.id] = ch.capabilities
            self._states[d.id] = states[d.id] = ch.state
            self.cb.device_connection(
                d.id,
                "online",
                capabilities=ch.capabilities,
                model=d.model,
                diagnostics={"host": d.host, "gen": h.client.gen, "component": f"{d.component}:{d.channel}"},
            )
            self.cb.device_state(d.id, ch.state, "poll")
        self.cb.integration_changed(self.integration)
        return states

    async def refresh(self, device: DeviceConfig) -> None:
        h = self.hosts.get(getattr(device, "host", ""))
        if h is not None:
            await self._refresh_host(h)

    # ------------------------------------------------------------------ commands

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        assert isinstance(device, ShellyDevice)
        h = self.hosts.get(device.host)
        if h is None:
            raise DeviceError("DEVICE_NOT_READY", "The Shelly connection is not set up yet.", status=409)
        c, p, n = cmd.command, cmd.params, device.channel
        want = expected_state(cmd, dict(self._states.get(device.id, {})))
        if (h.client.gen or 1) >= 2:
            ns = {"switch": "Switch", "light": "Light", "cover": "Cover"}[device.component]
            if c in ("turn_on", "turn_off"):
                await h.client.rpc(f"{ns}.Set", {"id": n, "on": c == "turn_on"})
            elif c == "toggle":
                await h.client.rpc(f"{ns}.Toggle", {"id": n})
            elif c == "set_brightness":
                b = p["brightness"]
                await h.client.rpc(
                    "Light.Set", {"id": n, "on": False} if b == 0 else {"id": n, "on": True, "brightness": b}
                )
            elif c == "dim":
                method = {"up": "Light.DimUp", "down": "Light.DimDown", "stop": "Light.DimStop"}[p["direction"]]
                await h.client.rpc(method, {"id": n})
            elif c in ("open", "close", "stop"):
                await h.client.rpc(f"Cover.{c.capitalize()}", {"id": n})
            elif c == "set_position":
                await h.client.rpc("Cover.GoToPosition", {"id": n, "pos": p["position"]})
        else:
            if device.component == "switch":
                await h.client.gen1(
                    f"/relay/{n}", {"turn": {"turn_on": "on", "turn_off": "off", "toggle": "toggle"}[c]}
                )
            elif device.component == "light":
                if c in ("turn_on", "turn_off", "toggle"):
                    await h.client.gen1(
                        f"/light/{n}", {"turn": {"turn_on": "on", "turn_off": "off", "toggle": "toggle"}[c]}
                    )
                elif c == "set_brightness":
                    b = p["brightness"]
                    await h.client.gen1(f"/light/{n}", {"turn": "off"} if b == 0 else {"turn": "on", "brightness": b})
                elif c == "dim":
                    q = (
                        {"dim": "stop"}
                        if p["direction"] == "stop"
                        else {"dim": p["direction"], "step": p.get("step", 10)}
                    )
                    await h.client.gen1(f"/light/{n}", q)
            else:
                q = {"go": {"open": "open", "close": "close", "stop": "stop"}.get(c, "to_pos")}
                if c == "set_position":
                    q["roller_pos"] = p["position"]
                await h.client.gen1(f"/roller/{n}", q)
        # Verify with the device's own status report (an HTTP 200 alone proves nothing).
        try:
            after = (await self._refresh_host(h)).get(device.id, {})
        except DeviceError:
            return CommandResult(
                "accepted", "http_ok", "The Shelly accepted the command; reading back its status failed."
            )
        h.wake.set()
        if want and state_matches(want, after):
            return CommandResult("confirmed", "http_ok", "The Shelly reports the requested state.")
        detail = "Command accepted; the device has not reported the final state yet."
        if device.component == "cover":
            detail = "Movement started; position will update as the device reports progress."
        return CommandResult("accepted", "http_ok", detail)

    # ------------------------------------------------------------------ status

    def status(self) -> IntegrationStatus:
        if not self.hosts:
            return IntegrationStatus("shelly", "not_configured", "No Shelly devices added")
        failing = [h for h in self.hosts.values() if h.failures]
        last = max((h.last_success for h in self.hosts.values() if h.last_success), default=None)
        err = next((h.last_error for h in failing if h.last_error), None)
        if not failing:
            state, detail = "connected", f"{len(self.hosts)} device(s) reachable"
        elif len(failing) == len(self.hosts):
            state, detail = "disconnected", f"{len(failing)} device(s) unreachable"
        else:
            state, detail = "degraded", f"{len(failing)} of {len(self.hosts)} device(s) unreachable"
        return IntegrationStatus("shelly", state, detail, last, err, {"devices": len(self.hosts)})
