"""Commissioning / verification levels, against the real xknx stack and the fake KNX interface."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core.commissioning import CommissioningService, fingerprint
from se7enx_bridge.core.db import Database

from .accounts import account_settings, add_sim_light, owner_api, user_api
from .test_knx_devices import enable, hub, knx_fake

SWITCH = {
    "integration": "knx",
    "id": "kitchen",
    "name": "Kitchen",
    "type": "light",
    "switch": "1/1/1",
    "switchStatus": "1/1/2",
}
NO_FEEDBACK = {"integration": "knx", "id": "plain", "name": "No feedback", "type": "switch", "switch": "4/1/1"}


def step(bc: Any, device_id: str, body: dict[str, Any], rid: str) -> Any:
    return bc.post(f"/devices/{device_id}/commissioning", {**body, "requestId": rid})


def test_knx_device_reaches_verified_only_with_feedback_and_observation(tmp_path: Path) -> None:
    fake = knx_fake()
    client, bc = hub(tmp_path, fake)
    try:
        assert bc.post("/devices", {"device": SWITCH}).status_code == 201
        assert bc.get("/devices/kitchen/commissioning").json()["level"] in ("configured", "connected")

        r = step(bc, "kitchen", {"step": "read"}, "c1")
        assert r.status_code == 200, r.text
        assert r.json()["evidence"]["ok"] is True and r.json()["evidence"]["detail"]["source"] in ("read", "status")
        assert r.json()["assessment"]["level"] == "connected"

        # switch tests move real equipment: explicit confirmation required
        r = step(bc, "kitchen", {"step": "switch", "value": "on"}, "c2")
        assert r.status_code == 400 and r.json()["error"]["code"] == "CONFIRMATION_REQUIRED"
        # control not enabled yet: refused by the normal pipeline, recorded as failed evidence
        r = step(bc, "kitchen", {"step": "switch", "value": "on", "confirm": True}, "c3")
        assert r.status_code == 200 and r.json()["evidence"]["ok"] is False
        assert r.json()["evidence"]["detail"]["error"] == "CONTROL_NOT_ENABLED"
        # observing without a successful switch test is not possible
        assert step(bc, "kitchen", {"step": "observe", "observed": True}, "c4").status_code == 409

        enable(bc, "kitchen")
        r = step(bc, "kitchen", {"step": "switch", "value": "on", "confirm": True}, "c5")
        ev = r.json()["evidence"]
        assert ev["ok"] is True and ev["detail"]["outcome"] == "confirmed", ev
        assert ("write", "1/1/1", 1) in [(k, ga, v) for k, ga, v in fake.received()]
        assert r.json()["assessment"]["level"] == "connected"  # feedback alone is not verification

        r = step(bc, "kitchen", {"step": "observe", "observed": True}, "c6")
        a = r.json()["assessment"]
        assert a["level"] == "verified" and a["verifiedAt"] and a["verifiedBy"]
        assert bc.get("/commissioning").json()["devices"]["kitchen"]["level"] == "verified"

        r = step(bc, "kitchen", {"step": "reset"}, "c7")
        assert r.json()["assessment"]["level"] == "connected"
    finally:
        client.__exit__(None, None, None)


def test_without_feedback_a_device_cannot_be_verified(tmp_path: Path) -> None:
    fake = knx_fake()
    client, bc = hub(tmp_path, fake)
    try:
        assert bc.post("/devices", {"device": NO_FEEDBACK}).status_code == 201
        enable(bc, "plain")
        r = step(bc, "plain", {"step": "switch", "value": "on", "confirm": True}, "n1")
        ev = r.json()["evidence"]
        assert ev["ok"] is False and ev["detail"]["outcome"] == "accepted"
        assert "did not confirm" in ev["detail"]["message"]
        assert step(bc, "plain", {"step": "observe", "observed": True}, "n2").status_code == 409
        assert r.json()["assessment"]["level"] != "verified"
    finally:
        client.__exit__(None, None, None)


def test_failed_observation_and_simulated_devices(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path, autoconnect=False, device_min_interval_ms=0))) as c:
        owner = owner_api(c)
        add_sim_light(owner, "lamp")
        r = owner.post(
            "/devices/lamp/commissioning", {"step": "switch", "value": "on", "confirm": True, "requestId": "s1"}
        )
        assert r.json()["evidence"]["ok"] is True and r.json()["evidence"]["detail"]["outcome"] == "simulated"
        r = owner.post("/devices/lamp/commissioning", {"step": "observe", "observed": True, "requestId": "s2"})
        assert r.json()["assessment"]["level"] == "simulated"  # never presented as real
        # a failed observation is recorded and shown
        owner.post(
            "/devices/lamp/commissioning", {"step": "switch", "value": "off", "confirm": True, "requestId": "s3"}
        )
        r = owner.post("/devices/lamp/commissioning", {"step": "observe", "observed": False, "requestId": "s4"})
        assert r.json()["assessment"]["lastFailure"]["step"] == "observe"

        user = user_api(c, owner, "user")
        assert user.get("/devices/lamp/commissioning").status_code == 200
        denied = user.post("/devices/lamp/commissioning", {"step": "read", "requestId": "s5"})
        assert denied.status_code == 403  # commissioning needs device.configure

        entries = owner.get("/audit", params={"action": "device.commissioning"}).json()["entries"]
        assert len(entries) >= 4 and all(e["target"]["id"] == "lamp" for e in entries)

        assert owner.delete("/devices/lamp").status_code == 204
        add_sim_light(owner, "lamp")  # same id again: old evidence must not carry over
        assert owner.get("/devices/lamp/commissioning").json()["history"] == []


def test_config_change_invalidates_verification(tmp_path: Path) -> None:
    svc = CommissioningService(Database(None))
    dev = {
        "id": "k",
        "integration": "knx",
        "type": "light",
        "simulated": False,
        "config": {"switch": "1/1/1", "switchStatus": "1/1/2"},
        "connection": {"status": "online"},
        "state": {"reportedAt": "2026-10-18T10:00:00Z", "source": "read"},
    }
    fp = fingerprint(dev)
    svc.record("k", fp, "switch", True, {"outcome": "confirmed"}, None, "amina")
    svc.record("k", fp, "observe", True, {"observed": True}, None, "amina")
    assert svc.assess(dev)["level"] == "verified"
    moved = {**dev, "config": {"switch": "1/1/9", "switchStatus": "1/1/2"}}  # another group address
    assert fingerprint(moved) != fp
    assert svc.assess(moved)["level"] == "connected"
    renamed = {**dev, "config": {**dev["config"], "name": "Kitchen (renamed)"}}
    assert fingerprint(renamed) == fp  # cosmetics do not invalidate
