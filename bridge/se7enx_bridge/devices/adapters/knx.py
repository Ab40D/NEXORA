"""KNX devices with an explicit group-address / datapoint mapping, on the existing KnxService (xknx).

No second KNX stack: this adapter reuses the bridge's single xknx connection (tunnelling, KNX Secure,
routing) and its confirmation handling (positive ``L_Data.con`` = ``bus_confirmed``).

Datapoints:

* switch/outlet/light on-off: DPT 1.001 (``switch``), feedback on ``switchStatus``.
* light **absolute** brightness: DPT 5.001 (``brightness``), feedback on ``brightnessStatus``.
* light **relative** dimming: DPT 3.007 (``dim``): direction + step code (1 = 100 % i.e. dim until
  stop, ..., 7 = 1.56 %); step code 0 stops. Absolute and relative dimming are separate commands.
* cover: DPT 1.008 up/down (0 = up/open, 1 = down/close), ``stop`` trigger (writes 1), DPT 5.001
  position (KNX: 0 % = open, so SE7ENX's "100 = open" is inverted unless ``invertPosition`` is false).
* sensor: any DPT xknx can transcode (9.001 temperature, 9.004 lux, 9.007 humidity, 14.056 power...).

Only the group addresses configured for a device are written. If the operator configured
``SE7ENX_ALLOWED_GROUP_ADDRESSES``, device mappings must stay inside it. Initial state comes from
explicit GroupValueReads of the feedback addresses. A read without an answer leaves the state
unknown; the stale cache is never reused.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from xknx.dpt import DPTArray, DPTBase, DPTBinary
from xknx.dpt.dpt_3 import ControlDimming, DPTControlDimming, Step

from ...group_address import GroupAddressPolicy
from ...knx import GaValue, KnxError, KnxService, KnxStatus
from ..model import (
    Capability,
    CommandResult,
    DeviceCommand,
    DeviceConfig,
    DeviceError,
    KnxDevice,
    expected_state,
    state_matches,
)
from .base import DeviceAdapter, IntegrationStatus, error_info

log = logging.getLogger("se7enx.knx.devices")

CONFIRM_TIMEOUT_S = 3.0
_STEP_PERCENT = {1: 100.0, 2: 50.0, 3: 25.0, 4: 12.5, 5: 6.25, 6: 3.125, 7: 1.5625}
_SENSOR_CAPS = {
    "9.001": Capability.TEMPERATURE,
    "9.007": Capability.HUMIDITY,
    "9.004": Capability.ILLUMINANCE,
    "14.056": Capability.POWER,
    "9.024": Capability.POWER,
    "13.010": Capability.ENERGY,
    "13.013": Capability.ENERGY,
}
_DPT_UNITS = {
    "9.001": "°C",
    "9.007": "%",
    "9.004": "lx",
    "14.056": "W",
    "9.024": "kW",
    "13.010": "Wh",
    "13.013": "kWh",
    "5.001": "%",
}


def step_code_for(step_percent: int | None) -> int:
    """Map a step in percent to the closest DPT 3.007 step code (None -> 1 = dim until stop)."""
    if step_percent is None:
        return 1
    return min(_STEP_PERCENT, key=lambda code: abs(_STEP_PERCENT[code] - step_percent))


def _payload(gv: GaValue) -> DPTBinary | DPTArray:
    return DPTBinary(gv.payload) if isinstance(gv.payload, int) else DPTArray(tuple(gv.payload))


def _decode(dpt: str, gv: GaValue) -> Any:
    transcoder = DPTBase.parse_transcoder(dpt)
    if transcoder is None:
        raise ValueError(f"unsupported DPT {dpt}")
    value = transcoder.from_knx(_payload(gv))
    if hasattr(value, "value") and isinstance(value.value, bool):  # xknx enums such as Switch.ON
        return bool(value.value)
    return value


def _encode(dpt: str, value: Any) -> DPTBinary | DPTArray:
    transcoder = DPTBase.parse_transcoder(dpt)
    assert transcoder is not None
    return transcoder.to_knx(value)


class KnxDeviceAdapter(DeviceAdapter):
    integration = "knx"

    def __init__(self, callbacks: Any, knx: KnxService, policy: GroupAddressPolicy) -> None:
        super().__init__(callbacks)
        self.knx = knx
        self.policy = policy
        self._devices: dict[str, KnxDevice] = {}
        self._feedback: dict[str, list[tuple[str, str]]] = {}  # GA -> [(device id, role)]
        self._states: dict[str, dict[str, Any]] = {}
        self._waiters: dict[str, list[tuple[dict[str, Any], asyncio.Future[bool]]]] = {}
        self._last_value_at: float | None = None
        self._read_task: asyncio.Task[None] | None = None
        knx.on_value(self._on_value)
        knx.on_status(self._on_status)

    # ------------------------------------------------------------------ capabilities

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        assert isinstance(device, KnxDevice)
        caps: set[Capability] = set()
        if device.type in ("switch", "outlet", "light") and (device.switch or device.brightness):
            caps.add(Capability.ON_OFF)
        if device.type == "light":
            if device.brightness:
                caps.add(Capability.BRIGHTNESS)
            if device.dim:
                caps.add(Capability.DIM_RELATIVE)
        if device.type == "cover":
            if device.up_down or device.position:
                caps.add(Capability.OPEN_CLOSE)
            if device.stop:
                caps.add(Capability.STOP)
            if device.position:
                caps.add(Capability.POSITION)
        if device.type == "sensor" and device.value_dpt:
            dpt = device.value_dpt
            caps.add(_SENSOR_CAPS.get(dpt, Capability.BINARY if dpt.startswith("1.") else Capability.VALUE))
        return frozenset(caps)

    async def validate_new(self, device: DeviceConfig, credentials: dict[str, str] | None) -> DeviceConfig:
        assert isinstance(device, KnxDevice)
        if self.policy.configured:
            outside = sorted(a for a in device.all_addresses() if not self.policy.allows(a))
            if outside:
                raise DeviceError(
                    "GA_NOT_ALLOWED",
                    f"Group address(es) {', '.join(outside)} are outside SE7ENX_ALLOWED_GROUP_ADDRESSES.",
                    hint="Ask the installer to extend the allowlist on the hub, or correct the addresses.",
                    status=403,
                )
        return device

    # ------------------------------------------------------------------ lifecycle / sync

    async def stop(self) -> None:
        if self._read_task is not None:
            self._read_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._read_task

    async def sync(self, devices: list[DeviceConfig]) -> None:
        self._devices = {d.id: d for d in devices if isinstance(d, KnxDevice)}
        self._feedback = {}
        for d in self._devices.values():
            roles = {
                "switch_status": d.switch_status,
                "brightness_status": d.brightness_status,
                "position_status": d.position_status,
                "value": d.value,
            }
            if d.switch and not d.switch_status:
                roles["switch_observed"] = d.switch  # telegrams from other senders (wall switch)
            for role, ga in roles.items():
                if ga:
                    self._feedback.setdefault(ga, []).append((d.id, role))
        for gone in [k for k in self._states if k not in self._devices]:
            self._states.pop(gone, None)
        self._report_link(self.knx.status)
        if self.knx.connected:
            self._schedule_reads()

    def _schedule_reads(self) -> None:
        if self._read_task is not None and not self._read_task.done():
            self._read_task.cancel()
        self._read_task = asyncio.create_task(self._initial_reads(), name="knx-device-reads")

    async def _initial_reads(self) -> None:
        roles = ("switch_status", "brightness_status", "position_status", "value")
        targets = sorted({ga for ga, entries in self._feedback.items() if any(r in roles for _, r in entries)})
        for ga in targets:
            try:
                gv = await self.knx.read(ga, wait_s=2.0)
            except KnxError:
                return  # link dropped; reads are scheduled again on reconnect
            if gv is not None:
                self._on_value(ga, gv)
            await asyncio.sleep(0.05)  # be gentle with the bus

    # ------------------------------------------------------------------ feedback

    def _report_link(self, status: KnxStatus) -> None:
        if status.state == "connected":
            for d in self._devices.values():
                self.cb.device_connection(
                    d.id,
                    "online",
                    capabilities=self.capabilities(d),
                    model="KNX group-address mapping",
                    diagnostics={
                        "groupAddresses": sorted(d.all_addresses()),
                        "writable": sorted(d.writable_addresses()),
                    },
                )
        else:
            code, message = status.last_error or ("KNX_NOT_CONNECTED", f"KNX interface {status.state}")
            for d in self._devices.values():
                self.cb.device_connection(d.id, "offline", error_info(code, message))
        self.cb.integration_changed(self.integration)

    def _on_status(self, status: KnxStatus) -> None:
        self._report_link(status)
        if status.state == "connected" and self._devices:
            with contextlib.suppress(RuntimeError):  # no running loop (shutdown)
                self._schedule_reads()

    def _on_value(self, ga: str, gv: GaValue) -> None:
        entries = self._feedback.get(ga)
        if not entries:
            return
        self._last_value_at = time.time()
        for device_id, role in entries:
            d = self._devices.get(device_id)
            if d is None:
                continue
            try:
                update = self._decode_role(d, role, gv)
            except Exception:  # undecodable payload for this DPT: ignore, never guess
                log.debug("Ignoring undecodable %s telegram on %s for device %s", role, ga, device_id)
                continue
            if not update:
                continue
            state = self._states.setdefault(device_id, {})
            state.update(update)
            source = "bus_observed" if role == "switch_observed" else ("read" if gv.kind == "response" else "status")
            self.cb.device_state(device_id, update, source)
            for want, fut in self._waiters.get(device_id, []):
                if not fut.done() and state_matches(want, state):
                    fut.set_result(True)

    @staticmethod
    def _decode_role(d: KnxDevice, role: str, gv: GaValue) -> dict[str, Any]:
        if role in ("switch_status", "switch_observed"):
            return {"on": bool(_decode("1.001", gv))}
        if role == "brightness_status":
            level = round(float(_decode("5.001", gv)))
            return {"brightness": level, "on": level > 0}
        if role == "position_status":
            knx_pos = round(float(_decode("5.001", gv)))
            return {"position": 100 - knx_pos if d.invert_position else knx_pos}
        if role == "value" and d.value_dpt:
            value = _decode(d.value_dpt, gv)
            out: dict[str, Any] = {"value": value if isinstance(value, bool | int | float | str) else str(value)}
            unit = d.unit or _DPT_UNITS.get(d.value_dpt)
            if unit:
                out["unit"] = unit
            return out
        return {}

    # ------------------------------------------------------------------ commands

    def _writes(self, d: KnxDevice, cmd: DeviceCommand) -> list[tuple[str, DPTBinary | DPTArray]]:
        c, p = cmd.command, cmd.params
        if c in ("turn_on", "turn_off", "toggle"):
            if c == "toggle":
                current = self._states.get(d.id, {}).get("on")
                if current is None:
                    raise DeviceError(
                        "STATE_UNKNOWN",
                        "Cannot toggle: the current state is unknown.",
                        hint="Use on/off, or configure a status address.",
                        status=409,
                    )
                on = not current
            else:
                on = c == "turn_on"
            if d.switch:
                return [(d.switch, _encode("1.001", on))]
            assert d.brightness
            return [(d.brightness, _encode("5.001", 100 if on else 0))]
        if c == "set_brightness":
            assert d.brightness
            return [(d.brightness, _encode("5.001", p["brightness"]))]
        if c == "dim":
            assert d.dim
            if p["direction"] == "stop":
                value = ControlDimming(control=Step.DECREASE, step_code=0)
            else:
                value = ControlDimming(
                    control=Step.INCREASE if p["direction"] == "up" else Step.DECREASE,
                    step_code=step_code_for(p.get("step")),
                )
            return [(d.dim, DPTControlDimming.to_knx(value))]
        if c in ("open", "close"):
            if d.up_down:
                return [(d.up_down, _encode("1.008", c == "close"))]  # DPT 1.008: 0 = up, 1 = down
            assert d.position
            target = 100 if c == "open" else 0
            return [(d.position, _encode("5.001", 100 - target if d.invert_position else target))]
        if c == "stop":
            assert d.stop
            return [(d.stop, DPTBinary(1))]
        if c == "set_position":
            assert d.position
            pos = p["position"]
            return [(d.position, _encode("5.001", 100 - pos if d.invert_position else pos))]
        raise DeviceError("UNSUPPORTED_COMMAND", f"'{c}' is not supported.", status=400)

    def _has_feedback_for(self, d: KnxDevice, want: dict[str, Any]) -> bool:
        keys = set(want)
        return bool(
            ("on" in keys and (d.switch_status or d.brightness_status))
            or ("brightness" in keys and d.brightness_status)
            or ("position" in keys and d.position_status)
        )

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        assert isinstance(device, KnxDevice)
        writes = self._writes(device, cmd)
        for ga, _ in writes:  # defence in depth: never write outside the device's own mapping
            if ga not in device.writable_addresses():
                raise DeviceError("GA_NOT_CONFIGURED", f"{ga} is not a writable address of this device.", status=500)
        want = expected_state(cmd, dict(self._states.get(device.id, {})))
        fut: asyncio.Future[bool] | None = None
        if want and self._has_feedback_for(device, want):
            fut = asyncio.get_running_loop().create_future()
            self._waiters.setdefault(device.id, []).append((want, fut))
        delivery = "bus_confirmed"
        try:
            for ga, payload in writes:
                try:
                    outcome, _confirmation = await self.knx.write(ga, payload)
                except KnxError as err:
                    raise DeviceError(err.code, err.message, hint=err.hint, status=err.status) from err
                if outcome != "bus_confirmed":
                    delivery = "sent_unconfirmed"  # routing: multicast has no confirmation
            if fut is None:
                return CommandResult(
                    "accepted",
                    delivery,
                    "Telegram confirmed on the bus; this device has no feedback address for the result."
                    if delivery == "bus_confirmed"
                    else "Telegram sent (routing cannot confirm delivery).",
                )
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout=CONFIRM_TIMEOUT_S)
                return CommandResult(
                    "confirmed", delivery, "The actuator reported the requested state on its feedback address."
                )
            except TimeoutError:
                return CommandResult("accepted", delivery, "Telegram on the bus; waiting for the actuator's feedback.")
        finally:
            if fut is not None:
                self._waiters[device.id] = [w for w in self._waiters.get(device.id, []) if w[1] is not fut]
                if not fut.done():
                    fut.cancel()

    async def refresh(self, device: DeviceConfig) -> None:
        assert isinstance(device, KnxDevice)
        if not self.knx.connected:
            raise DeviceError("KNX_NOT_CONNECTED", "The KNX interface is not connected.", status=503)
        for ga in (device.switch_status, device.brightness_status, device.position_status, device.value):
            if ga:
                gv = await self.knx.read(ga, wait_s=2.0)
                if gv is not None:
                    self._on_value(ga, gv)

    # ------------------------------------------------------------------ status

    def status(self) -> IntegrationStatus:
        st = self.knx.status
        state = {"connected": "connected", "connecting": "connecting"}.get(
            st.state, "disconnected" if st.state != "error" else "error"
        )
        if not self._devices:
            state = "not_configured" if st.state != "connected" else "connected"
        gateway = f"{st.gateway_host}:{st.gateway_port}" if st.gateway_host else None
        detail = f"KNX {st.state}" + (f" via {gateway}" if gateway else "")
        err = error_info(*st.last_error) if st.last_error else None
        return IntegrationStatus(
            "knx",
            state,  # type: ignore[arg-type]
            detail,
            self._last_value_at,
            err,
            {"devices": len(self._devices), "connectionType": st.connection_type, "gateway": gateway},
        )
