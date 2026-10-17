"""Hub core: network policies, settings, persistent store, device model, registry policy, device API,
Host/same-origin rules and static UI serving."""

from __future__ import annotations

import asyncio
import json
import logging
import stat
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from se7enx_bridge.api import create_app
from se7enx_bridge.config import ConfigError, Settings, normalize_ha_url
from se7enx_bridge.devices.adapters.base import DeviceAdapter, IntegrationStatus
from se7enx_bridge.devices.model import (
    Capability,
    CommandResult,
    DeviceCommand,
    DeviceConfig,
    DeviceError,
    HomeAssistantDevice,
    expected_state,
    state_matches,
)
from se7enx_bridge.devices.store import ConfigStore, StoreError
from se7enx_bridge.hosts import (
    DeviceHostError,
    HostPolicy,
    check_device_host,
    split_host_header,
    validate_host_pattern,
)

from .conftest import ORIGIN, PAIRING_CODE, BridgeClient, make_settings

SECRET = "hunter2-very-secret-value"  # test credential: must never be echoed anywhere
DEVICE_ADAPTER: TypeAdapter[Any] = TypeAdapter(DeviceConfig)


# =============================================================================== network policies


def test_host_patterns_and_policy() -> None:
    assert validate_host_pattern(" AUTO ") == "auto"
    assert validate_host_pattern("se7enx.home.arpa") == "se7enx.home.arpa"
    assert validate_host_pattern("*.lan") == "*.lan"
    assert validate_host_pattern("[fd00::1]") == "fd00::1"
    for bad in ("http://x", "a b", "*.", "-bad-.com"):
        with pytest.raises(ValueError):
            validate_host_pattern(bad)
    assert split_host_header("[fd00::1]:8787") == "fd00::1"
    assert split_host_header("Hub.Local:8787") == "hub.local"

    auto = HostPolicy(("auto",))
    for ok in ("192.168.1.20:8787", "localhost:8787", "se7enx.local", "hub.home.arpa", "[fd00::5]:8787", "10.0.0.2"):
        assert auto.allows(ok), ok
    # DNS-rebinding style names are refused unless listed explicitly
    for bad in ("evil.example", "rebind.attacker.com:8787", None, ""):
        assert not auto.allows(bad), bad
    custom = HostPolicy(("auto", "se7enx.example.lan", "*.tailnet.ts.net"))
    assert custom.allows("se7enx.example.lan") and custom.allows("box.tailnet.ts.net") and not custom.allows("x.lan")


def test_device_hosts_must_be_local() -> None:
    assert asyncio.run(check_device_host("192.168.33.1")) == "192.168.33.1"
    assert asyncio.run(check_device_host("10.1.2.3")) == "10.1.2.3"
    assert asyncio.run(check_device_host("100.100.1.1")) == "100.100.1.1"  # tailnet / CGNAT space
    for bad in ("8.8.8.8", "127.0.0.1", "0.0.0.0", "224.0.23.12", "1.1.1.1"):
        with pytest.raises(DeviceHostError):
            asyncio.run(check_device_host(bad))
    for bad in ("http://192.168.1.2", "user@host", "a/b", ""):
        with pytest.raises(DeviceHostError):
            asyncio.run(check_device_host(bad))


# =============================================================================== settings


