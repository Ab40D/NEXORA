"""HTTP API tests against the REAL xknx stack talking KNXnet/IP (UDP) to a fake
tunnelling interface with a simulated actuator."""

from __future__ import annotations

import http.client
import json

from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app

from .conftest import ORIGIN, PAIRING_CODE, BridgeClient, FakeHandle, LiveServer, make_settings, wait_for

LIGHT = {"switchAddress": "0/0/1", "statusAddress": "0/0/2", "dpt": "1.001", "onLevel": 100}


def register(bridge: BridgeClient, body: dict | None = None) -> dict:
    r = bridge.put("/lights/primary", body or LIGHT)
    assert r.status_code == 200, r.text
    return r.json()


def cmd(bridge: BridgeClient, value: str, rid: str = "r1"):
    return bridge.post(f"/lights/primary/{value}", {"requestId": rid, "source": "manual"})


# ------------------------------------------------------------------ public / security


def test_health_is_minimal_and_unauthenticated() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        r = c.get("/api/v1/health")
        assert r.status_code == 200
        body = r.json()
        assert body == {
            "ok": True,
            "service": "se7enx-bridge",
            "version": body["version"],
            "apiVersion": 1,
            "pairingRequired": True,
        }
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["cache-control"] == "no-store"


def test_cors_preflight_and_private_network_access() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        r = c.options(
            "/api/v1/lights/primary/on",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert r.status_code == 204
        assert r.headers["access-control-allow-origin"] == ORIGIN
        assert "Authorization" in r.headers["access-control-allow-headers"]
        assert r.headers["access-control-allow-private-network"] == "true"
        assert "access-control-allow-credentials" not in r.headers


def test_foreign_origin_rejected_everywhere() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        evil = {"Origin": "https://evil.example"}
        assert c.options("/api/v1/pair", headers={**evil, "Access-Control-Request-Method": "POST"}).status_code == 403
        r = c.post("/api/v1/pair", json={"code": PAIRING_CODE}, headers=evil)
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"
        assert "access-control-allow-origin" not in r.headers
        assert c.get("/api/v1/health", headers={"Origin": "null"}).status_code == 403


def test_auth_required_for_everything_sensitive() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        for method, path in [
            ("get", "/api/v1/session"),
            ("get", "/api/v1/knx/status"),
            ("post", "/api/v1/knx/connect"),
            ("post", "/api/v1/knx/test"),
            ("put", "/api/v1/lights/primary"),
            ("post", "/api/v1/lights/primary/on"),
            ("get", "/api/v1/events"),
        ]:
            r = getattr(c, method)(
                path,
                headers={"Origin": ORIGIN, "Authorization": "Bearer not-a-real-token"},
                **({"json": {}} if method in ("post", "put") else {}),
            )
            assert r.status_code == 401, (method, path, r.text)
            assert r.headers["www-authenticate"] == "Bearer"


def test_pairing_wrong_code_rate_limit_and_success() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        h = {"Origin": ORIGIN}
        r = c.post("/api/v1/pair", json={"code": "WRONG123"}, headers=h)
        assert r.status_code == 401 and r.json()["error"]["code"] == "PAIRING_FAILED"
        r = c.post("/api/v1/pair", json={"code": PAIRING_CODE.lower(), "clientName": "x"}, headers=h)
        assert r.status_code == 200
        token = r.json()["token"]
        assert len(token) >= 40
        for _ in range(4):
            c.post("/api/v1/pair", json={"code": "WRONG123"}, headers=h)
        r = c.post("/api/v1/pair", json={"code": PAIRING_CODE}, headers=h)
        assert r.status_code == 429 and "retry-after" in r.headers
        # revocation
        auth = {**h, "Authorization": f"Bearer {token}"}
        assert c.get("/api/v1/session", headers=auth).status_code == 200
        assert c.post("/api/v1/session/revoke", headers=auth, json={}).status_code == 204
        assert c.get("/api/v1/session", headers=auth).status_code == 401


def test_docs_disabled_and_body_limit() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        assert c.get("/docs").status_code == 404
        assert c.get("/openapi.json").status_code == 404
        r = c.post("/api/v1/pair", content=b"x" * 20000, headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        assert r.status_code == 413


def test_gateway_override_disabled_by_default_and_restricted_when_enabled() -> None:
    with TestClient(create_app(make_settings(None))) as c:
        b = BridgeClient(c)
        b.pair()
        r = b.post("/knx/connect", {"override": {"connectionType": "tunneling", "host": "192.168.1.20", "port": 3671}})
        assert r.status_code == 403 and r.json()["error"]["code"] == "GATEWAY_OVERRIDE_DISABLED"
    with TestClient(create_app(make_settings(None, allow_client_gateway=True))) as c:
        b = BridgeClient(c)
        b.pair()
        for host in ("8.8.8.8", "127.0.0.1", "example.com", "192.168.1.300"):
            r = b.post("/knx/connect", {"override": {"connectionType": "tunneling", "host": host}})
            assert r.status_code in (403, 422), (host, r.text)


def test_light_validation_and_default_deny_policy() -> None:
    with TestClient(create_app(make_settings(None, allowed_group_addresses=()))) as c:
        b = BridgeClient(c)
        b.pair()
        r = b.put("/lights/primary", LIGHT)
        assert r.status_code == 403 and r.json()["error"]["code"] == "GA_NOT_ALLOWED"
    with TestClient(create_app(make_settings(None))) as c:
        b = BridgeClient(c)
        b.pair()
        assert (
            b.put("/lights/primary", {**LIGHT, "switchAddress": "0/0/0"}).json()["error"]["code"]
            == "INVALID_GROUP_ADDRESS"
        )
        assert b.put("/lights/primary", {**LIGHT, "switchAddress": "1/2/3"}).status_code == 403
        assert b.put("/lights/primary", {**LIGHT, "statusAddress": "5/5/5"}).status_code == 403
        assert b.put("/lights/primary", {**LIGHT, "dpt": "9.001"}).status_code == 422
        assert b.put("/lights/primary", {**LIGHT, "extra": 1}).status_code == 422
        assert b.put("/lights/Bad_ID", LIGHT).status_code == 422
        r = b.post("/lights/primary/on", {"requestId": "x", "source": "manual"})
        assert r.status_code == 404
        # not connected to KNX → commands refused with a clear code, never "success"
        assert b.put("/lights/primary", LIGHT).status_code == 200
        r = b.post("/lights/primary/on", {"requestId": "x", "source": "manual"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "KNX_NOT_CONNECTED"
        assert b.post("/lights/primary/on", {"requestId": "bad id!", "source": "manual"}).status_code == 422
        assert b.post("/lights/primary/on", {"requestId": "y", "source": "telepathy"}).status_code == 422


# ------------------------------------------------------------------ end to end over KNXnet/IP


def test_session_reports_connection_and_policy(bridge: BridgeClient) -> None:
    info = bridge.get("/session").json()
    assert info["knx"]["state"] == "connected"
    assert info["knx"]["confirmation"] == "interface"
    assert info["knx"]["gateway"]["name"].startswith("SE7ENX FAKE KNX")
    assert info["policy"]["allowedGroupAddresses"] == ["0/0/1-9"]


def test_command_is_bus_confirmed_and_feedback_updates_state(bridge: BridgeClient, fake: FakeHandle) -> None:
    register(bridge)
    r = cmd(bridge, "on")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "bus_confirmed"
    assert body["confirmation"] == "interface_positive"
    assert body["telegram"] == {"destination": "0/0/1", "payload": 1}
    assert ("write", "0/0/1", 1) in fake.received()
    assert wait_for(lambda: bridge.get("/lights/primary/state").json()["value"] == "on")
    st = bridge.get("/lights/primary/state").json()
    assert st["via"] == "status_address"


def test_idempotent_request_ids_never_send_twice(bridge: BridgeClient, fake: FakeHandle) -> None:
    register(bridge)
    first = cmd(bridge, "off", rid="same-id").json()
    second = cmd(bridge, "off", rid="same-id").json()
    assert first == second
    writes = [x for x in fake.received() if x[0] == "write"]
    assert len(writes) == 1


def test_refresh_reads_status_address(bridge: BridgeClient, fake: FakeHandle) -> None:
    fake.call(lambda f: setattr(f.actuator, "value", 1))
    register(bridge)
    st = bridge.get("/lights/primary/state", params={"refresh": "1"}).json()
    assert st["value"] == "on" and st["via"] == "read_response"
    assert ("read", "0/0/2", None) in fake.received()


def test_negative_and_missing_confirmation_are_errors(bridge: BridgeClient, fake: FakeHandle) -> None:
    register(bridge)
    fake.call(lambda f: setattr(f, "confirm", "negative"))
    r = cmd(bridge, "on", rid="neg")
    assert r.status_code == 502 and r.json()["error"]["code"] == "KNX_NEGATIVE_CONFIRMATION"
    fake.call(lambda f: setattr(f, "confirm", "none"))
    r = cmd(bridge, "on", rid="none")
    assert r.status_code == 504 and r.json()["error"]["code"] == "KNX_CONFIRMATION_TIMEOUT"
    assert r.json()["error"]["hint"]


def test_dpt_5001_payload(bridge: BridgeClient, fake: FakeHandle) -> None:
    register(bridge, {**LIGHT, "dpt": "5.001", "onLevel": 50, "statusAddress": None})
    body = cmd(bridge, "on").json()
    assert body["telegram"]["payload"] == [128]


def test_connectivity_test_never_writes(bridge: BridgeClient, fake: FakeHandle) -> None:
    r = bridge.post("/knx/test", {})
    assert r.status_code == 200
    checks = {c["id"]: c for c in r.json()["checks"]}
    assert checks["link"]["ok"] and checks["interface"]["ok"] and checks["policy"]["ok"]
    assert [x for x in fake.received() if x[0] == "write"] == []
    r = bridge.post("/knx/test", {"readAddress": "0/0/2"})
    assert {c["id"]: c for c in r.json()["checks"]}["read"]["ok"]
    assert bridge.post("/knx/test", {"readAddress": "5/5/5"}).status_code == 403


def test_command_rate_limit(fake: FakeHandle) -> None:
    app = create_app(make_settings(fake, command_limit=2, command_window_s=60.0))
    with TestClient(app) as c:
        b = BridgeClient(c)
        b.pair()
        assert wait_for(lambda: b.get("/knx/status").json()["state"] == "connected")
        register(b)
        assert cmd(b, "on", "a").status_code == 200
        assert cmd(b, "off", "b").status_code == 200
        r = cmd(b, "on", "c")
        assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


def _http(port: int, method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    resp = conn.getresponse()
    data = json.loads(resp.read() or b"{}")
    conn.close()
    return resp.status, data


def test_event_stream_delivers_hello_and_live_state(live: LiveServer, fake: FakeHandle) -> None:
    status, paired = _http(live.port, "POST", "/api/v1/pair", {"code": PAIRING_CODE, "clientName": "sse"})
    assert status == 200
    token = paired["token"]
    assert wait_for(lambda: _http(live.port, "GET", "/api/v1/knx/status", token=token)[1].get("state") == "connected")
    assert _http(live.port, "PUT", "/api/v1/lights/primary", LIGHT, token)[0] == 200

    conn = http.client.HTTPConnection("127.0.0.1", live.port, timeout=10)
    conn.request(
        "GET",
        "/api/v1/events",
        headers={"Origin": ORIGIN, "Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
    )
    resp = conn.getresponse()
    assert resp.status == 200
    assert resp.getheader("content-type", "").startswith("text/event-stream")
    assert resp.getheader("access-control-allow-origin") == ORIGIN
    assert "no-transform" in resp.getheader("cache-control", "")  # proxies must not buffer/compress SSE

    events: list[tuple[str, dict]] = []
    current = None
    triggered = False
    for _ in range(200):  # bounded; the socket timeout prevents hangs
        line = resp.fp.readline().decode().rstrip("\r\n")
        if line.startswith("event: "):
            current = line[7:]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[6:])))
            if current == "hello" and not triggered:
                triggered = True
                fake.call(lambda f: f.external_switch(1))  # someone presses the wall switch
            if current == "light.state" and events[-1][1]["value"] == "on":
                break
    conn.close()

    assert events[0][0] == "hello"
    assert events[0][1]["knx"]["state"] == "connected"
    state = next(d for k, d in events if k == "light.state" and d["value"] == "on")
    assert state["lightId"] == "primary" and state["via"] == "status_address"


def test_event_stream_requires_auth(live: LiveServer) -> None:
    status, body = _http(live.port, "GET", "/api/v1/events", token="bogus")
    assert status == 401 and body["error"]["code"] == "SESSION_INVALID"


def test_disconnect_and_reconnect(bridge: BridgeClient, fake: FakeHandle) -> None:
    assert bridge.post("/knx/disconnect").json()["state"] == "disconnected"
    assert wait_for(lambda: fake.call(lambda f: len(f.clients)) == 0)
    register(bridge)
    assert cmd(bridge, "on", "after-disconnect").status_code == 409
    st = bridge.post("/knx/connect").json()
    assert st["state"] == "connected"
    assert cmd(bridge, "on", "after-reconnect").json()["outcome"] == "bus_confirmed"


def test_unreachable_interface_reports_actionable_error() -> None:
    app = create_app(make_settings(None, autoconnect=False))
    with TestClient(app) as c:
        b = BridgeClient(c)
        b.pair()
        r = b.post("/knx/connect")
        assert r.status_code in (502, 504)
        err = r.json()["error"]
        assert err["code"].startswith("KNX_CONNECT")
        assert err["hint"]
        assert b.get("/knx/status").json()["state"] == "error"


def test_hub_emergency_stop_also_blocks_the_light_api(bridge: BridgeClient, fake: FakeHandle) -> None:
    register(bridge)
    before = [r for r in fake.received() if r[0] == "write"]
    assert bridge.post("/safety/stop").json()["active"] is True
    r = cmd(bridge, "on", "stop-1")
    assert r.status_code == 423 and r.json()["error"]["code"] == "SAFETY_STOP_ACTIVE"
    assert [r for r in fake.received() if r[0] == "write"] == before  # nothing reached the bus
    bridge.post("/safety/resume")
    assert cmd(bridge, "on", "stop-2").status_code == 200
