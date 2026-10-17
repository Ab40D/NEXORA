"""Phase E hub features: state-aware commands, relative dimming, UI-configured KNX interface,
KNX USB diagnostics and the optional LLM intent interpreter.

Everything here runs against fakes (a counting adapter, the fake KNX/IP interface from conftest and
an httpx MockTransport standing in for an OpenAI-compatible server). No real hardware or AI service.
"""

from __future__ import annotations

import ipaddress
import json
import logging
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.assistant import LlmInterpreter
from se7enx_bridge.config import ConfigError, Settings, normalize_llm_url
from se7enx_bridge.devices.adapters.base import CommandResult, DeviceAdapter, IntegrationStatus
from se7enx_bridge.devices.knx_usb import scan_usb
from se7enx_bridge.devices.model import Capability, DeviceCommand, DeviceConfig

from .conftest import ORIGIN, BridgeClient, FakeHandle, make_settings, wait_for

LOOPBACK = (ipaddress.IPv4Network("127.0.0.0/8"),)


# --------------------------------------------------------------------------- state-aware commands


class CountingAdapter(DeviceAdapter):
    """A 'real' integration double that records every command it is asked to send."""

    integration = "homeassistant"

    def __init__(self, callbacks: Any) -> None:
        super().__init__(callbacks)
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.connection = "online"

    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        if device.id == "porch":  # on/off only
            return frozenset({Capability.ON_OFF})
        return frozenset({Capability.ON_OFF, Capability.BRIGHTNESS})

    async def validate_new(self, device: DeviceConfig, credentials: dict[str, str] | None) -> DeviceConfig:
        return device

    async def sync(self, devices: list[DeviceConfig]) -> None:
        for d in devices:
            self.cb.device_connection(d.id, self.connection, capabilities=self.capabilities(d), model="counting")

    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult:
        self.calls.append((cmd.command, dict(cmd.params)))
        if cmd.command == "turn_on":
            self.cb.device_state(device.id, {"on": True}, "event")
        elif cmd.command == "turn_off":
            self.cb.device_state(device.id, {"on": False}, "event")
        elif cmd.command == "set_brightness":
            level = cmd.params["brightness"]
            self.cb.device_state(device.id, {"on": level > 0, "brightness": level}, "event")
        elif cmd.command == "toggle":
            return CommandResult("accepted", "service_call_ok", "toggled")
        return CommandResult("confirmed", "service_call_ok", "confirmed by state change")

    def status(self) -> IntegrationStatus:
        return IntegrationStatus("homeassistant", "connected", "counting")


def _hub(tmp_path: Path, **overrides: Any) -> tuple[TestClient, BridgeClient, dict[str, CountingAdapter]]:
    holder: dict[str, CountingAdapter] = {}

    def factory(cb: Any) -> CountingAdapter:
        holder["a"] = CountingAdapter(cb)
        return holder["a"]

    settings = make_settings(
        None, autoconnect=False, data_dir=str(tmp_path), sample_devices=True, device_min_interval_ms=0, **overrides
    )
    client = TestClient(create_app(settings, adapter_factories={"homeassistant": factory}))
    client.__enter__()
    bc = BridgeClient(client)
    bc.pair()
    for dev_id, entity in (("kitchen", "light.kitchen"), ("porch", "light.porch")):
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "homeassistant",
                    "id": dev_id,
                    "name": dev_id.title(),
                    "type": "light",
                    "entityId": entity,
                }
            },
        )
        assert r.status_code == 201, r.text
        r = bc.c.patch(
            f"/api/v1/devices/{dev_id}", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h
        )
        assert r.status_code == 200, r.text
    return client, bc, holder


_seq = iter(range(1_000_000))


def _cmd(bc: BridgeClient, dev: str, command: str, **params: Any) -> Any:
    return bc.post(f"/devices/{dev}/commands", {"command": command, "params": params, "requestId": f"t{next(_seq)}"})