def test_hub_settings_from_env(tmp_path: Path) -> None:
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text("<html></html>")
    token_file = tmp_path / "ha_token"
    token_file.write_text(f"{SECRET}\n")
    s = Settings.from_env(
        {
            "SE7ENX_DATA_DIR": str(tmp_path / "data"),
            "SE7ENX_UI_DIR": str(ui),
            "SE7ENX_ALLOWED_HOSTS": "auto, Se7enx.Home.Arpa",
            "SE7ENX_SAMPLE_DEVICES": "true",
            "SE7ENX_HA_URL": "http://homeassistant.local:8123/",
            "SE7ENX_HA_TOKEN_FILE": str(token_file),
            "SE7ENX_SHELLY_POLL_S": "10",
        }
    )
    assert s.allowed_hosts == ("auto", "se7enx.home.arpa")
    assert s.ha_url == "http://homeassistant.local:8123" and s.ha_token == SECRET
    assert s.sample_devices and s.shelly_poll_s == 10
    described = json.dumps(s.describe())
    assert SECRET not in described and '"homeassistant_token": "***"' in described
    assert SECRET not in repr(s)

    bad_envs = [
        {"SE7ENX_UI_DIR": str(tmp_path)},  # no index.html
        {"SE7ENX_ALLOWED_HOSTS": "http://x"},
        {"SE7ENX_HA_URL": "ftp://ha"},
        {"SE7ENX_HA_TOKEN": "x"},  # token without URL
        {"SE7ENX_HA_URL": "http://ha:8123", "SE7ENX_HA_TOKEN": "a", "SE7ENX_HA_TOKEN_FILE": str(token_file)},
        {"SE7ENX_HA_URL": "http://ha:8123", "SE7ENX_HA_TOKEN_FILE": str(tmp_path / "missing")},
        {"SE7ENX_SHELLY_POLL_S": "1"},
    ]
    for env in bad_envs:
        with pytest.raises(ConfigError):
            Settings.from_env(env)
    # appliance: no cross-origin web apps at all, only valid together with a Host allowlist
    same_origin = Settings.from_env({"SE7ENX_ALLOWED_ORIGINS": "none", "SE7ENX_ALLOWED_HOSTS": "auto"})
    assert same_origin.allowed_origins == () and same_origin.allowed_hosts == ("auto",)
    with pytest.raises(ConfigError):
        Settings.from_env({"SE7ENX_ALLOWED_ORIGINS": "none"})
    with pytest.raises(ValueError):
        normalize_ha_url("http://user:pw@ha:8123")


# =============================================================================== model


def test_device_model_validation() -> None:
    shelly = DEVICE_ADAPTER.validate_python(
        {
            "integration": "shelly",
            "id": "plug-1",
            "name": "Plug",
            "type": "outlet",
            "host": " 192.168.1.40 ",
            "gen": 2,
            "component": "switch",
        }
    )
    assert shelly.host == "192.168.1.40" and shelly.control_enabled is False
    knx = DEVICE_ADAPTER.validate_python(
        {
            "integration": "knx",
            "id": "kitchen",
            "name": "Kitchen",
            "type": "light",
            "switch": "1/1/1",
            "brightness": "1/2/1",
            "dim": "1/3/1",
            "brightnessStatus": "1/4/1",
        }
    )
    assert knx.writable_addresses() == {"1/1/1", "1/2/1", "1/3/1"} and "1/4/1" in knx.all_addresses()
    invalid = [
        {
            "integration": "shelly",
            "id": "x",
            "name": "X",
            "type": "cover",
            "host": "10.0.0.2",
            "gen": 2,
            "component": "switch",
        },
        {"integration": "homeassistant", "id": "x", "name": "X", "type": "cover", "entityId": "light.kitchen"},
        {"integration": "homeassistant", "id": "x", "name": "X", "type": "switch", "entityId": "lock.front_door"},
        {"integration": "knx", "id": "x", "name": "X", "type": "switch"},  # no switch GA
        {"integration": "knx", "id": "x", "name": "X", "type": "light", "switch": "1/1/1", "upDown": "1/1/2"},
        {"integration": "knx", "id": "x", "name": "X", "type": "sensor", "value": "1/1/1", "valueDpt": "999.999"},
        {"integration": "knx", "id": "x", "name": "X", "type": "light", "switch": "0/0/0"},  # broadcast
        {"integration": "simulated", "id": "Bad_ID", "name": "X", "type": "light"},
        {"integration": "simulated", "id": "x", "name": "bad\nname", "type": "light"},
        {"integration": "simulated", "id": "x", "name": "X", "type": "light", "unknown": 1},
    ]
    for body in invalid:
        with pytest.raises(ValidationError):
            DEVICE_ADAPTER.validate_python(body)


def test_command_validation_and_expected_state() -> None:
    ok = DeviceCommand.model_validate({"command": "set_brightness", "params": {"brightness": 40}, "requestId": "r1"})
    assert ok.params == {"brightness": 40} and ok.source == "manual"
    for body in (
        {"command": "set_brightness", "params": {"brightness": 140}, "requestId": "r"},
        {"command": "set_brightness", "params": {"brightness": True}, "requestId": "r"},
        {"command": "turn_on", "params": {"x": 1}, "requestId": "r"},
        {"command": "dim", "params": {"direction": "sideways"}, "requestId": "r"},
        {"command": "explode", "requestId": "r"},
        {"command": "turn_on", "requestId": "bad id!"},
    ):
        with pytest.raises(ValidationError):
            DeviceCommand.model_validate(body)
    on = DeviceCommand.model_validate({"command": "toggle", "requestId": "r"})
    assert expected_state(on, {"on": True}) == {"on": False}
    assert state_matches({"brightness": 40}, {"brightness": 41, "on": True})
    assert not state_matches({"on": True}, {"on": False}) and not state_matches({}, {"on": True})


