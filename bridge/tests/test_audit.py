"""Audit ledger (I-01): actors, sources, real outcomes, no secrets, retention."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core.audit import Actor, AuditLog, sanitize
from se7enx_bridge.core.db import Database

from .accounts import OWNER_PW, account_settings, add_sim_light, login, owner_api


def test_ledger_records_who_what_via_which_interface_and_the_real_outcome() -> None:
    with TestClient(create_app(account_settings())) as c:
        api = owner_api(c)
        add_sim_light(api)
        assert login(c, "ghost", "some wrong passphrase").status_code == 401
        assert login(c, OWNER_PW, "typed password into the username field").status_code == 401
        r = api.post(
            "/devices/lamp/commands",
            {"command": "set_brightness", "params": {"brightness": 40}, "requestId": "g-1", "source": "gesture"},
        )
        assert r.status_code == 200
        bad = api.post("/devices/lamp/commands", {"command": "open", "requestId": "g-2", "source": "voice"})
        assert bad.status_code == 400

        entries = api.get("/audit").json()["entries"]
        actions = [e["action"] for e in entries]
        assert {"auth.setup", "device.added", "device.command", "auth.login"} <= set(actions)
        cmd = next(e for e in entries if e["action"] == "device.command" and e["outcome"] == "simulated")
        assert cmd["source"] == "gesture" and cmd["actor"]["name"] == "amina" and cmd["actor"]["role"] == "owner"
        assert cmd["details"]["params"] == {"brightness": 40} and cmd["target"] == {"type": "device", "id": "lamp"}
        failed = next(e for e in entries if e["action"] == "device.command" and e["outcome"] == "failed")
        assert failed["source"] == "voice" and failed["details"]["error"] == "UNSUPPORTED_COMMAND"
        logins = [e for e in entries if e["action"] == "auth.login" and e["outcome"] == "failed"]
        assert {e["actor"]["name"] for e in logins} == {"unknown account"}  # typed strings are never stored
        blob = json.dumps(entries)
        assert OWNER_PW not in blob and "violet" not in blob and "token" not in blob.lower()

        filtered = api.get("/audit", params={"action": "device.", "limit": 1}).json()
        assert len(filtered["entries"]) == 1 and filtered["next"] is not None


def test_sanitize_drops_credentials_and_bounds_size() -> None:
    out = sanitize(
        {
            "password": "x",
            "apiKey": "y",
            "sessionToken": "z",
            "name": "a" * 500,
            "nested": {"secret": 1, "ok": [1] * 50},
        }
    )
    assert set(out) == {"name", "nested"}
    assert len(out["name"]) == 200 and out["nested"] == {"ok": [1] * 20}


def test_retention_purges_old_entries() -> None:
    now = [10_000_000.0]
    log = AuditLog(Database(None), retention_days=30, clock=lambda: now[0])
    log.record("old.thing", actor=Actor("u", "amina", "owner"))
    now[0] += 31 * 86400
    log.record("new.thing")
    assert log.purge() == 1
    assert [e["action"] for e in log.query()] == ["new.thing"]