def test_already_satisfied_is_never_resent(tmp_path: Path) -> None:
    client, bc, holder = _hub(tmp_path)
    try:
        a = holder["a"]
        assert _cmd(bc, "kitchen", "turn_on").json()["outcome"] == "confirmed"
        r = _cmd(bc, "kitchen", "turn_on")
        assert r.status_code == 200 and r.json()["outcome"] == "already_satisfied"
        assert r.json()["delivery"] == "none"
        assert [c for c, _ in a.calls] == ["turn_on"]  # nothing was sent the second time

        assert _cmd(bc, "kitchen", "set_brightness", brightness=40).json()["outcome"] == "confirmed"
        assert _cmd(bc, "kitchen", "set_brightness", brightness=40).json()["outcome"] == "already_satisfied"
        assert _cmd(bc, "kitchen", "set_brightness", brightness=41).json()["outcome"] == "confirmed"  # tolerance 0
        # toggle is never "already satisfied"
        assert _cmd(bc, "kitchen", "toggle").json()["outcome"] == "accepted"
        n = len(a.calls)

        # A value merely observed on the bus/from another sender is not trusted as device feedback.
        assert _cmd(bc, "kitchen", "turn_off").json()["outcome"] == "confirmed"  # clears the pending toggle
        n = len(a.calls)
        a.cb.device_state("kitchen", {"on": True}, "bus_observed")
        assert _cmd(bc, "kitchen", "turn_on").json()["outcome"] == "confirmed"
        assert len(a.calls) == n + 1

        # Permission gates come first: the emergency stop wins over "already on".
        assert bc.post("/safety/stop").status_code == 200
        r = _cmd(bc, "kitchen", "turn_on")
        assert r.status_code == 423
        assert bc.post("/safety/resume").status_code == 200

        # Offline devices are never reported as "already" anything.
        a.connection = "offline"
        a.cb.device_connection("kitchen", "offline")
        r = _cmd(bc, "kitchen", "turn_on")
        assert r.status_code == 503
    finally:
        client.__exit__(None, None, None)


def test_adjust_brightness_resolves_against_reliable_state(tmp_path: Path) -> None:
    client, bc, holder = _hub(tmp_path)
    try:
        a = holder["a"]
        # Fresh device: brightness unknown -> no guess, nothing sent.
        r = _cmd(bc, "kitchen", "adjust_brightness", delta=10)
        assert r.status_code == 409 and r.json()["error"]["code"] == "STATE_UNKNOWN"
        assert r.json()["error"]["hint"]
        assert a.calls == []

        assert _cmd(bc, "kitchen", "set_brightness", brightness=40).status_code == 200
        r = _cmd(bc, "kitchen", "adjust_brightness", delta=10)
        assert r.status_code == 200 and r.json()["outcome"] == "confirmed", r.text
        assert a.calls[-1] == ("set_brightness", {"brightness": 50})
        assert r.json()["device"]["state"]["reported"]["brightness"] == 50

        _cmd(bc, "kitchen", "adjust_brightness", delta=80)
        assert a.calls[-1] == ("set_brightness", {"brightness": 100})  # clamped to the device range
        assert _cmd(bc, "kitchen", "adjust_brightness", delta=20).json()["outcome"] == "already_satisfied"

        _cmd(bc, "kitchen", "turn_off")
        _cmd(bc, "kitchen", "adjust_brightness", delta=20)  # off counts as 0 %
        assert a.calls[-1] == ("set_brightness", {"brightness": 20})
        _cmd(bc, "kitchen", "turn_off")
        assert _cmd(bc, "kitchen", "adjust_brightness", delta=-10).json()["outcome"] == "already_satisfied"

        for bad in (0, 101, -101, "ten"):
            r = _cmd(bc, "kitchen", "adjust_brightness", delta=bad)
            assert r.status_code == 422, (bad, r.text)
        r = bc.post(
            "/devices/kitchen/commands",
            {"command": "adjust_brightness", "params": {"delta": 5, "x": 1}, "requestId": "x1"},
        )
        assert r.status_code == 422

        # on/off-only device: no brightness at all
        r = _cmd(bc, "porch", "adjust_brightness", delta=10)
        assert r.status_code in (400, 409, 422) and r.json()["error"]["code"] in (
            "UNSUPPORTED_COMMAND",
            "VALIDATION_ERROR",
        )
        devs = {d["id"]: d for d in bc.get("/devices").json()["devices"]}
        assert "adjust_brightness" in devs["kitchen"]["commands"]
        assert (
            "adjust_brightness" not in devs["porch"]["commands"] and "set_brightness" not in devs["porch"]["commands"]
        )

        # Simulated devices resolve the same way and stay labelled as simulated.
        sim = next(d for d in devs.values() if d["integration"] == "simulated" and "brightness" in d["capabilities"])
        _cmd(bc, sim["id"], "set_brightness", brightness=30)
        r = _cmd(bc, sim["id"], "adjust_brightness", delta=-10)
        assert r.json()["outcome"] == "simulated" and r.json()["device"]["state"]["reported"]["brightness"] == 20
    finally:
        client.__exit__(None, None, None)


