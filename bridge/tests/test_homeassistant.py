"""Server-side Home Assistant adapter against a FAKE Home Assistant (tools/fake_homeassistant.py)
served by a real uvicorn instance, so the hub speaks the WebSocket protocol over a real socket.
Not a real Home Assistant: real-HA validation is listed in the hardware/HA test matrix."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fake_homeassistant import FakeHomeAssistant
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app

from .conftest import BridgeClient, LiveServer, make_settings, wait_for

TOKEN = "fake-ha-long-lived-token-0123456789"  # test credential: must never be echoed


@pytest.fixture
def fake_ha() -> Any:
    ha = FakeHomeAssistant(token=TOKEN)
    server = LiveServer(ha)
    try:
        yield ha, f"http://127.0.0.1:{server.port}"
    finally:
        server.close()


def hub(tmp_path: Path, **overrides: Any) -> tuple[TestClient, BridgeClient]:
    settings = make_settings(None, autoconnect=False, data_dir=str(tmp_path), device_min_interval_ms=0, **overrides)
    client = TestClient(create_app(settings))
    client.__enter__()
    bc = BridgeClient(client)
    bc.pair()
    return client, bc


def ha_state(bc: BridgeClient) -> str:
    return bc.get("/integrations/homeassistant").json()["status"]["state"]


def control(bc: BridgeClient, device_id: str) -> None:
    r = bc.c.patch(
        f"/api/v1/devices/{device_id}", json={"controlEnabled": True, "acknowledgeRealControl": True}, headers=bc.h
    )
    assert r.status_code == 200, r.text


def fake_ctl(url: str, path: str, body: dict[str, Any] | None = None) -> Any:
    if body is None:
        return httpx2.get(f"{url}/_fake/{path}").json()
    return httpx2.post(f"{url}/_fake/{path}", json=body).json()


def test_home_assistant_end_to_end(tmp_path: Path, fake_ha: Any, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    _ha, url = fake_ha
    client, bc = hub(tmp_path)
    try:
        assert ha_state(bc) == "not_configured"
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "homeassistant",
                    "id": "kitchen",
                    "name": "Kitchen",
                    "type": "light",
                    "entityId": "light.kitchen",
                }
            },
        )
        assert r.status_code == 409 and r.json()["error"]["code"] == "HA_NOT_CONNECTED"

        t = bc.post("/integrations/homeassistant/test", {"url": url, "token": TOKEN})
        assert t.status_code == 200 and t.json()["ok"] and t.json()["locationName"] == "FAKE Home"
        bad = bc.post("/integrations/homeassistant/test", {"url": url, "token": "wrong-token-xyz"})
        assert bad.status_code == 400 and bad.json()["error"]["code"] == "HA_AUTH_FAILED"

        r = bc.c.put("/api/v1/integrations/homeassistant", json={"url": url + "/", "token": TOKEN}, headers=bc.h)
        assert r.status_code == 200 and TOKEN not in r.text and r.json()["config"]["tokenStored"] is True
        assert wait_for(lambda: ha_state(bc) == "connected")
        status = bc.get("/integrations/homeassistant").json()["status"]
        assert status["haVersion"] == "2026.10.0-fake" and status["lastSuccessAt"] and status["url"] == url

        entities = {e["entityId"]: e for e in bc.get("/integrations/homeassistant/entities").json()["entities"]}
        assert "lock.front_door" not in entities  # unsupported domains are not offered
        assert entities["light.kitchen"]["capabilities"] == ["brightness", "on_off"]
        assert entities["light.porch"]["capabilities"] == ["on_off"]  # onoff colour mode: no brightness

        for body in (
            {"id": "kitchen", "name": "Kitchen", "type": "light", "entityId": "light.kitchen"},
            {"id": "porch", "name": "Porch", "type": "light", "entityId": "light.porch"},
            {"id": "garage", "name": "Garage door", "type": "cover", "entityId": "cover.garage"},
            {"id": "hall-temp", "name": "Hall", "type": "sensor", "entityId": "sensor.hall_temperature"},
        ):
            r = bc.post("/devices", {"device": {"integration": "homeassistant", **body}})
            assert r.status_code == 201, r.text
        r = bc.post(
            "/devices",
            {
                "device": {
                    "integration": "homeassistant",
                    "id": "ghost",
                    "name": "Ghost",
                    "type": "light",
                    "entityId": "light.ghost",
                }
            },
        )
        assert r.status_code == 404 and r.json()["error"]["code"] == "HA_ENTITY_NOT_FOUND"

        devices = {d["id"]: d for d in bc.get("/devices").json()["devices"]}
        assert devices["kitchen"]["commands"] == [
            "turn_on",
            "turn_off",
            "toggle",
            "set_brightness",
            "adjust_brightness",
        ]
        assert devices["porch"]["commands"] == ["turn_on", "turn_off", "toggle"]
        assert set(devices["garage"]["commands"]) == {"open", "close", "stop", "set_position"}
        assert devices["hall-temp"]["commands"] == [] and devices["hall-temp"]["state"]["reported"] == {
            "value": 21.4,
            "unit": "°C",
        }
        assert devices["kitchen"]["connection"]["status"] == "online"

        control(bc, "kitchen")
        r = bc.post(
            "/devices/kitchen/commands", {"command": "set_brightness", "params": {"brightness": 40}, "requestId": "k1"}
        )
        assert r.status_code == 200 and r.json()["outcome"] == "confirmed" and r.json()["delivery"] == "service_call_ok"
        assert r.json()["device"]["state"]["reported"] == {"on": True, "brightness": 40}
        assert ["light", "turn_on", {"brightness_pct": 40}, {"entity_id": "light.kitchen"}] in fake_ctl(url, "info")[
            "calls"
        ]
        r = bc.post(
            "/devices/porch/commands", {"command": "set_brightness", "params": {"brightness": 40}, "requestId": "k2"}
        )
        assert r.status_code == 400  # not dimmable: refused by the hub, never sent to HA

        # no feedback from HA -> accepted (not confirmed), requested state stays pending
        fake_ctl(url, "options", {"emit_feedback": False})
        r = bc.post("/devices/kitchen/commands", {"command": "turn_off", "requestId": "k3"})
        assert r.json()["outcome"] == "accepted" and r.json()["device"]["state"]["pending"] is True
        # HA reports a DIFFERENT state than requested (e.g. a light that limits brightness): not confirmed
        fake_ctl(url, "options", {"emit_feedback": True, "brightness_override": 30})
        r = bc.post(
            "/devices/kitchen/commands", {"command": "set_brightness", "params": {"brightness": 80}, "requestId": "k3b"}
        )
        st = r.json()["device"]["state"]
        assert (
            r.json()["outcome"] == "accepted"
            and st["reported"]["brightness"] == 30
            and st["requested"] == {"brightness": 80}
        )
        fake_ctl(url, "options", {"brightness_override": None})
        fake_ctl(url, "options", {"emit_feedback": True, "fail_services": True})
        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "k4"})
        assert r.status_code == 502 and r.json()["error"]["code"] == "HA_SERVICE_FAILED"
        fake_ctl(url, "options", {"fail_services": False})

        # changes made in HA itself (e.g. a wall switch) arrive as reported state
        fake_ctl(url, "state", {"entity_id": "light.kitchen", "state": "on", "attributes": {"brightness": 255}})
        assert wait_for(
            lambda: bc.get("/devices/kitchen").json()["state"]["reported"] == {"on": True, "brightness": 100}
        )
        fake_ctl(url, "state", {"entity_id": "light.kitchen", "state": "unavailable"})
        assert wait_for(lambda: bc.get("/devices/kitchen").json()["connection"]["status"] == "unavailable")
        r = bc.post("/devices/kitchen/commands", {"command": "turn_on", "requestId": "k5"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "DEVICE_UNAVAILABLE"
        fake_ctl(url, "state", {"entity_id": "light.kitchen", "state": "off"})

        # Home Assistant restarts: the hub reconnects by itself
        fake_ctl(url, "drop", {})
        assert wait_for(lambda: ha_state(bc) != "connected", timeout=5)
        assert wait_for(lambda: ha_state(bc) == "connected", timeout=10)
        assert wait_for(lambda: bc.get("/devices/kitchen").json()["connection"]["status"] == "online")

        # the token never leaves the server
        for text in (
            bc.get("/integrations/homeassistant").text,
            bc.get("/config/export").text,
            bc.get("/devices").text,
            (tmp_path / "config.json").read_text(),
            caplog.text,
        ):
            assert TOKEN not in text
        assert TOKEN in (tmp_path / "secrets.json").read_text()

        assert bc.c.delete("/api/v1/integrations/homeassistant", headers=bc.h).status_code == 204
        assert wait_for(lambda: ha_state(bc) == "not_configured")
        assert TOKEN not in (tmp_path / "secrets.json").read_text()
    finally:
        client.__exit__(None, None, None)


def test_invalid_token_is_not_retried(tmp_path: Path, fake_ha: Any) -> None:
    _ha, url = fake_ha
    client, bc = hub(tmp_path)
    try:
        bc.c.put(
            "/api/v1/integrations/homeassistant", json={"url": url, "token": "revoked-or-wrong-token"}, headers=bc.h
        )
        assert wait_for(lambda: ha_state(bc) == "auth_failed")
        attempts = fake_ctl(url, "info")["auth_attempts"]
        time.sleep(3)
        assert fake_ctl(url, "info")["auth_attempts"] == attempts  # no retry storm (HA could ban the IP)
        err = bc.get("/integrations/homeassistant").json()["status"]["lastError"]
        assert err["code"] == "HA_AUTH_FAILED"
        # fixing the token reconnects immediately
        bc.c.put("/api/v1/integrations/homeassistant", json={"url": url, "token": TOKEN}, headers=bc.h)
        assert wait_for(lambda: ha_state(bc) == "connected")
    finally:
        client.__exit__(None, None, None)


def test_unreachable_home_assistant(tmp_path: Path) -> None:
    client, bc = hub(tmp_path)
    try:
        bc.c.put("/api/v1/integrations/homeassistant", json={"url": "http://127.0.0.1:9", "token": TOKEN}, headers=bc.h)
        assert wait_for(lambda: ha_state(bc) == "disconnected")
        status = bc.get("/integrations/homeassistant").json()["status"]
        assert status["lastError"]["code"] == "HA_UNREACHABLE" and status["lastSuccessAt"] is None
        r = bc.post("/integrations/homeassistant/test", {})
        assert r.status_code == 502 and r.json()["error"]["code"] == "HA_UNREACHABLE"
        assert (
            bc.c.put(
                "/api/v1/integrations/homeassistant", json={"url": "ftp://ha", "token": TOKEN}, headers=bc.h
            ).status_code
            == 422
        )
    finally:
        client.__exit__(None, None, None)


def test_environment_configuration_is_read_only(tmp_path: Path, fake_ha: Any) -> None:
    _ha, url = fake_ha
    client, bc = hub(tmp_path, ha_url=url, ha_token=TOKEN)
    try:
        assert wait_for(lambda: ha_state(bc) == "connected")
        cfg = bc.get("/integrations/homeassistant").json()["config"]
        assert cfg["source"] == "environment" and cfg["readOnly"] is True and cfg["tokenStored"] is True
        r = bc.c.put("/api/v1/integrations/homeassistant", json={"url": url, "token": TOKEN}, headers=bc.h)
        assert r.status_code == 409 and r.json()["error"]["code"] == "HA_CONFIGURED_BY_ENV"
        assert not (tmp_path / "secrets.json").exists() or TOKEN not in (tmp_path / "secrets.json").read_text()
    finally:
        client.__exit__(None, None, None)
