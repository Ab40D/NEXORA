"""Device registry: configuration, runtime state and the command policy for every integration.

Every device command passes the same gates, in this order:

1. the device supports the command (capability check; sensors are read-only);
2. real devices: the hub emergency stop is not active;
3. real devices: control was explicitly enabled for this device (with an acknowledgement);
4. real devices: the device is reachable;
5. per-device minimum interval between commands (protects relays and motors);
6. one command in flight per device, bounded by a timeout.

Requested state is recorded separately and cleared only when the device *reports* a matching
state. A protocol acknowledgement alone is never treated as proof that the device changed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from ..config import Settings
from ..events import EventBroker
from .adapters.base import AdapterCallbacks, DeviceAdapter
from .adapters.simulated import SimulatedAdapter, sample_devices
from .model import (
    COMMAND_CAPABILITY,
    READ_ONLY_TYPES,
    Capability,
    ConnectionState,
    DeviceCommand,
    DeviceConfig,
    DeviceError,
    DevicePatch,
    DeviceRuntime,
    commands_for,
    expected_state,
    state_matches,
)
from .store import ConfigStore

log = logging.getLogger("se7enx.devices")
audit = logging.getLogger("se7enx.audit")

COMMAND_TIMEOUT_S = 12.0
MAX_DEVICES = 500

AdapterFactory = Callable[[AdapterCallbacks], DeviceAdapter]


def _iso(ts: float | None) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None


class DeviceRegistry:
    def __init__(
        self,
        settings: Settings,
        store: ConfigStore,
        broker: EventBroker,
        adapter_factories: dict[str, AdapterFactory] | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.broker = broker
        self.runtime: dict[str, DeviceRuntime] = {}
        self.safety: dict[str, Any] | None = None
        self._busy: set[str] = set()
        factories: dict[str, AdapterFactory] = {"simulated": SimulatedAdapter}
        factories.update(adapter_factories or {})
        self.adapters: dict[str, DeviceAdapter] = {name: f(self) for name, f in factories.items()}

    # ------------------------------------------------------------------ adapter callbacks

    def device_state(self, device_id: str, reported: dict[str, Any], source: str) -> None:
        rt = self.runtime.get(device_id)
        if rt is None:
            return
        rt.reported = {**rt.reported, **reported}
        rt.reported_at = rt.last_seen = time.time()
        rt.reported_source = source
        if rt.requested and state_matches(rt.requested, rt.reported):
            rt.requested = None  # the device confirmed what was asked for
        self._publish(device_id)

    def device_connection(
        self,
        device_id: str,
        status: ConnectionState,
        error: dict[str, str] | None = None,
        *,
        capabilities: frozenset[Capability] | None = None,
        model: str | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        rt = self.runtime.get(device_id)
        if rt is None:
            return
        rt.connection = status
        if status == "online":
            rt.last_seen = time.time()
            rt.last_error = None
        elif error:
            rt.last_error = error
        if capabilities is not None:
            rt.capabilities = capabilities
        if model:
            rt.model = model
        if diagnostics:
            rt.diagnostics = {**rt.diagnostics, **diagnostics}
        self._publish(device_id)

    def integration_changed(self, name: str) -> None:
        adapter = self.adapters.get(name)
        if adapter is not None:
            self.broker.publish("integration.status", adapter.status().to_dict())

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.store.load()
        if self.settings.sample_devices and not self.store.config.devices:
            for d in sample_devices():
                self.store.put_device(d)
            self.store.save()
            log.info("Added %d simulated sample devices (SE7ENX_SAMPLE_DEVICES=true).", len(sample_devices()))
        for d in self.store.config.devices:
            self.runtime[d.id] = self._new_runtime(d)
        for adapter in self.adapters.values():
            await adapter.start()
        for name in self.adapters:
            await self._sync(name)
        missing = {d.integration for d in self.store.config.devices} - set(self.adapters)
        for d in self.store.config.devices:
            if d.integration in missing:
                self.device_connection(
                    d.id, "error", {"code": "INTEGRATION_UNAVAILABLE", "message": "Integration not available"}
                )

    async def stop(self) -> None:
        for adapter in self.adapters.values():
            try:
                await adapter.stop()
            except Exception:  # pragma: no cover - best effort shutdown
                log.exception("adapter %s failed to stop", adapter.integration)

    def _new_runtime(self, d: DeviceConfig) -> DeviceRuntime:
        adapter = self.adapters.get(d.integration)
        return DeviceRuntime(capabilities=adapter.capabilities(d) if adapter else frozenset())

    async def _sync(self, integration: str) -> None:
        adapter = self.adapters.get(integration)
        if adapter is not None:
            await adapter.sync([d for d in self.store.config.devices if d.integration == integration])
            self.integration_changed(integration)

    # ------------------------------------------------------------------ queries

    def _get(self, device_id: str) -> DeviceConfig:
        cfg = self.store.find(device_id)
        if cfg is None:
            raise DeviceError("DEVICE_NOT_FOUND", f"No device with id {device_id!r}.", status=404)
        return cfg

    def device_json(self, device_id: str) -> dict[str, Any]:
        cfg = self._get(device_id)
        rt = self.runtime.setdefault(device_id, self._new_runtime(cfg))
        simulated = cfg.integration == "simulated"
        caps = rt.capabilities
        commands = [] if cfg.type in READ_ONLY_TYPES else commands_for(caps)
        control_enabled = simulated or cfg.control_enabled
        details = cfg.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
            exclude={"id", "name", "type", "integration", "control_enabled", "hidden", "metadata"},
        )
        return {
            "id": cfg.id,
            "name": cfg.name,
            "type": cfg.type,
            "integration": cfg.integration,
            "simulated": simulated,
            "model": rt.model or getattr(cfg, "model", None),
            "capabilities": sorted(c.value for c in caps),
            "commands": commands,
            "controlEnabled": control_enabled,
            "controlAllowed": bool(commands) and control_enabled and (simulated or self.safety is None),
            "hidden": cfg.hidden,
            "metadata": cfg.metadata.model_dump(mode="json", by_alias=True, exclude_none=True),
            "connection": {"status": rt.connection, "lastSeen": _iso(rt.last_seen), "lastError": rt.last_error},
            "state": {
                "reported": rt.reported,
                "reportedAt": _iso(rt.reported_at),
                "source": rt.reported_source,
                "requested": rt.requested,
                "requestedAt": _iso(rt.requested_at),
                "pending": rt.requested is not None,
            },
            "config": details,
            "credentialsStored": bool(self.store.device_secret(cfg.id)),
            "diagnostics": rt.diagnostics,
        }

    def list_json(self) -> list[dict[str, Any]]:
        return [self.device_json(d.id) for d in self.store.config.devices]

    def integrations_json(self) -> list[dict[str, Any]]:
        return [a.status().to_dict() for a in self.adapters.values()]

    def safety_json(self) -> dict[str, Any]:
        return self.safety or {"active": False}

    def _publish(self, device_id: str) -> None:
        if self.store.find(device_id) is not None:
            self.broker.publish("device.state", self.device_json(device_id))

    # ------------------------------------------------------------------ configuration changes

    async def add(self, device: DeviceConfig, credentials: dict[str, str] | None, client: str) -> dict[str, Any]:
        if self.store.find(device.id) is not None:
            raise DeviceError("DEVICE_EXISTS", f"A device with id {device.id!r} already exists.", status=409)
        if len(self.store.config.devices) >= MAX_DEVICES:
            raise DeviceError("TOO_MANY_DEVICES", f"At most {MAX_DEVICES} devices are supported.", status=409)
        adapter = self.adapters.get(device.integration)
        if adapter is None:
            raise DeviceError(
                "INTEGRATION_UNAVAILABLE",
                f"The {device.integration} integration is not available on this hub.",
                status=400,
            )
        validate = getattr(adapter, "validate_new", None)
        if validate is not None:
            device = await validate(device, credentials)
        if device.integration != "simulated" and device.control_enabled:
            # Real hardware always starts read-only; enabling control is a separate, acknowledged step.
            device = device.model_copy(update={"control_enabled": False})
        self.store.put_device(device)
        self.store.set_device_secret(device.id, credentials)
        self.store.save()
        self.runtime[device.id] = self._new_runtime(device)
        await self._sync(device.integration)
        audit.info("client %r added %s device %r (%s)", client, device.integration, device.id, device.type)
        return self.device_json(device.id)

    async def update(self, device_id: str, patch: DevicePatch, client: str) -> dict[str, Any]:
        cfg = self._get(device_id)
        changes: dict[str, Any] = {}
        if patch.name is not None:
            changes["name"] = patch.name
        if patch.hidden is not None:
            changes["hidden"] = patch.hidden
        if patch.metadata is not None:
            changes["metadata"] = patch.metadata
        if patch.control_enabled is not None and cfg.integration != "simulated":
            if patch.control_enabled and not cfg.control_enabled and not patch.acknowledge_real_control:
                raise DeviceError(
                    "ACKNOWLEDGEMENT_REQUIRED",
                    "Enabling control of a real device requires confirming that it may switch real equipment.",
                    hint="Send acknowledgeRealControl: true after showing the warning to the user.",
                    status=400,
                )
            changes["control_enabled"] = patch.control_enabled
        if not changes:
            return self.device_json(device_id)
        data = cfg.model_dump(by_alias=False)
        data.update(changes)
        new = type(cfg).model_validate(data)
        self.store.put_device(new)
        self.store.save()
        if "control_enabled" in changes:
            audit.info(
                "client %r %s real control of device %r",
                client,
                "ENABLED" if changes["control_enabled"] else "disabled",
                device_id,
            )
        await self._sync(new.integration)
        self._publish(device_id)
        return self.device_json(device_id)

    async def remove(self, device_id: str, client: str) -> None:
        cfg = self._get(device_id)
        self.store.remove_device(device_id)
        self.store.save()
        self.runtime.pop(device_id, None)
        await self._sync(cfg.integration)
        self.broker.publish("device.removed", {"id": device_id})
        audit.info("client %r removed device %r", client, device_id)

    # ------------------------------------------------------------------ commands

    async def execute(self, device_id: str, cmd: DeviceCommand, client: str) -> dict[str, Any]:
        cfg = self._get(device_id)
        rt = self.runtime.setdefault(device_id, self._new_runtime(cfg))
        adapter = self.adapters.get(cfg.integration)
        cap = COMMAND_CAPABILITY[cmd.command]
        if adapter is None or cfg.type in READ_ONLY_TYPES or cap not in rt.capabilities:
            supported = ", ".join(commands_for(rt.capabilities)) if cfg.type not in READ_ONLY_TYPES else ""
            raise DeviceError(
                "UNSUPPORTED_COMMAND",
                f"{cfg.name} does not support '{cmd.command}'.",
                hint=f"Supported: {supported}" if supported else "This device is read-only.",
                status=400,
            )
        simulated = cfg.integration == "simulated"
        if not simulated:
            if self.safety is not None:
                raise DeviceError(
                    "SAFETY_STOP_ACTIVE",
                    "The hub emergency stop is active: real devices cannot be controlled.",
                    hint="Resume control once it is safe to do so.",
                    status=423,
                )
            if not cfg.control_enabled:
                raise DeviceError(
                    "CONTROL_NOT_ENABLED",
                    f"Control of {cfg.name} is not enabled.",
                    hint="Open the device settings, read the warning and enable real control.",
                    status=403,
                )
            if rt.connection in ("offline", "unauthorized", "unavailable", "error"):
                raise DeviceError(
                    "DEVICE_UNAVAILABLE",
                    f"{cfg.name} is {rt.connection}.",
                    hint=(rt.last_error or {}).get("message"),
                    status=503,
                )
        now = time.monotonic()
        gap = self.settings.device_min_interval_ms / 1000
        if now - rt.last_command_at < gap:
            raise DeviceError("DEVICE_RATE_LIMITED", "Commands for this device are too frequent.", status=429)
        if device_id in self._busy:
            raise DeviceError("DEVICE_BUSY", "A command for this device is still in progress.", status=409)
        self._busy.add(device_id)
        rt.last_command_at = now
        expected = expected_state(cmd, rt.reported)
        rt.requested = expected or None
        rt.requested_at = time.time()
        self._publish(device_id)
        try:
            result = await asyncio.wait_for(adapter.execute(cfg, cmd), timeout=COMMAND_TIMEOUT_S)
        except TimeoutError as err:
            rt.requested = None
            self._publish(device_id)
            raise DeviceError("DEVICE_TIMEOUT", f"{cfg.name} did not respond in time.", status=504) from err
        except DeviceError:
            rt.requested = None
            self._publish(device_id)
            raise
        finally:
            self._busy.discard(device_id)
        if result.outcome in ("confirmed", "simulated"):
            rt.requested = None
        audit.info(
            "device command device=%r command=%s source=%s client=%r outcome=%s delivery=%s",
            device_id,
            cmd.command,
            cmd.source,
            client,
            result.outcome,
            result.delivery,
        )
        self._publish(device_id)
        return {
            "outcome": result.outcome,
            "delivery": result.delivery,
            "detail": result.detail,
            "device": self.device_json(device_id),
        }

    async def refresh(self, device_id: str) -> dict[str, Any]:
        cfg = self._get(device_id)
        adapter = self.adapters.get(cfg.integration)
        if adapter is not None:
            await adapter.refresh(cfg)
        return self.device_json(device_id)

    # ------------------------------------------------------------------ safety

    def set_safety(self, active: bool, client: str) -> dict[str, Any]:
        if active and self.safety is None:
            self.safety = {"active": True, "since": _iso(time.time()), "by": client}
            audit.warning("client %r ACTIVATED the hub emergency stop", client)
        elif not active and self.safety is not None:
            self.safety = None
            audit.warning("client %r released the hub emergency stop", client)
        self.broker.publish("safety", self.safety_json())
        for d in self.store.config.devices:
            if d.integration != "simulated":
                self._publish(d.id)
        return self.safety_json()