# --------------------------------------------------------------------------- KNX interface from the UI


def _knx_settings(tmp_path: Path, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "connection_type": "automatic",
        "gateway_ip": None,
        "autoconnect": False,
        "data_dir": str(tmp_path),
        "client_gateway_cidrs": (*LOOPBACK, ipaddress.IPv4Network("192.168.0.0/16")),
    }
    base.update(overrides)
    return make_settings(None, **base)


def test_knx_interface_configured_in_ui_connects_and_persists(tmp_path: Path, fake: FakeHandle) -> None:
    with TestClient(create_app(_knx_settings(tmp_path))) as client:
        bc = BridgeClient(client)
        assert client.get("/api/v1/integrations/knx", headers={"Origin": ORIGIN}).status_code == 401
        bc.pair()
        body = bc.get("/integrations/knx").json()
        assert body["source"] == "none" and body["editable"] is True and body["config"] is None
        assert body["usbSupported"] is False and body["status"]["state"] == "disconnected"

        for host, code, status in (
            ("8.8.8.8", "GATEWAY_NOT_ALLOWED", 403),
            ("not-an-ip", "VALIDATION_ERROR", 422),
            ("", "VALIDATION_ERROR", 422),
        ):
            r = bc.put("/integrations/knx", {"connectionType": "tunneling", "host": host, "port": 3671})
            assert r.status_code == status and r.json()["error"]["code"] == code, r.text
        r = bc.put(
            "/integrations/knx", {"connectionType": "tunneling", "host": fake.host, "port": fake.port, "secret": 1}
        )
        assert r.status_code == 422  # unknown fields rejected

        r = bc.put("/integrations/knx", {"connectionType": "tunneling", "host": fake.host, "port": fake.port})
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "hub" and r.json()["config"]["host"] == fake.host
        r = bc.post("/integrations/knx/test")
        assert r.status_code == 200 and r.json()["status"]["state"] == "connected", r.text
        saved = json.loads((tmp_path / "config.json").read_text())
        assert saved["knx"]["connectionType"] == "tunneling" and saved["knx"]["gatewayPort"] == fake.port

    # A new hub process with the same data directory reconnects on its own.
    with TestClient(create_app(_knx_settings(tmp_path))) as client:
        bc = BridgeClient(client)
        bc.pair()
        assert wait_for(lambda: bc.get("/integrations/knx").json()["status"]["state"] == "connected")
        r = bc.c.delete("/api/v1/integrations/knx", headers=bc.h)
        assert r.status_code == 204
        body = bc.get("/integrations/knx").json()
        assert body["source"] == "none" and body["status"]["state"] == "disconnected"
        assert json.loads((tmp_path / "config.json").read_text())["knx"].get("connectionType") is None


def test_knx_interface_unreachable_reports_error_not_success(tmp_path: Path) -> None:
    with TestClient(create_app(_knx_settings(tmp_path))) as client:
        bc = BridgeClient(client)
        bc.pair()
        # Nothing listens on this port: the handshake must fail, never report "connected".
        r = bc.put("/integrations/knx", {"connectionType": "tunneling", "host": "127.0.0.1", "port": 9})
        assert r.status_code == 200
        r = bc.post("/integrations/knx/test")
        status = r.json()["status"]
        assert status["state"] != "connected"
        assert wait_for(lambda: bc.get("/integrations/knx").json()["status"]["state"] in ("error", "connecting"))


def test_knx_interface_env_configuration_is_read_only(tmp_path: Path) -> None:
    settings = make_settings(None, autoconnect=False, data_dir=str(tmp_path))  # SE7ENX_KNX_* set
    with TestClient(create_app(settings)) as client:
        bc = BridgeClient(client)
        bc.pair()
        body = bc.get("/integrations/knx").json()
        assert body["source"] == "environment" and body["editable"] is False
        r = bc.put("/integrations/knx", {"connectionType": "tunneling", "host": "192.168.1.50", "port": 3671})
        assert r.status_code == 409 and r.json()["error"]["code"] == "KNX_CONFIGURED_BY_ENV"
        assert bc.c.delete("/api/v1/integrations/knx", headers=bc.h).status_code == 409


# --------------------------------------------------------------------------- KNX USB diagnostics


