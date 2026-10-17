"""KNX device mapping against the REAL xknx stack talking KNXnet/IP (UDP) to the FAKE tunnelling
interface. Assertions check the exact telegrams that reach the (fake) bus."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fake_knx_interface import Actuator
from fastapi.testclient import TestClient
from xknx.dpt import DPTArray

from se7enx_bridge.api import create_app
from se7enx_bridge.devices.adapters.knx import step_code_for

from .conftest import BridgeClient, FakeHandle, make_settings, wait_for

LIGHT = {
    "integration": "knx",
    "id": "kitchen",
    "name": "Kitchen",
    "type": "light",
    "switch": "1/1/1",
    "switchStatus": "1/1/2",
    "brightness": "1/2/1",
    "brightnessStatus": "1/2/2",
    "dim": "1/3/1",
}
BLIND = {
    "integration": "knx",
    "id": "blind",
    "name": "Blind",
    "type": "cover",
    "upDown": "2/1/1",
    "stop": "2/1/2",
    "position": "2/1/3",
    "positionStatus": "2/1/4",
}
SENSOR = {
    "integration": "knx",
    "id": "temp",
    "name": "Temperature",
    "type": "sensor",
    "value": "3/1/1",
    "valueDpt": "9.001",
}
PLAIN = {"integration": "knx", "id": "plain", "name": "No feedback", "type": "switch", "switch": "4/1/1"}


def knx_fake(**kw: Any) -> FakeHandle:
    return FakeHandle(
        actuator=Actuator(switch="1/1/1", status="1/1/2"),
        mirrors={"1/2/1": "1/2/2", "2/1/3": "2/1/4"},
        objects={"3/1/1": DPTArray((0x0C, 0x33))},  # 21.5 °C (DPT 9.001)
        **kw,
    )


def hub(tmp_path: Path, fake: FakeHandle | None, **overrides: Any) -> tuple[TestClient, BridgeClient]:
    base = {"allowed_group_addresses": (), "data_dir": str(tmp_path), "device_min_interval_ms": 0}
    base.update(overrides)
    client = TestClient(create_app(make_settings(fake, **base)))
    client.__enter__()
    bc = BridgeClient(client)
    bc.pair()
    if fake is not None:
        assert wait_for(lambda: bc.get("/knx/status").json()["state"] == "connected")
    return client, bc


def enable(bc: BridgeClient, device_id: str) -> None:
    r = bc.c.patch(
        f"/api/v1/devices/{device_id}", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h
    )
    assert r.status_code == 200, r.text


def command(bc: BridgeClient, device_id: str, name: str, rid: str, **params: Any) -> Any:
    return bc.post(f"/devices/{device_id}/commands", {"command": name, "params": params, "requestId": rid})


def writes(fake: FakeHandle) -> list[tuple[str, object]]:
    return [(ga, v) for kind, ga, v in fake.received() if kind == "write"]


def test_step_codes() -> None:
    assert step_code_for(None) == 1 and step_code_for(100) == 1 and step_code_for(25) == 3 and step_code_for(2) == 7


def test_knx_light_cover_and_sensor(tmp_path: Path) -> None:
    fake = knx_fake()
    client, bc = hub(tmp_path, fake)
    try:
        for body in (LIGHT, BLIND, SENSOR, PLAIN):
            r = bc.post("/devices", {"device": body})
            assert r.status_code == 201, r.text
        devices = {d["id"]: d for d in bc.get("/devices").json()["devices"]}
        assert devices["kitchen"]["commands"] == [
            "turn_on",
            "turn_off",
            "toggle",
            "set_brightness",
            "adjust_brightness",
            "dim",
        ]
        assert set(devices["blind"]["commands"]) == {"open", "close", "stop", "set_position"}
        assert devices["kitchen"]["connection"]["status"] == "online"
        # explicit GroupValueReads on start-up give the initial sensor value
        assert wait_for(lambda: bc.get("/devices/temp").json()["state"]["reported"] == {"value": 21.5, "unit": "°C"})
        assert command(bc, "temp", "turn_on", "s1").status_code == 400  # sensors are read-only

        before = len(writes(fake))
        assert command(bc, "kitchen", "turn_on", "k0").status_code == 403  # control disabled: nothing on the bus
        assert len(writes(fake)) == before
        enable(bc, "kitchen")

        r = command(bc, "kitchen", "turn_on", "k1")
        assert r.status_code == 200 and r.json()["outcome"] == "confirmed" and r.json()["delivery"] == "bus_confirmed"
        assert r.json()["device"]["state"]["reported"]["on"] is True
        r = command(bc, "kitchen", "set_brightness", "k2", brightness=40)
        assert r.json()["outcome"] == "confirmed" and r.json()["device"]["state"]["reported"]["brightness"] == 40
        assert ("1/2/1", 102) in writes(fake)  # DPT 5.001: 40 % -> 0x66

        # relative dimming (DPT 3.007) is a separate command from absolute brightness
        r = command(bc, "kitchen", "dim", "k3", direction="up")
        assert r.json()["outcome"] == "accepted" and r.json()["delivery"] == "bus_confirmed"
        command(bc, "kitchen", "dim", "k4", direction="stop")
        command(bc, "kitchen", "dim", "k5", direction="down", step=25)
        dims = [v for ga, v in writes(fake) if ga == "1/3/1"]
        assert dims == [0b1001, 0b0000, 0b0011]  # increase+code1 (dim until stop), stop, decrease+code3 (25 %)

        # covers: SE7ENX position 80 (% open) -> KNX 20 % (0 % = open) -> feedback converted back
        enable(bc, "blind")
        r = command(bc, "blind", "set_position", "b1", position=80)
        assert r.json()["outcome"] == "confirmed" and r.json()["device"]["state"]["reported"]["position"] == 80
        assert ("2/1/3", 51) in writes(fake)  # round(20 * 255 / 100)
        command(bc, "blind", "close", "b2")
        command(bc, "blind", "open", "b3")
        command(bc, "blind", "stop", "b4")
        tail = [(ga, v) for ga, v in writes(fake) if ga in ("2/1/1", "2/1/2")]
        assert tail == [("2/1/1", 1), ("2/1/1", 0), ("2/1/2", 1)]  # DPT 1.008: 1 = down/close, 0 = up/open

        # no feedback address: bus confirmation is not reported as a device state confirmation
        enable(bc, "plain")
        r = command(bc, "plain", "turn_on", "p1")
        assert r.json()["outcome"] == "accepted" and r.json()["device"]["state"]["pending"] is True
        r = command(bc, "plain", "toggle", "p2")
        assert r.status_code == 409 and r.json()["error"]["code"] == "STATE_UNKNOWN"

        # sensor updates from the bus
        fake.call(lambda f: f.send_value("3/1/1", DPTArray((0x0C, 0x65))))  # 22.5 °C
        assert wait_for(lambda: bc.get("/devices/temp").json()["state"]["reported"]["value"] == 22.5)

        # only configured group addresses were ever written
        configured = {"1/1/1", "1/2/1", "1/3/1", "2/1/1", "2/1/2", "2/1/3", "4/1/1"}
        assert {ga for ga, _ in writes(fake)} <= configured
        knx = next(i for i in bc.get("/integrations").json()["integrations"] if i["name"] == "knx")
        assert knx["state"] == "connected" and knx["devices"] == 4
    finally:
        client.__exit__(None, None, None)
        fake.close()


def test_operator_allowlist_is_a_ceiling(tmp_path: Path) -> None:
    fake = knx_fake()
    client, bc = hub(tmp_path, fake, allowed_group_addresses=("1/1/1-2",))
    try:
        r = bc.post("/devices", {"device": LIGHT})
        assert (
            r.status_code == 403
            and r.json()["error"]["code"] == "GA_NOT_ALLOWED"
            and "1/2/1" in r.json()["error"]["message"]
        )
        ok = {
            "integration": "knx",
            "id": "ok",
            "name": "OK",
            "type": "light",
            "switch": "1/1/1",
            "switchStatus": "1/1/2",
        }
        assert bc.post("/devices", {"device": ok}).status_code == 201
    finally:
        client.__exit__(None, None, None)
        fake.close()


def test_negative_confirmation_and_link_down(tmp_path: Path) -> None:
    fake = knx_fake(confirm="negative")
    client, bc = hub(tmp_path, fake)
    try:
        assert bc.post("/devices", {"device": PLAIN}).status_code == 201
        enable(bc, "plain")
        r = command(bc, "plain", "turn_on", "n1")
        assert r.status_code >= 500 and r.json()["error"]["code"] == "KNX_NEGATIVE_CONFIRMATION"
        assert bc.get("/devices/plain").json()["state"]["pending"] is False  # a failure is never left "pending"
    finally:
        client.__exit__(None, None, None)
        fake.close()
    # KNX interface not reachable: devices are offline and commands are refused before touching the bus
    client, bc = hub(tmp_path / "offline", None)
    try:
        assert bc.post("/devices", {"device": PLAIN}).status_code == 201
        enable(bc, "plain")
        assert bc.get("/devices/plain").json()["connection"]["status"] == "offline"
        r = command(bc, "plain", "turn_on", "o1")
        assert r.status_code == 503 and r.json()["error"]["code"] == "DEVICE_UNAVAILABLE"
    finally:
        client.__exit__(None, None, None)
