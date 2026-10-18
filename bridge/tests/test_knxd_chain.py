"""The KNX USB path, minus the USB stick: hub --KNXnet/IP tunnel--> REAL knxd --> interface --> bus.

knxd (Debian package, 0.14.x) is started exactly as the SE7ENX knxd container starts it, except that
its interface driver is ``ipt:`` (a KNXnet/IP tunnel to the fake interface) instead of ``usb:``.
Everything SE7ENX does (connect, read, write, feedback, commissioning, chain diagnostics) goes
through the real knxd. Skipped when knxd is not installed.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest
from fake_knx_interface import Actuator
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app

from .conftest import BridgeClient, FakeHandle, make_settings, wait_for
from .test_knx_devices import enable

KNXD = shutil.which("knxd")
pytestmark = pytest.mark.skipif(KNXD is None, reason="knxd is not installed")


def _free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_hub_through_real_knxd_reaches_verified(tmp_path: Path) -> None:
    fake = FakeHandle(actuator=Actuator(switch="1/1/1", status="1/1/2"))
    port = _free_udp_port()
    knxd = subprocess.Popen(
        [
            str(KNXD),
            "--eibaddr=0.0.1",
            "--client-addrs=0.0.2:8",
            "--Name=SE7ENX knxd",
            "--error=4",
            "-D",
            "-T",
            f"--Server=224.0.23.12:{port}",
            f"--layer2=ipt:127.0.0.1:{fake.port}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    client = None
    try:
        assert wait_for(lambda: bool(fake.call(lambda f: f.clients)), timeout=10), (
            "knxd did not connect to the interface"
        )
        settings = make_settings(
            fake, gateway_port=port, data_dir=str(tmp_path), device_min_interval_ms=0, allowed_group_addresses=()
        )
        client = TestClient(create_app(settings))
        client.__enter__()
        bc = BridgeClient(client)
        bc.pair()
        assert wait_for(lambda: bc.get("/knx/status").json()["state"] == "connected", timeout=10)
        status = bc.get("/knx/status").json()
        assert status["localAddress"].startswith("0.0.")  # address handed out by knxd's client pool

        device = {
            "integration": "knx",
            "id": "lamp",
            "name": "Lamp",
            "type": "light",
            "switch": "1/1/1",
            "switchStatus": "1/1/2",
        }
        assert bc.post("/devices", {"device": device}).status_code == 201
        r = bc.post("/devices/lamp/commissioning", {"step": "read", "requestId": "k1"})
        assert r.json()["evidence"]["ok"] is True, r.json()
        enable(bc, "lamp")
        r = bc.post(
            "/devices/lamp/commissioning", {"step": "switch", "value": "on", "confirm": True, "requestId": "k2"}
        )
        assert r.json()["evidence"]["detail"]["outcome"] == "confirmed", r.json()
        assert ("write", "1/1/1", 1) in fake.received()  # the telegram really crossed knxd
        r = bc.post("/devices/lamp/commissioning", {"step": "observe", "observed": True, "requestId": "k3"})
        assert r.json()["assessment"]["level"] == "verified"

        chain = {s["id"]: s for s in bc.get("/integrations/knx/chain").json()["steps"]}
        assert chain["interface"]["state"] == "ok" and chain["interface"]["knxd"] is True
        assert chain["tunnel"]["state"] == "ok"
        assert chain["bus"]["state"] == "ok" and chain["bus"]["detail"]["groupAddress"] == "1/1/2"
    finally:
        if client is not None:
            client.__exit__(None, None, None)
        knxd.terminate()
        try:
            knxd.wait(timeout=5)
        except subprocess.TimeoutExpired:
            knxd.kill()
        fake.close()
    time.sleep(0.1)