def _usb(root: Path, name: str, vendor: str, product_id: str, product: str, manufacturer: str = "") -> None:
    d = root / name
    d.mkdir(parents=True)
    (d / "idVendor").write_text(vendor + "\n")
    (d / "idProduct").write_text(product_id + "\n")
    (d / "product").write_text(product + "\n")
    if manufacturer:
        (d / "manufacturer").write_text(manufacturer + "\n")


def test_knx_usb_diagnostics_never_claim_a_connection(tmp_path: Path) -> None:
    sysfs, dev = tmp_path / "sys", tmp_path / "dev"
    dev.mkdir()
    assert scan_usb(sysfs, dev)["status"] == "not_visible"
    sysfs.mkdir()
    assert scan_usb(sysfs, dev)["status"] == "not_detected"

    _usb(sysfs, "1-1", "0e77", "0104", "KNX-USB Interface", "Weinzierl Engineering GmbH")
    _usb(sysfs, "1-2", "046d", "c52b", "USB Receiver", "Logitech")
    _usb(sysfs, "1-3", "1234", "0001", "EIB stick")
    (sysfs / "1-0:1.0").mkdir()  # interface entry without descriptors
    report = scan_usb(sysfs, dev)
    assert report["supported"] is False and report["status"] == "detected_no_access"
    assert {d["vendorId"] for d in report["devices"]} == {"0e77", "1234"}
    assert report["usbDevicesSeen"] == 3 and "knxd" in report["guidance"]

    (dev / "hidraw0").write_text("")
    report = scan_usb(sysfs, dev)
    assert report["status"] == "detected_unsupported" and report["hidrawNodes"] == ["hidraw0"]
    assert report["supported"] is False


def test_knx_usb_route(tmp_path: Path) -> None:
    with TestClient(create_app(_knx_settings(tmp_path))) as client:
        bc = BridgeClient(client)
        assert client.get("/api/v1/integrations/knx/usb", headers={"Origin": ORIGIN}).status_code == 401
        bc.pair()
        body = bc.get("/integrations/knx/usb").json()
        assert body["supported"] is False and body["status"] in (
            "not_visible",
            "not_detected",
            "detected_no_access",
            "detected_unsupported",
        )


# --------------------------------------------------------------------------- LLM intent interpreter

LLM_KEY = "sk-test-not-a-real-key-123"


class FakeLlm:
    """Stands in for an OpenAI-compatible /chat/completions endpoint."""

    def __init__(self) -> None:
        self.reply: Any = {"intent": "set_brightness", "value": 60, "language": "dz"}
        self.status = 200
        self.raw: str | None = None
        self.requests: list[dict[str, Any]] = []
        self.fail: Exception | None = None

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        if self.fail:
            raise self.fail
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == f"Bearer {LLM_KEY}"
        self.requests.append(json.loads(request.content))
        content = self.raw if self.raw is not None else json.dumps(self.reply)
        return httpx2.Response(self.status, json={"choices": [{"message": {"role": "assistant", "content": content}}]})


def _llm_client(tmp_path: Path, fake_llm: FakeLlm, **overrides: Any) -> TestClient:
    settings = make_settings(
        None,
        autoconnect=False,
        data_dir=str(tmp_path),
        llm_url="http://127.0.0.1:9/v1",
        llm_model="fake-model",
        llm_api_key=LLM_KEY,
        **overrides,
    )
    interpreter = LlmInterpreter(settings, transport=httpx2.MockTransport(fake_llm.handler))
    return TestClient(create_app(settings, assistant=interpreter))