# =============================================================================== store


def test_store_persists_without_secrets(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path)
    store.load()
    dev = DEVICE_ADAPTER.validate_python(
        {
            "integration": "shelly",
            "id": "relay",
            "name": "Relay",
            "type": "switch",
            "host": "192.168.1.5",
            "gen": 1,
            "component": "switch",
        }
    )
    store.put_device(dev)
    store.set_device_secret("relay", {"username": "admin", "password": SECRET})
    store.set_ha_token(SECRET + "-ha")
    store.save()
    store.save()  # second save creates the backup
    cfg_text = (tmp_path / "config.json").read_text()
    assert SECRET not in cfg_text and (tmp_path / "config.json.bak").exists()
    assert stat.S_IMODE((tmp_path / "secrets.json").stat().st_mode) == 0o600
    exported = json.dumps(store.export())
    assert SECRET not in exported and '"credentialsRequired": true' in exported and '"tokenRequired": true' in exported

    again = ConfigStore(tmp_path)
    again.load()
    assert again.find("relay") is not None and again.device_secret("relay")["password"] == SECRET
    again.remove_device("relay")
    again.save()
    assert SECRET not in (tmp_path / "secrets.json").read_text().replace(SECRET + "-ha", "")


def test_store_fails_fast_on_corruption_and_fixes_permissions(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{not json")
    with pytest.raises(StoreError):
        ConfigStore(tmp_path).load()
    (tmp_path / "config.json").write_text(json.dumps({"version": 1, "devices": [{"integration": "nope"}]}))
    with pytest.raises(StoreError):
        ConfigStore(tmp_path).load()
    (tmp_path / "config.json").unlink()
    secrets = tmp_path / "secrets.json"
    secrets.write_text("{}")
    secrets.chmod(0o644)
    ConfigStore(tmp_path).load()
    assert stat.S_IMODE(secrets.stat().st_mode) == 0o600


# =============================================================================== API with a fake "real" adapter


class FakeRealAdapter(DeviceAdapter):
    """Stands in for a real integration (registered as 'homeassistant') to exercise the policy gates."""

    integration = "homeassistant"
    connection = "online"
    calls: list[str]

    def __init__(self, callbacks: Any) -> None:
        super().__init__(callbacks)
        self.calls = []
        self.devices: list[DeviceConfig] = []

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        return frozenset({Capability.ON_OFF, Capability.BRIGHTNESS})

    async def validate_new(self, device: DeviceConfig, credentials: dict[str, str] | None) -> DeviceConfig:
        if isinstance(device, HomeAssistantDevice) and device.entity_id == "light.missing":
            raise DeviceError("ENTITY_NOT_FOUND", "unknown entity", status=404)
        return device

    async def sync(self, devices: list[DeviceConfig]) -> None:
        self.devices = devices
        for d in devices:
            self.cb.device_connection(d.id, self.connection, capabilities=self.capabilities(d), model="fake")

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        self.calls.append(cmd.command)
        if cmd.command == "turn_on":
            self.cb.device_state(device.id, {"on": True}, "event")
            return CommandResult("confirmed", "service_call_ok", "confirmed by state change")
        return CommandResult("accepted", "service_call_ok", "no feedback yet")

    def status(self) -> IntegrationStatus:
        return IntegrationStatus("homeassistant", "connected", "fake")


HA_DEVICE = {
    "integration": "homeassistant",
    "id": "kitchen",
    "name": "Kitchen",
    "type": "light",
    "entityId": "light.kitchen",
}


def hub_client(tmp_path: Path, **overrides: Any) -> tuple[TestClient, BridgeClient, dict[str, FakeRealAdapter]]:
    holder: dict[str, FakeRealAdapter] = {}

    def factory(cb: Any) -> FakeRealAdapter:
        holder["a"] = FakeRealAdapter(cb)
        return holder["a"]

    settings = make_settings(None, autoconnect=False, data_dir=str(tmp_path), sample_devices=True, **overrides)
    app = create_app(settings, adapter_factories={"homeassistant": factory})
    client = TestClient(app)
    client.__enter__()
    bc = BridgeClient(client)
    bc.pair()
    return client, bc, holder


def test_device_api_simulated_and_policy(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    client, bc, holder = hub_client(tmp_path, device_min_interval_ms=0)
    try:
        assert client.get("/api/v1/devices", headers={"Origin": ORIGIN}).status_code == 401
        devices = bc.get("/devices").json()["devices"]
        light = next(d for d in devices if d["id"] == "sim-living-light")
        assert light["simulated"] and light["controlAllowed"] and "set_brightness" in light["commands"]
        sensor = next(d for d in devices if d["type"] == "sensor")
        assert sensor["commands"] == [] and sensor["state"]["reported"]["unit"] == "°C"

        r = bc.post(
            "/devices/sim-living-light/commands",
            {"command": "set_brightness", "params": {"brightness": 40}, "requestId": "a1"},
        )
        assert r.status_code == 200 and r.json()["outcome"] == "simulated"
        assert r.json()["device"]["state"]["reported"] == {"on": True, "brightness": 40}
        r = bc.post(
            "/devices/sim-living-light/commands",
            {"command": "set_position", "params": {"position": 5}, "requestId": "a2"},
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "UNSUPPORTED_COMMAND"
        r = bc.post(f"/devices/{sensor['id']}/commands", {"command": "turn_on", "requestId": "a3"})
        assert r.status_code == 400 and "read-only" in r.json()["error"]["hint"]

        # real device: added with control disabled even if the request asks otherwise
        r = bc.post("/devices", {"device": {**HA_DEVICE, "controlEnabled": True}, "credentials": {"password": SECRET}})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["controlEnabled"] is False and body["credentialsStored"] is True and SECRET not in r.text
        assert bc.post("/devices", {"device": HA_DEVICE}).status_code == 409
        assert bc.post("/devices", {"device": {**HA_DEVICE, "id": "x", "entityId": "light.missing"}}).status_code == 404

        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "b1"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "CONTROL_NOT_ENABLED"
        assert holder["a"].calls == []
        r = bc.c.patch("/api/v1/devices/kitchen", json={"controlEnabled": True}, headers=bc.h)
        assert r.status_code == 400 and r.json()["error"]["code"] == "ACKNOWLEDGEMENT_REQUIRED"
        r = bc.c.patch(
            "/api/v1/devices/kitchen", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h
        )
        assert r.status_code == 200 and r.json()["controlEnabled"] is True

        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "b2"})
        assert r.status_code == 200 and r.json()["outcome"] == "confirmed"
        assert r.json()["device"]["state"]["pending"] is False
        r = bc.post(
            "/devices/kitchen/commands", {"command": "set_brightness", "params": {"brightness": 30}, "requestId": "b3"}
        )
        assert r.json()["outcome"] == "accepted" and r.json()["device"]["state"]["requested"] == {"brightness": 30}

        # hub emergency stop blocks real devices only
        assert bc.post("/safety/stop").json()["active"] is True
        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "b4"})
        assert r.status_code == 423 and r.json()["error"]["code"] == "SAFETY_STOP_ACTIVE"
        assert (
            bc.post("/devices/sim-living-light/commands", {"command": "turn_off", "requestId": "b5"}).status_code == 200
        )
        assert bc.post("/safety/resume").json() == {"active": False}

        # unreachable device
        holder["a"].connection = "offline"
        asyncio.run(holder["a"].sync(holder["a"].devices))
        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "b6"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "DEVICE_UNAVAILABLE"

        # integrations, export, deletion
        names = {i["name"] for i in bc.get("/integrations").json()["integrations"]}
        assert names == {"simulated", "homeassistant", "shelly", "knx"}  # registered even when not configured
        exp = bc.get("/config/export")
        assert "attachment" in exp.headers["content-disposition"] and SECRET not in exp.text
        assert exp.json()["exportedWithoutSecrets"] is True
        assert bc.c.delete("/api/v1/devices/kitchen", headers=bc.h).status_code == 204
        assert SECRET not in (tmp_path / "secrets.json").read_text()
        assert bc.get("/devices/kitchen").status_code == 404
        assert SECRET not in caplog.text
    finally:
        client.__exit__(None, None, None)


