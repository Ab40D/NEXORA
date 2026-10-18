"""Shelly adapter against protocol-level FAKE Gen1 / Gen2+ devices (tools/fake_shelly.py).

These fakes follow the official local API documentation; they are not real hardware. Physical
validation is listed in the hardware test matrix.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fake_shelly import FakeShellyGen1, FakeShellyGen2
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.config import Settings
from se7enx_bridge.devices.adapters.shelly import ShellyAdapter
from se7enx_bridge.devices.model import DeviceError
from se7enx_bridge.devices.store import ConfigStore

from .conftest import BridgeClient, make_settings, wait_for

PASSWORD = "shelly-pass-123"  # test credential: must never be echoed


class NullCallbacks:
    def __init__(self) -> None:
        self.states: dict[str, dict[str, Any]] = {}
        self.connections: dict[str, str] = {}

    def device_state(self, device_id: str, reported: dict[str, Any], source: str) -> None:
        self.states[device_id] = reported

    def device_connection(self, device_id: str, status: str, error: Any = None, **_kw: Any) -> None:
        self.connections[device_id] = status

    def integration_changed(self, name: str) -> None:
        pass


class LanTransport(httpx2.AsyncBaseTransport):
    """Routes requests for one address to a fake device, looked up per request so a test can make a
    device 'disappear' from the network (connection refused) while the client stays alive."""

    def __init__(self, fakes: dict[str, Any], address: str) -> None:
        self.fakes, self.address = fakes, address

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        fake = self.fakes.get(self.address)
        if fake is None:
            raise httpx2.ConnectError("connection refused", request=request)
        return await httpx2.ASGITransport(app=fake).handle_async_request(request)


def transports(fakes: dict[str, Any]) -> Any:
    def factory(address: str) -> httpx2.AsyncBaseTransport:
        return LanTransport(fakes, address)

    return factory


def adapter_for(fakes: dict[str, Any], tmp_path: Path) -> ShellyAdapter:
    return ShellyAdapter(NullCallbacks(), Settings(), ConfigStore(tmp_path), transport_factory=transports(fakes))


# =============================================================================== identification


def test_gen2_identify_with_digest_auth(tmp_path: Path) -> None:
    fake = FakeShellyGen2(switches=2, password=PASSWORD, extra_components=("input:0", "rgb:0"))
    a = adapter_for({"192.168.1.40": fake}, tmp_path)
    with pytest.raises(DeviceError) as missing:
        asyncio.run(a.identify("192.168.1.40"))
    assert missing.value.code == "SHELLY_AUTH_FAILED" and missing.value.status == 502
    with pytest.raises(DeviceError) as wrong:
        asyncio.run(a.identify("192.168.1.40", password="wrong"))
    assert wrong.value.code == "SHELLY_AUTH_FAILED"
    ident = asyncio.run(a.identify("192.168.1.40", password=PASSWORD))
    assert ident["gen"] == 2 and ident["model"] == "SNSW-102P16EU" and ident["authRequired"] is True
    assert [(c["component"], c["channel"]) for c in ident["channels"]] == [("switch", 0), ("switch", 1)]
    ch = ident["channels"][0]
    assert set(ch["capabilities"]) == {"on_off", "power", "energy"} and ch["suggestedType"] == "outlet"
    assert ch["state"]["energy"] == 1234.5 and ch["state"]["temperature"] == 41.2
    assert ident["unsupportedComponents"] == ["rgb:0"]  # reported honestly, not guessed
    assert PASSWORD not in str(ident)


def test_gen2_capabilities_follow_the_device(tmp_path: Path) -> None:
    dimmer = FakeShellyGen2(model="S3DM-0010WW", app="Dimmer", gen=3, lights=1, metering=False)
    no_dim = FakeShellyGen2(lights=1, dim_methods=False, metering=False)
    calibrated = FakeShellyGen2(covers=1, pos_control=True)
    uncalibrated = FakeShellyGen2(covers=1, pos_control=False, metering=False)
    a = adapter_for(
        {"10.0.0.1": dimmer, "10.0.0.2": no_dim, "10.0.0.3": calibrated, "10.0.0.4": uncalibrated}, tmp_path
    )
    caps = {
        ip: set(asyncio.run(a.identify(ip))["channels"][0]["capabilities"])
        for ip in ("10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4")
    }
    assert caps["10.0.0.1"] == {"on_off", "brightness", "dim_relative"}
    assert caps["10.0.0.2"] == {"on_off", "brightness"}  # no DimUp/DimDown -> no relative dimming
    assert caps["10.0.0.3"] == {"open_close", "stop", "position", "power", "energy"}
    assert caps["10.0.0.4"] == {"open_close", "stop"}  # not calibrated -> no positioning offered


def test_gen1_identify_relays_rollers_and_dimmers(tmp_path: Path) -> None:
    relay = FakeShellyGen1(type_="SHSW-25", relays=2, password=PASSWORD)
    roller = FakeShellyGen1(type_="SHSW-25", relays=2, rollers=1, mode="roller")
    dimmer = FakeShellyGen1(type_="SHDM-2", relays=0, lights=1, meters=True)
    bulb = FakeShellyGen1(type_="SHBDUO-1", relays=0, lights=1, meters=False)
    a = adapter_for(
        {"192.168.1.50": relay, "192.168.1.51": roller, "192.168.1.52": dimmer, "192.168.1.53": bulb}, tmp_path
    )
    with pytest.raises(DeviceError):
        asyncio.run(a.identify("192.168.1.50"))
    r = asyncio.run(a.identify("192.168.1.50", "admin", PASSWORD))
    assert r["gen"] == 1 and r["model"] == "SHSW-25" and len(r["channels"]) == 2
    assert set(r["channels"][1]["capabilities"]) == {"on_off", "power", "energy"}
    assert r["channels"][0]["state"]["energy"] == 100.0  # 6000 watt-minutes -> 100 Wh
    ro = asyncio.run(a.identify("192.168.1.51"))
    assert [c["component"] for c in ro["channels"]] == ["cover"]  # roller mode: relays not offered
    assert "position" in ro["channels"][0]["capabilities"] and ro["channels"][0]["state"]["position"] == 50
    dm = asyncio.run(a.identify("192.168.1.52"))
    assert set(dm["channels"][0]["capabilities"]) >= {"on_off", "brightness", "dim_relative"}
    bu = asyncio.run(a.identify("192.168.1.53"))
    assert "dim_relative" not in bu["channels"][0]["capabilities"]  # only Shelly Dimmer 1/2 support dim=


def test_identify_refuses_non_local_and_non_shelly(tmp_path: Path) -> None:
    async def not_shelly(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"hello": "world"}'})

    a = adapter_for({"192.168.1.60": not_shelly}, tmp_path)
    for host, code in (
        ("8.8.8.8", "INVALID_DEVICE_HOST"),
        ("127.0.0.1", "INVALID_DEVICE_HOST"),
        ("192.168.1.60", "NOT_A_SHELLY"),
        ("192.168.1.61", "SHELLY_UNREACHABLE"),
    ):
        with pytest.raises(DeviceError) as err:
            asyncio.run(a.identify(host))
        assert err.value.code == code, host


# =============================================================================== end to end through the API


def shelly_hub(tmp_path: Path, fakes: dict[str, Any]) -> tuple[TestClient, BridgeClient]:
    factory = transports(fakes)
    settings = make_settings(None, autoconnect=False, data_dir=str(tmp_path), device_min_interval_ms=0, shelly_poll_s=2)
    state_holder: dict[str, Any] = {}

    def shelly_factory(cb: Any) -> ShellyAdapter:
        state_holder["store"] = cb.store
        return ShellyAdapter(cb, settings, cb.store, transport_factory=factory)

    app = create_app(settings, adapter_factories={"shelly": shelly_factory})
    client = TestClient(app)
    client.__enter__()
    bc = BridgeClient(client)
    bc.pair()
    return client, bc


def online(bc: BridgeClient, device_id: str) -> bool:
    return bc.get(f"/devices/{device_id}").json()["connection"]["status"] == "online"


def test_shelly_end_to_end(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    plug = FakeShellyGen2(
        model="S3PL-00112EU", app="PlugSG3", gen=3, device_id="shellyplugsg3-fake00002", switches=1, password=PASSWORD
    )
    blind = FakeShellyGen2(covers=1, device_id="shellyplus2pm-fake00003")
    gen1 = FakeShellyGen1(type_="SHSW-1", relays=1, meters=False)
    client, bc = shelly_hub(tmp_path, {"192.168.1.70": plug, "192.168.1.71": blind, "192.168.1.72": gen1})
    try:
        ident = bc.post("/integrations/shelly/identify", {"host": "192.168.1.70", "password": PASSWORD})
        assert ident.status_code == 200 and ident.json()["gen"] == 3 and PASSWORD not in ident.text

        base = {"integration": "shelly", "host": "192.168.1.70", "gen": 2, "component": "switch", "channel": 0}
        r = bc.post(
            "/devices",
            {
                "device": {**base, "id": "plug", "name": "Desk plug", "type": "outlet", "channel": 5},
                "credentials": {"password": PASSWORD},
            },
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "SHELLY_CHANNEL_NOT_FOUND"
        r = bc.post(
            "/devices",
            {
                "device": {**base, "id": "plug", "name": "Desk plug", "type": "outlet"},
                "credentials": {"password": "nope"},
            },
        )
        assert r.status_code == 502 and r.json()["error"]["code"] == "SHELLY_AUTH_FAILED"
        r = bc.post(
            "/devices",
            {
                "device": {**base, "id": "plug", "name": "Desk plug", "type": "outlet"},
                "credentials": {"password": PASSWORD},
            },
        )
        assert r.status_code == 201, r.text
        dev = r.json()
        assert dev["config"]["gen"] == 3 and dev["model"] == "S3PL-00112EU"  # detected values win over the request
        assert dev["controlEnabled"] is False and dev["credentialsStored"] is True and PASSWORD not in r.text
        assert wait_for(lambda: online(bc, "plug"))
        dev = bc.get("/devices/plug").json()
        assert set(dev["capabilities"]) == {"on_off", "power", "energy"} and dev["commands"] == [
            "turn_on",
            "turn_off",
            "toggle",
        ]

        assert bc.post("/devices/plug/commands", {"command": "turn_on", "requestId": "p1"}).status_code == 403
        bc.c.patch("/api/v1/devices/plug", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h)
        r = bc.post("/devices/plug/commands", {"command": "turn_on", "requestId": "p2"})
        assert r.status_code == 200 and r.json()["outcome"] == "confirmed" and r.json()["delivery"] == "http_ok"
        rep = r.json()["device"]["state"]["reported"]
        assert rep["on"] is True and rep["power"] == 61.5
        assert any("Switch.Set {'id': 0, 'on': True}" in q for q in plug.requests)
        r = bc.post(
            "/devices/plug/commands", {"command": "set_brightness", "params": {"brightness": 20}, "requestId": "p3"}
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "UNSUPPORTED_COMMAND"  # a relay cannot dim

        # cover: movement is "accepted" until the device reports the position
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "shelly",
                    "id": "blind",
                    "name": "Blind",
                    "type": "cover",
                    "host": "192.168.1.71",
                    "gen": 2,
                    "component": "cover",
                }
            },
        )
        assert r.status_code == 201
        assert wait_for(lambda: online(bc, "blind"))
        bc.c.patch("/api/v1/devices/blind", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h)
        r = bc.post(
            "/devices/blind/commands", {"command": "set_position", "params": {"position": 80}, "requestId": "b1"}
        )
        body = r.json()
        assert body["outcome"] == "accepted" and body["device"]["state"]["requested"] == {"position": 80}
        assert body["device"]["state"]["reported"]["moving"] == "opening"
        blind.advance_covers()
        r = bc.post("/devices/blind/refresh")
        assert r.json()["state"]["reported"]["position"] == 80 and r.json()["state"]["pending"] is False

        # Gen1 relay uses the Gen1 API
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "shelly",
                    "id": "garage",
                    "name": "Garage",
                    "type": "switch",
                    "host": "192.168.1.72",
                    "gen": 1,
                    "component": "switch",
                }
            },
        )
        assert r.status_code == 201 and r.json()["config"]["gen"] == 1
        assert wait_for(lambda: online(bc, "garage"))
        bc.c.patch(
            "/api/v1/devices/garage", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h
        )
        assert (
            bc.post("/devices/garage/commands", {"command": "toggle", "requestId": "g1"}).json()["outcome"]
            == "confirmed"
        )
        assert "GET /relay/0?turn=toggle" in gen1.requests

        # integration status + secrets
        shelly = next(i for i in bc.get("/integrations").json()["integrations"] if i["name"] == "shelly")
        assert shelly["state"] == "connected" and shelly["lastSuccessAt"]
        assert PASSWORD not in bc.get("/config/export").text and PASSWORD not in (tmp_path / "config.json").read_text()
        assert PASSWORD in (tmp_path / "secrets.json").read_text()
        assert PASSWORD not in caplog.text
    finally:
        client.__exit__(None, None, None)


def test_shelly_unreachable_device_goes_offline(tmp_path: Path) -> None:
    fakes: dict[str, Any] = {"192.168.1.80": FakeShellyGen2(switches=1)}
    client, bc = shelly_hub(tmp_path, fakes)
    try:
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "shelly",
                    "id": "lamp",
                    "name": "Lamp",
                    "type": "light",
                    "host": "192.168.1.80",
                    "gen": 2,
                    "component": "switch",
                }
            },
        )
        assert r.status_code == 201
        assert wait_for(lambda: online(bc, "lamp"))
        bc.c.patch("/api/v1/devices/lamp", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h)
        fakes.pop("192.168.1.80")  # the device disappears from the network
        r = bc.post("/devices/lamp/commands", {"command": "turn_on", "requestId": "l1"})
        # Both answers are truthful 503s: the command itself failed to reach the device (SHELLY_UNREACHABLE), or the
        # poll started by the PATCH above noticed the disappearance first (DEVICE_UNAVAILABLE). Which one wins is a race
        # under CPU load; the HTTP-error mapping itself is asserted by the identify test.
        assert r.status_code == 503 and r.json()["error"]["code"] in ("SHELLY_UNREACHABLE", "DEVICE_UNAVAILABLE")
        assert wait_for(lambda: bc.get("/devices/lamp").json()["connection"]["status"] == "offline", timeout=10)
        r = bc.post("/devices/lamp/commands", {"command": "turn_on", "requestId": "l2"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "DEVICE_UNAVAILABLE"
        state = next(i for i in bc.get("/integrations").json()["integrations"] if i["name"] == "shelly")["state"]
        assert state == "disconnected"
    finally:
        client.__exit__(None, None, None)