def test_llm_interpreter_returns_validated_intents_only(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    fake_llm = FakeLlm()
    with _llm_client(tmp_path, fake_llm) as client:
        bc = BridgeClient(client)
        bc.pair()
        info = bc.get("/assistant").json()["llm"]
        assert info == {"enabled": True, "model": "fake-model", "host": "127.0.0.1"}

        text = "خلي الضو على 60 بالمية"
        device = {"name": "Kitchen", "dimmable": True, "on": True, "brightness": 30}
        r = bc.post("/assistant/interpret", {"text": text, "lang": "dz", "device": device})
        assert r.status_code == 200, r.text
        assert r.json() == {
            "intent": "set_brightness",
            "value": 60,
            "language": "dz",
            "valid": True,
            "provider": "llm",
            "model": "fake-model",
        }
        sent = fake_llm.requests[-1]
        assert sent["model"] == "fake-model" and sent["temperature"] == 0
        assert sent["messages"][1] == {"role": "user", "content": text}
        assert "Dimmable: yes" in sent["messages"][0]["content"] and "brightness 30%" in sent["messages"][0]["content"]

        # Out-of-range or malformed output is rejected, never executed or guessed.
        for reply in (
            {"intent": "set_brightness", "value": 150},
            {"intent": "adjust_brightness", "value": 0},
            {"intent": "unlock_door"},
            {"intent": "set_brightness"},
            ["turn_on"],
        ):
            fake_llm.reply = reply
            body = bc.post("/assistant/interpret", {"text": "x", "lang": "en"}).json()
            assert body["intent"] == "unknown" and body["valid"] is False, reply
        fake_llm.raw = 'Sure! {"intent": "turn_off", "value": 99, "language": "fr"} Done.'
        body = bc.post("/assistant/interpret", {"text": "Éteins-la", "lang": "fr"}).json()
        assert body["intent"] == "turn_off" and body["value"] is None  # value dropped for non-brightness intents
        fake_llm.raw = "no json here"
        assert bc.post("/assistant/interpret", {"text": "x", "lang": "en"}).json()["intent"] == "unknown"
        fake_llm.raw = None

        fake_llm.status = 500
        r = bc.post("/assistant/interpret", {"text": "x", "lang": "en"})
        assert r.status_code == 502 and r.json()["error"]["code"] == "LLM_UNAVAILABLE"
        fake_llm.status = 200
        fake_llm.fail = httpx2.ConnectTimeout("timed out")
        r = bc.post("/assistant/interpret", {"text": "x", "lang": "en"})
        assert r.status_code == 504 and r.json()["error"]["code"] == "LLM_TIMEOUT"
        fake_llm.fail = None

        assert bc.post("/assistant/interpret", {"text": "", "lang": "en"}).status_code == 422
        assert bc.post("/assistant/interpret", {"text": "a" * 301, "lang": "en"}).status_code == 422
        assert bc.post("/assistant/interpret", {"text": "hi", "lang": "de"}).status_code == 422
        # rate limit (10 per minute per session); 12 requests were made above that reached the limiter
        codes = [bc.post("/assistant/interpret", {"text": "hi", "lang": "en"}).status_code for _ in range(10)]
        assert 429 in codes

    logs = caplog.text
    assert LLM_KEY not in logs and text not in logs and "Éteins" not in logs


def test_llm_disabled_by_default(tmp_path: Path) -> None:
    with TestClient(create_app(make_settings(None, autoconnect=False, data_dir=str(tmp_path)))) as client:
        bc = BridgeClient(client)
        bc.pair()
        assert bc.get("/assistant").json()["llm"] == {"enabled": False, "model": None, "host": None}
        r = bc.post("/assistant/interpret", {"text": "turn on the light", "lang": "en"})
        assert r.status_code == 404 and r.json()["error"]["code"] == "LLM_DISABLED"


def test_llm_settings_validation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert normalize_llm_url("http://192.168.1.20:11434/v1/") == "http://192.168.1.20:11434/v1"
    assert normalize_llm_url("https://api.example.com/v1") == "https://api.example.com/v1"
    assert normalize_llm_url("http://localhost:8080/v1") == "http://localhost:8080/v1"
    for bad in ("http://api.example.com/v1", "ftp://x/v1", "https://user:pw@x/v1", "https://x/v1?key=1", "https:///v1"):
        with pytest.raises(ValueError):
            normalize_llm_url(bad)

    monkeypatch.setenv("SE7ENX_ALLOWED_ORIGINS", ORIGIN)
    monkeypatch.setenv("SE7ENX_LLM_URL", "http://192.168.1.20:11434/v1")
    with pytest.raises(ConfigError, match="SE7ENX_LLM_MODEL"):
        Settings.from_env()
    key_file = tmp_path / "llm_key"
    key_file.write_text(LLM_KEY + "\n")
    monkeypatch.setenv("SE7ENX_LLM_MODEL", "llama3.2")
    monkeypatch.setenv("SE7ENX_LLM_API_KEY_FILE", str(key_file))
    s = Settings.from_env()
    assert s.llm_api_key == LLM_KEY and s.llm_model == "llama3.2"
    assert LLM_KEY not in repr(s) and s.describe()["llm_api_key"] == "***"
    monkeypatch.delenv("SE7ENX_LLM_URL")
    with pytest.raises(ConfigError, match="require SE7ENX_LLM_URL"):
        Settings.from_env()