def test_device_rate_limit_and_persistence(tmp_path: Path) -> None:
    client, bc, _ = hub_client(tmp_path, device_min_interval_ms=5000)
    try:
        cmd = {"command": "toggle", "requestId": "c1"}
        assert bc.post("/devices/sim-desk-outlet/commands", cmd).status_code == 200
        r = bc.post("/devices/sim-desk-outlet/commands", {**cmd, "requestId": "c2"})
        assert r.status_code == 429 and r.json()["error"]["code"] == "DEVICE_RATE_LIMITED"
        assert (
            bc.c.patch(
                "/api/v1/devices/sim-desk-outlet", json={"name": "Desk", "metadata": {"room": "Office"}}, headers=bc.h
            ).status_code
            == 200
        )
    finally:
        client.__exit__(None, None, None)
    # a fresh hub on the same data directory keeps the configuration (and does not re-add samples)
    client, bc, _ = hub_client(tmp_path)
    try:
        devices = {d["id"]: d for d in bc.get("/devices").json()["devices"]}
        assert (
            devices["sim-desk-outlet"]["name"] == "Desk" and devices["sim-desk-outlet"]["metadata"]["room"] == "Office"
        )
        assert len(devices) == 4
    finally:
        client.__exit__(None, None, None)


# =============================================================================== Host + same-origin


