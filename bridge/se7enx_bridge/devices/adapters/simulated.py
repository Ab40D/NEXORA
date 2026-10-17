"""Simulated devices: for demos, the sample configuration and tests. Never touch hardware."""

from __future__ import annotations

import time
from typing import Any

from ..model import Capability, CommandResult, DeviceCommand, DeviceConfig, DeviceError, SimulatedDevice
from .base import DeviceAdapter, IntegrationStatus

_CAPS: dict[str, frozenset[Capability]] = {
    "light": frozenset({Capability.ON_OFF, Capability.BRIGHTNESS, Capability.DIM_RELATIVE}),
    "switch": frozenset({Capability.ON_OFF}),
    "outlet": frozenset({Capability.ON_OFF, Capability.POWER, Capability.ENERGY}),
    "cover": frozenset({Capability.OPEN_CLOSE, Capability.STOP, Capability.POSITION}),
}
_SENSOR_CAPS = {
    "temperature": (Capability.TEMPERATURE, 21.5, "°C"),
    "humidity": (Capability.HUMIDITY, 45.0, "%"),
    "illuminance": (Capability.ILLUMINANCE, 320.0, "lx"),
}


def sample_devices() -> list[SimulatedDevice]:
    """Demo set used by SE7ENX_SAMPLE_DEVICES=true (clearly marked as simulated everywhere)."""
    return [
        SimulatedDevice(
            integration="simulated", id="sim-living-light", name="Living room light (simulated)", type="light"
        ),
        SimulatedDevice(integration="simulated", id="sim-desk-outlet", name="Desk outlet (simulated)", type="outlet"),
        SimulatedDevice(
            integration="simulated", id="sim-bedroom-blind", name="Bedroom blind (simulated)", type="cover"
        ),
        SimulatedDevice(
            integration="simulated",
            id="sim-hall-temperature",
            name="Hall temperature (simulated)",
            type="sensor",
            sensor_kind="temperature",
        ),
    ]


class SimulatedAdapter(DeviceAdapter):
    integration = "simulated"

    def __init__(self, callbacks: Any) -> None:
        super().__init__(callbacks)
        self._state: dict[str, dict[str, Any]] = {}
        self._energy_t: dict[str, float] = {}

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        assert isinstance(device, SimulatedDevice)
        if device.type == "sensor":
            return frozenset({_SENSOR_CAPS[device.sensor_kind or "temperature"][0]})
        return _CAPS[device.type]

    def _initial(self, device: SimulatedDevice) -> dict[str, Any]:
        if device.type == "light":
            return {"on": False, "brightness": 0}
        if device.type == "outlet":
            return {"on": False, "power": 0.0, "energy": 0.0}
        if device.type == "cover":
            return {"position": 100, "moving": "stopped"}
        if device.type == "sensor":
            _cap, value, unit = _SENSOR_CAPS[device.sensor_kind or "temperature"]
            return {"value": value, "unit": unit}
        return {"on": False}

    async def sync(self, devices: list[DeviceConfig]) -> None:
        ids = {d.id for d in devices}
        for gone in [k for k in self._state if k not in ids]:
            self._state.pop(gone, None)
        for d in devices:
            assert isinstance(d, SimulatedDevice)
            if d.id not in self._state:
                self._state[d.id] = self._initial(d)
            self.cb.device_connection(
                d.id, "online", capabilities=self.capabilities(d), model="SE7ENX simulated device"
            )
            self.cb.device_state(d.id, dict(self._state[d.id]), "simulated")

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        s = self._state.get(device.id)
        if s is None:
            raise DeviceError("DEVICE_NOT_READY", "Simulated device is not initialised.", status=409)
        c, p = cmd.command, cmd.params
        if c in ("turn_on", "turn_off", "toggle"):
            on = {"turn_on": True, "turn_off": False}.get(c, not s.get("on", False))
            s["on"] = on
            if "brightness" in s:
                s["brightness"] = (s["brightness"] or 100) if on else 0
            if "power" in s:
                s["power"] = 42.0 if on else 0.0
        elif c == "set_brightness":
            s["brightness"] = p["brightness"]
            s["on"] = p["brightness"] > 0
        elif c == "dim":
            if p["direction"] != "stop":
                delta = p.get("step", 25) * (1 if p["direction"] == "up" else -1)
                s["brightness"] = max(0, min(100, int(s.get("brightness", 0)) + delta))
                s["on"] = s["brightness"] > 0
        elif c in ("open", "close", "set_position"):
            s["position"] = {"open": 100, "close": 0}.get(c, p.get("position", s.get("position", 0)))
            s["moving"] = "stopped"
        elif c == "stop":
            s["moving"] = "stopped"
        if "energy" in s:
            now = time.monotonic()
            last = self._energy_t.get(device.id, now)
            s["energy"] = round(s["energy"] + s.get("power", 0.0) * (now - last) / 3600, 4)
            self._energy_t[device.id] = now
        self.cb.device_state(device.id, dict(s), "simulated")
        return CommandResult("simulated", "simulated", "Simulated device updated. No hardware was involved.")

    def status(self) -> IntegrationStatus:
        return IntegrationStatus("simulated", "connected", f"{len(self._state)} simulated device(s)", time.time())
