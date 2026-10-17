"""Unified device model shared by every integration (simulated, Shelly, Home Assistant, KNX).

A device is described by a validated *configuration* (persisted, contains no secrets) and a
*runtime* record (connection status, reported vs requested state, detected capabilities).
Commands are derived from capabilities, so a device only offers what it actually supports.

Conventions (identical for every integration):
* ``brightness`` and ``position`` are integers 0-100 (percent).
* ``position``: 0 = fully closed, 100 = fully open. Adapters convert where a protocol differs
  (KNX usually uses 0 % = open).
* ``power`` is in W and ``energy`` in Wh.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from ..group_address import GroupAddressError, parse_group_address
from ..hosts import DeviceHostError, normalize_device_host

DEVICE_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,47}$"
ENTITY_ID_PATTERN = r"^[a-z_]+\.[a-z0-9_]+$"
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class Capability(StrEnum):
    ON_OFF = "on_off"
    BRIGHTNESS = "brightness"  # absolute level 0-100 %
    DIM_RELATIVE = "dim_relative"  # start/stop dimming up or down
    OPEN_CLOSE = "open_close"
    POSITION = "position"  # absolute position 0 (closed) - 100 (open)
    STOP = "stop"
    POWER = "power"
    ENERGY = "energy"
    TEMPERATURE = "temperature"
    HUMIDITY = "humidity"
    ILLUMINANCE = "illuminance"
    VALUE = "value"  # generic numeric reading with a unit
    BINARY = "binary"  # generic on/off reading (read-only)


COMMAND_CAPABILITY: dict[str, Capability] = {
    "turn_on": Capability.ON_OFF,
    "turn_off": Capability.ON_OFF,
    "toggle": Capability.ON_OFF,
    "set_brightness": Capability.BRIGHTNESS,
    "adjust_brightness": Capability.BRIGHTNESS,  # relative change, resolved by the hub against reported brightness
    "dim": Capability.DIM_RELATIVE,
    "open": Capability.OPEN_CLOSE,
    "close": Capability.OPEN_CLOSE,
    "stop": Capability.STOP,
    "set_position": Capability.POSITION,
}

READ_ONLY_TYPES = ("sensor",)


def commands_for(capabilities: frozenset[Capability] | set[Capability]) -> list[str]:
    return [cmd for cmd, cap in COMMAND_CAPABILITY.items() if cap in capabilities]


DeviceType = Literal["light", "switch", "outlet", "cover", "sensor"]
CommandName = Literal[
    "turn_on",
    "turn_off",
    "toggle",
    "set_brightness",
    "adjust_brightness",
    "dim",
    "open",
    "close",
    "stop",
    "set_position",
]
CommandSource = Literal["manual", "lamp", "keyboard", "gesture", "voice", "test"]


class ApiModel(BaseModel):
    """camelCase on the wire, snake_case in Python, unknown fields refused."""

    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


def _clean_text(value: str) -> str:
    v = value.strip()
    if _CONTROL_CHARS.search(v):
        raise ValueError("must not contain control characters")
    if not v:
        raise ValueError("must not be empty")
    return v


def _canonical_ga(value: str) -> str:
    try:
        return parse_group_address(value).canonical
    except GroupAddressError as err:
        raise ValueError(err.message) from err


GroupAddressStr = Annotated[str, Field(max_length=16), AfterValidator(_canonical_ga)]
Tag = Annotated[str, Field(min_length=1, max_length=24), AfterValidator(_clean_text)]


class DeviceMetadata(ApiModel):
    room: Annotated[str, AfterValidator(_clean_text)] | None = Field(default=None, max_length=48)
    tags: list[Tag] = Field(default_factory=list, max_length=10)
    # The same physical device exposed through another integration (e.g. a Shelly that is also an
    # HA entity). Linked devices are flagged in the UI instead of being merged silently.
    linked_to: str | None = Field(default=None, pattern=DEVICE_ID_PATTERN)


class _DeviceBase(ApiModel):
    id: str = Field(pattern=DEVICE_ID_PATTERN)
    name: Annotated[str, AfterValidator(_clean_text)] = Field(min_length=1, max_length=64)
    type: DeviceType
    # Real devices start with control disabled; enabling requires an explicit acknowledgement.
    control_enabled: bool = False
    hidden: bool = False
    metadata: DeviceMetadata = Field(default_factory=DeviceMetadata)


class SimulatedDevice(_DeviceBase):
    integration: Literal["simulated"]
    sensor_kind: Literal["temperature", "humidity", "illuminance"] | None = None


class ShellyDevice(_DeviceBase):
    integration: Literal["shelly"]
    host: str = Field(min_length=1, max_length=253)
    gen: int = Field(ge=1, le=9)
    component: Literal["switch", "light", "cover"]
    channel: int = Field(default=0, ge=0, le=15)
    model: str | None = Field(default=None, max_length=64)
    shelly_id: str | None = Field(default=None, max_length=64)  # Shelly device id / MAC from /shelly
    username: str | None = Field(default=None, max_length=64)  # Gen1 only; Gen2+ always uses "admin"
    poll_interval_s: int | None = Field(default=None, ge=2, le=300)

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        try:
            return normalize_device_host(v)
        except DeviceHostError as err:
            raise ValueError(err.message) from err

    @model_validator(mode="after")
    def _type_matches_component(self) -> ShellyDevice:
        allowed = {"switch": ("switch", "outlet", "light"), "light": ("light",), "cover": ("cover",)}
        if self.type not in allowed[self.component]:
            raise ValueError(f"a Shelly {self.component} channel cannot be a {self.type} device")
        return self


_HA_DOMAIN_TYPES: dict[str, tuple[str, ...]] = {
    "light": ("light",),
    "switch": ("switch", "outlet", "light"),
    "input_boolean": ("switch",),
    "cover": ("cover",),
    "sensor": ("sensor",),
    "binary_sensor": ("sensor",),
}


class HomeAssistantDevice(_DeviceBase):
    integration: Literal["homeassistant"]
    entity_id: str = Field(pattern=ENTITY_ID_PATTERN, max_length=255)

    @model_validator(mode="after")
    def _domain_matches_type(self) -> HomeAssistantDevice:
        domain = self.entity_id.split(".", 1)[0]
        if domain not in _HA_DOMAIN_TYPES:
            raise ValueError(f"Home Assistant domain {domain!r} is not supported yet ({', '.join(_HA_DOMAIN_TYPES)})")
        if self.type not in _HA_DOMAIN_TYPES[domain]:
            raise ValueError(f"a {domain} entity cannot be a {self.type} device")
        return self


_KNX_FIELDS_BY_TYPE: dict[str, set[str]] = {
    "switch": {"switch", "switch_status"},
    "outlet": {"switch", "switch_status"},
    "light": {"switch", "switch_status", "brightness", "brightness_status", "dim"},
    "cover": {"up_down", "stop", "position", "position_status", "invert_position"},
    "sensor": {"value", "value_dpt", "unit"},
}
_KNX_ALL_FIELDS = set().union(*_KNX_FIELDS_BY_TYPE.values())


class KnxDevice(_DeviceBase):
    """Explicit group-address mapping. Only these addresses are ever written for this device."""

    integration: Literal["knx"]
    switch: GroupAddressStr | None = None  # DPT 1.001 on/off
    switch_status: GroupAddressStr | None = None  # DPT 1.001 feedback
    brightness: GroupAddressStr | None = None  # DPT 5.001 absolute level
    brightness_status: GroupAddressStr | None = None  # DPT 5.001 feedback
    dim: GroupAddressStr | None = None  # DPT 3.007 relative dimming (start/stop)
    up_down: GroupAddressStr | None = None  # DPT 1.008 (0 = up/open, 1 = down/close)
    stop: GroupAddressStr | None = None  # stop movement: writes 1 (DPT 1.007/1.010 style trigger)
    position: GroupAddressStr | None = None  # DPT 5.001 absolute position
    position_status: GroupAddressStr | None = None  # DPT 5.001 feedback
    invert_position: bool = True  # KNX convention: 0 % = open; SE7ENX: 100 = open
    value: GroupAddressStr | None = None  # sensor value
    value_dpt: str | None = Field(default=None, pattern=r"^\d{1,3}\.\d{3}$")
    unit: Annotated[str, AfterValidator(_clean_text)] | None = Field(default=None, max_length=12)

    @model_validator(mode="after")
    def _mapping_matches_type(self) -> KnxDevice:
        allowed = _KNX_FIELDS_BY_TYPE[self.type]
        defaults = {"invert_position": True}
        stray = sorted(f for f in _KNX_ALL_FIELDS - allowed if getattr(self, f) not in (None, defaults.get(f)))
        if stray:
            raise ValueError(f"{', '.join(stray)} cannot be used for a KNX {self.type}")
        if self.type in ("switch", "outlet") and not self.switch:
            raise ValueError("a KNX switch needs a 'switch' group address (DPT 1.001)")
        if self.type == "light" and not (self.switch or self.brightness):
            raise ValueError("a KNX light needs a 'switch' (DPT 1.001) or 'brightness' (DPT 5.001) group address")
        if self.type == "cover" and not (self.up_down or self.position):
            raise ValueError("a KNX cover needs an 'upDown' (DPT 1.008) or 'position' (DPT 5.001) group address")
        if self.type == "sensor":
            if not (self.value and self.value_dpt):
                raise ValueError("a KNX sensor needs 'value' and 'valueDpt'")
            from xknx.dpt import DPTBase  # local import keeps the model importable without side effects

            if DPTBase.parse_transcoder(self.value_dpt) is None:
                raise ValueError(f"DPT {self.value_dpt} is not supported by xknx")
        return self

    def writable_addresses(self) -> set[str]:
        return {a for a in (self.switch, self.brightness, self.dim, self.up_down, self.stop, self.position) if a}

    def all_addresses(self) -> set[str]:
        return self.writable_addresses() | {
            a for a in (self.switch_status, self.brightness_status, self.position_status, self.value) if a
        }


DeviceConfig = Annotated[
    SimulatedDevice | ShellyDevice | HomeAssistantDevice | KnxDevice,
    Field(discriminator="integration"),
]


class DevicePatch(ApiModel):
    name: Annotated[str, AfterValidator(_clean_text)] | None = Field(default=None, max_length=64)
    hidden: bool | None = None
    metadata: DeviceMetadata | None = None
    control_enabled: bool | None = None
    # Required (true) when enabling control of a real device: the user confirmed the warning.
    acknowledge_real_control: bool = False


class DeviceCommand(ApiModel):
    command: CommandName
    params: dict[str, Any] = Field(default_factory=dict)
    request_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")
    source: CommandSource = "manual"

    @model_validator(mode="after")
    def _validate_params(self) -> DeviceCommand:
        p = self.params

        def int_param(name: str, lo: int, hi: int) -> int:
            v = p.get(name)
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise ValueError(f"'{name}' must be an integer between {lo} and {hi}")
            return v

        if self.command == "set_brightness":
            self.params = {"brightness": int_param("brightness", 0, 100)}
            extra = set(p) - {"brightness"}
        elif self.command == "adjust_brightness":
            delta = int_param("delta", -100, 100)
            if delta == 0:
                raise ValueError("'delta' must not be 0")
            self.params = {"delta": delta}
            extra = set(p) - {"delta"}
        elif self.command == "set_position":
            self.params = {"position": int_param("position", 0, 100)}
            extra = set(p) - {"position"}
        elif self.command == "dim":
            if p.get("direction") not in ("up", "down", "stop"):
                raise ValueError("'direction' must be 'up', 'down' or 'stop'")
            clean: dict[str, Any] = {"direction": p["direction"]}
            if "step" in p:
                clean["step"] = int_param("step", 1, 100)
            self.params = clean
            extra = set(p) - {"direction", "step"}
        else:
            extra = set(p)
        if extra:
            raise ValueError(f"unexpected parameter(s) for {self.command}: {', '.join(sorted(extra))}")
        return self


def expected_state(cmd: DeviceCommand, current: dict[str, Any]) -> dict[str, Any]:
    """The reported state a successful command should eventually produce (used for confirmation)."""
    c, p = cmd.command, cmd.params
    if c == "turn_on":
        return {"on": True}
    if c == "turn_off":
        return {"on": False}
    if c == "toggle":
        return {"on": not bool(current.get("on"))} if "on" in current else {}
    if c == "set_brightness":
        return {"brightness": p["brightness"]} if p["brightness"] > 0 else {"on": False}
    if c == "set_position":
        return {"position": p["position"]}
    if c == "open":
        return {"position": 100} if "position" in current else {}
    if c == "close":
        return {"position": 0} if "position" in current else {}
    return {}


def state_matches(expected: dict[str, Any], reported: dict[str, Any], tolerance: int = 1) -> bool:
    if not expected:
        return False
    for key, want in expected.items():
        have = reported.get(key)
        if have is None:
            return False
        if isinstance(want, bool) or isinstance(have, bool):
            if bool(have) is not bool(want):
                return False
        elif isinstance(want, int | float) and isinstance(have, int | float):
            if abs(have - want) > tolerance:
                return False
        elif have != want:
            return False
    return True


class DeviceError(Exception):
    """An integration-level failure, mapped to an API error by the router."""

    def __init__(self, code: str, message: str, *, hint: str | None = None, status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status


@dataclass
class CommandResult:
    # confirmed: the device reported the requested state afterwards
    # accepted: the device/controller accepted the request but has not confirmed the new state (yet)
    # simulated: simulated device, nothing physical happened
    # already_satisfied: the device reliably reported the requested state already; nothing was sent
    outcome: Literal["confirmed", "accepted", "simulated", "already_satisfied"]
    delivery: str  # protocol-level acknowledgement, e.g. "http_ok", "bus_confirmed", "service_call_ok"
    detail: str


ConnectionState = Literal["online", "offline", "unauthorized", "unavailable", "error", "unknown"]


@dataclass
class DeviceRuntime:
    connection: ConnectionState = "unknown"
    last_seen: float | None = None
    last_error: dict[str, str] | None = None
    reported: dict[str, Any] = field(default_factory=dict)
    reported_at: float | None = None
    reported_source: str | None = None
    requested: dict[str, Any] | None = None
    requested_at: float | None = None
    capabilities: frozenset[Capability] = frozenset()
    model: str | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)
    last_command_at: float = 0.0