def test_host_allowlist_and_same_origin(tmp_path: Path) -> None:
    app = create_app(make_settings(None, autoconnect=False, data_dir=str(tmp_path), allowed_hosts=("auto",)))
    with TestClient(app, base_url="http://192.168.1.50:8787") as c:
        pair = {"code": PAIRING_CODE, "clientName": "same-origin"}
        r = c.get("/api/v1/health", headers={"Host": "rebind.attacker.example"})
        assert r.status_code == 421 and r.json()["error"]["code"] == "HOST_NOT_ALLOWED"
        assert c.get("/api/v1/health").status_code == 200
        # the UI served by the hub itself (same origin) may pair without being listed in allowed origins
        r = c.post("/api/v1/pair", json=pair, headers={"Origin": "http://192.168.1.50:8787"})
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "http://192.168.1.50:8787"
        # a public website is not trusted
        r = c.post("/api/v1/pair", json=pair, headers={"Origin": "https://se7enx.vercel.app"})
        assert r.status_code == 403
        # an attacker page whose Origin matches its own (rebound) Host is still refused by the Host check
        r = c.post(
            "/api/v1/pair", json=pair, headers={"Origin": "http://evil.example:8787", "Host": "evil.example:8787"}
        )
        assert r.status_code == 421
    # without a Host policy (legacy default), same-origin is NOT implicitly trusted
    legacy = create_app(make_settings(None, autoconnect=False))
    with TestClient(legacy, base_url="http://192.168.1.50:8787") as c:
        r = c.post(
            "/api/v1/pair",
            json={"code": PAIRING_CODE, "clientName": "x"},
            headers={"Origin": "http://192.168.1.50:8787"},
        )
        assert r.status_code == 403


# =============================================================================== static UI


def test_static_ui_serving(tmp_path: Path) -> None:
    ui = tmp_path / "ui"
    (ui / "_next" / "static" / "chunks").mkdir(parents=True)
    (ui / "index.html").write_text("<html>SE7ENX</html>")
    (ui / "404.html").write_text("<html>not found</html>")
    (ui / "_next" / "static" / "chunks" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside")
    app = create_app(make_settings(None, autoconnect=False, ui_dir=str(ui), allowed_hosts=("auto",)))
    with TestClient(app, base_url="http://127.0.0.1:8787") as c:
        r = c.get("/")
        assert r.status_code == 200 and "SE7ENX" in r.text
        assert "connect-src 'self'" in r.headers["content-security-policy"] and r.headers["cache-control"] == "no-cache"
        assert r.headers["x-frame-options"] == "DENY"
        r = c.get("/_next/static/chunks/app.js")
        assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
        assert "javascript" in r.headers["content-type"]
        assert c.get("/does-not-exist").status_code == 404
        assert c.get("/..%2Fsecret.txt").status_code == 404
        assert c.get("/%2e%2e/secret.txt").status_code == 404
        api = c.get("/api/v1/health")
        assert api.json()["service"] == "se7enx-bridge"
        assert api.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
        assert c.get("/api/v1/nope").status_code == 404
