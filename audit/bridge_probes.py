#!/usr/bin/env python3
"""Audit probes for the SE7ENX Bridge — safe, local, non-destructive.

Runs the REAL bridge (FastAPI + xknx) against the FAKE KNXnet/IP interface on
127.0.0.1 only. No external systems are contacted. Each probe prints
CONFIRMED / NOT CONFIRMED / PASS for the behaviour it checks.

    bridge/.venv/bin/python audit/bridge_probes.py
"""

from __future__ import annotations

import asyncio
import http.client
import io
import json
import logging
import sys
import threading
import time
from concurrent.futures import Future
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "bridge"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import uvicorn
from fake_knx_interface import Actuator, start_fake_interface
from fastapi.testclient import TestClient
from se7enx_bridge.api import create_app
from se7enx_bridge.config import ConfigError, Settings
from se7enx_bridge.knx import gateway_allowed

ORIGIN = "http://localhost:3000"
CODE = "AUDITCODE"
LIGHT = {
    "switchAddress": "0/0/1",
    "statusAddress": "0/0/2",
    "dpt": "1.001",
    "onLevel": 100,
}
results: list[tuple[str, str, str]] = []


def record(pid: str, verdict: str, detail: str) -> None:
    results.append((pid, verdict, detail))
    print(f"[{pid}] {verdict}: {detail}")


class Fake:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        ready: Future = Future()

        def run() -> None:
            asyncio.set_event_loop(self.loop)

            async def boot() -> None:
                ready.set_result(
                    await start_fake_interface(
                        "127.0.0.1",
                        0,
                        actuator=Actuator(switch="0/0/1", status="0/0/2"),
                    )
                )

            self.loop.run_until_complete(boot())
            self.loop.run_forever()

        threading.Thread(target=run, daemon=True).start()
        self.fake = ready.result(timeout=5)
        self.host, self.port = self.fake.address

    def call(self, fn):
        fut: Future = Future()
        self.loop.call_soon_threadsafe(lambda: fut.set_result(fn(self.fake)))
        return fut.result(timeout=5)

    def close(self) -> None:
        self.loop.call_soon_threadsafe(
            lambda: (self.fake.transport.close(), self.loop.stop())
        )


def settings(fake: Fake, **kw) -> Settings:
    base = {
        "allowed_origins": (ORIGIN,),
        "pairing_code": CODE,
        "allowed_group_addresses": ("0/0/1-9",),
        "connection_type": "tunneling",
        "gateway_ip": fake.host,
        "gateway_port": fake.port,
        "local_ip": "127.0.0.1",
    }
    base.update(kw)
    return Settings(**base)


def wait(pred, timeout=8.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def pair(c: TestClient, name: str = "auditor") -> dict:
    r = c.post(
        "/api/v1/pair",
        json={"code": CODE, "clientName": name},
        headers={"Origin": ORIGIN},
    )
    assert r.status_code == 200, r.text
    return {"Origin": ORIGIN, "Authorization": f"Bearer {r.json()['token']}"}


def connected(c: TestClient, h: dict) -> bool:
    return c.get("/api/v1/knx/status", headers=h).json().get("state") == "connected"


# ----------------------------------------------------------------------------- probes


def probe_auth_and_origin(fake: Fake) -> None:
    with TestClient(create_app(settings(fake))) as c:
        sensitive = [
            ("get", "/api/v1/session"),
            ("post", "/api/v1/knx/disconnect"),
            ("put", "/api/v1/lights/x"),
            ("post", "/api/v1/lights/x/on"),
        ]
        codes = [
            getattr(c, m)(
                p,
                headers={"Origin": ORIGIN},
                **({"json": {}} if m in ("post", "put") else {}),
            ).status_code
            for m, p in sensitive
        ]
        record(
            "P01",
            "PASS" if set(codes) == {401} else "FAIL",
            f"unauthenticated sensitive endpoints → {codes}",
        )
        r = c.post(
            "/api/v1/pair",
            json={"code": CODE},
            headers={"Origin": "https://evil.example"},
        )
        record(
            "P02",
            "PASS" if r.status_code == 403 else "FAIL",
            f"pairing from foreign Origin → {r.status_code} {r.json()['error']['code']}",
        )


def probe_isolation_and_roles(fake: Fake) -> None:
    with TestClient(create_app(settings(fake))) as c:
        a, b = pair(c, "household-A"), pair(c, "household-B")
        wait(lambda: connected(c, a))
        c.put("/api/v1/lights/primary", json=LIGHT, headers=a)
        r = c.get("/api/v1/lights/primary", headers=b)
        record(
            "P03",
            "PASS" if r.status_code == 404 else "FAIL",
            f"session B reading session A's light registration → {r.status_code}",
        )
        r = c.put("/api/v1/lights/mine", json=LIGHT, headers=b)
        record(
            "P04",
            "CONFIRMED" if r.status_code == 200 else "NOT CONFIRMED",
            f"session B can register and control the SAME allowlisted group address (no per-user target permissions) → {r.status_code}",
        )
        r = c.post("/api/v1/knx/disconnect", json={}, headers=b)
        r2 = c.post(
            "/api/v1/lights/primary/on",
            json={"requestId": "a1", "source": "manual"},
            headers=a,
        )
        record(
            "P05",
            "CONFIRMED"
            if r.status_code == 200 and r2.status_code == 409
            else "NOT CONFIRMED",
            f"any paired session can disconnect the shared KNX link (B disconnect → {r.status_code}; A's next command → {r2.status_code} {r2.json().get('error', {}).get('code')})",
        )


def probe_session_eviction(fake: Fake) -> None:
    with TestClient(create_app(settings(fake, max_sessions=2))) as c:
        first = pair(c, "first")
        pair(c, "second")
        pair(c, "third")
        r = c.get("/api/v1/session", headers=first)
        record(
            "P06",
            "CONFIRMED" if r.status_code == 401 else "NOT CONFIRMED",
            f"new pairing silently evicts the oldest session when max_sessions is reached → first token now {r.status_code}",
        )


def probe_log_injection(fake: Fake) -> None:
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    )
    audit = logging.getLogger("se7enx.audit")
    audit.addHandler(handler)
    audit.setLevel(logging.INFO)
    # must fit the 80-character clientName limit enforced by the bridge
    forged = "x\nFORGED se7enx.audit: command ga=0/0/9 value=on client=admin outcome=bus_confirmed"[
        :80
    ]
    with TestClient(create_app(settings(fake))) as c:
        r = c.post(
            "/api/v1/pair",
            json={"code": CODE, "clientName": forged},
            headers={"Origin": ORIGIN},
        )
        h = {"Origin": ORIGIN, "Authorization": f"Bearer {r.json()['token']}"}
        c.put("/api/v1/lights/primary", json=LIGHT, headers=h)
    audit.removeHandler(handler)
    lines = buf.getvalue().splitlines()
    injected = any(line.startswith("FORGED se7enx.audit: command") for line in lines)
    record(
        "P07",
        "CONFIRMED" if injected else "NOT CONFIRMED",
        f"newline in clientName forges a separate audit log line ({len(lines)} lines written for 1 event)",
    )


def probe_stale_state(fake: Fake) -> None:
    with TestClient(create_app(settings(fake))) as c:
        h = pair(c)
        wait(lambda: connected(c, h))
        c.put("/api/v1/lights/primary", json=LIGHT, headers=h)
        c.post(
            "/api/v1/lights/primary/on",
            json={"requestId": "s1", "source": "manual"},
            headers=h,
        )
        wait(
            lambda: (
                c.get("/api/v1/lights/primary/state", headers=h).json()["value"] == "on"
            )
        )
        before = c.get("/api/v1/lights/primary/state", headers=h).json()
        # The actuator changes state while its feedback/read path is unavailable (e.g. local override, missed telegram).
        fake.call(
            lambda f: (
                setattr(f, "feedback", False),
                setattr(f, "respond_reads", False),
                setattr(f.actuator, "value", 0),
            )
        )
        time.sleep(1.1)
        t0 = time.monotonic()
        after = c.get(
            "/api/v1/lights/primary/state", params={"refresh": "1"}, headers=h
        ).json()
        took = time.monotonic() - t0
        record(
            "P08",
            "CONFIRMED"
            if after["value"] == "on" and after["at"] == before["at"]
            else "NOT CONFIRMED",
            f"refresh read got no answer ({took:.1f}s) but the bridge returned the cached value as current: value={after['value']} via={after['via']} at={after['at']} (device is now OFF); response has no staleness flag",
        )
        c.post("/api/v1/knx/disconnect", json={}, headers=h)
        c.post("/api/v1/knx/connect", json={}, headers=h)
        again = c.get("/api/v1/lights/primary/state", headers=h).json()
        record(
            "P09",
            "CONFIRMED" if again["value"] == "on" else "NOT CONFIRMED",
            f"value cache survives KNX disconnect/reconnect → value={again['value']} at={again['at']}",
        )
        fake.call(
            lambda f: (setattr(f, "feedback", True), setattr(f, "respond_reads", True))
        )


def probe_command_rate(fake: Fake) -> None:
    with TestClient(create_app(settings(fake))) as c:
        h = pair(c)
        wait(lambda: connected(c, h))
        c.put("/api/v1/lights/primary", json=LIGHT, headers=h)
        statuses = []
        writes_before = len(
            [x for x in fake.call(lambda f: list(f.received)) if x[0] == "write"]
        )
        t0 = time.monotonic()
        for i in range(8):
            r = c.post(
                f"/api/v1/lights/primary/{'on' if i % 2 == 0 else 'off'}",
                json={"requestId": f"r{i}", "source": "manual"},
                headers=h,
            )
            statuses.append(r.status_code)
        dt = time.monotonic() - t0
        writes = (
            len([x for x in fake.call(lambda f: list(f.received)) if x[0] == "write"])
            - writes_before
        )
        record(
            "P10",
            "INFO",
            f"one session toggled the load {writes}× in {dt:.1f}s before the limit (statuses {statuses}); defaults allow 6/10 s per session and 20/10 s per bridge",
        )


def probe_body_limits(fake: Fake) -> None:
    with TestClient(create_app(settings(fake))) as c:
        r = c.post(
            "/api/v1/pair",
            content=b"x" * 20000,
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        )
        record(
            "P11",
            "PASS" if r.status_code == 413 else "FAIL",
            f"20 kB body → {r.status_code}",
        )


class Live:
    def __init__(self, app, proxy: bool) -> None:
        cfg = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            loop="asyncio",
            proxy_headers=proxy,
            forwarded_allow_ips="*" if proxy else "127.0.0.1",
        )
        self.server = uvicorn.Server(cfg)
        threading.Thread(target=self.server.run, daemon=True).start()
        wait(lambda: self.server.started, 10)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def pair(self, code: str, xff: str | None = None) -> tuple[int, str]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        if xff:
            headers["X-Forwarded-For"] = xff
        conn.request(
            "POST",
            "/api/v1/pair",
            body=json.dumps({"code": code, "clientName": "probe"}),
            headers=headers,
        )
        resp = conn.getresponse()
        body = json.loads(resp.read() or b"{}")
        conn.close()
        return resp.status, body.get("error", {}).get("code", "OK")

    def close(self) -> None:
        self.server.should_exit = True


def probe_forwarded_for(fake: Fake) -> None:
    # Mirrors cmd_serve(): SE7ENX_TRUST_PROXY=true → proxy_headers=True, forwarded_allow_ips="*"
    live = Live(create_app(settings(fake)), proxy=True)
    codes = [live.pair("WRONG000", xff=f"203.0.113.{i}") for i in range(1, 13)]
    limited = sum(1 for s, c in codes if c == "RATE_LIMITED")
    record(
        "P12",
        "CONFIRMED" if limited == 0 else "NOT CONFIRMED",
        f"with SE7ENX_TRUST_PROXY=true, spoofed X-Forwarded-For from a direct client bypasses the per-client pairing limit (12 attempts, {limited} rate-limited)",
    )
    more = [live.pair("WRONG000", xff=f"198.51.100.{i}") for i in range(1, 10)]
    ok_code = live.pair(CODE, xff="192.0.2.77")
    record(
        "P13",
        "CONFIRMED" if ok_code[1] == "PAIRING_LOCKED" else "NOT CONFIRMED",
        f"after 20 global failures pairing is locked for everyone, even with the correct code → {ok_code} (attempt codes: {sorted({c for _, c in more})})",
    )
    live.close()
    live2 = Live(create_app(settings(fake)), proxy=False)
    codes2 = [live2.pair("WRONG000", xff=f"203.0.113.{i}") for i in range(1, 8)]
    record(
        "P14",
        "PASS" if any(c == "RATE_LIMITED" for _, c in codes2) else "FAIL",
        f"control: with trust_proxy off the header is ignored and the per-client limit applies ({[c for _, c in codes2]})",
    )
    live2.close()


def probe_static_config() -> None:
    allowed = gateway_allowed("169.254.169.254", Settings().client_gateway_cidrs)
    record(
        "P15",
        "CONFIRMED" if allowed else "NOT CONFIRMED",
        f"default client gateway CIDRs include link-local 169.254.0.0/16 (cloud metadata address allowed: {allowed}); override itself is disabled by default",
    )
    try:
        s = Settings.from_env({"SE7ENX_PAIRING_CODE": "AAAAAAAA"})
        record(
            "P16",
            "CONFIRMED",
            f"trivially guessable fixed pairing code accepted by config validation (pairing_code={'*' * len(s.pairing_code or '')})",
        )
    except ConfigError as err:
        record("P16", "NOT CONFIRMED", str(err))
    s = Settings.from_env({})
    record(
        "P17",
        "PASS"
        if s.host == "127.0.0.1"
        and not s.allowed_group_addresses
        and not s.allow_client_gateway
        else "FAIL",
        "pip/systemd defaults: loopback bind, empty GA allowlist (deny all), gateway override off",
    )


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("xknx").setLevel(logging.ERROR)
    logging.getLogger("se7enx").setLevel(logging.ERROR)
    fake = Fake()
    try:
        probe_auth_and_origin(fake)
        probe_isolation_and_roles(fake)
        probe_session_eviction(fake)
        probe_log_injection(fake)
        probe_stale_state(fake)
        probe_command_rate(fake)
        probe_body_limits(fake)
        probe_forwarded_for(fake)
        probe_static_config()
    finally:
        fake.close()
    print("\nSUMMARY")
    for pid, verdict, _ in results:
        print(f"  {pid} {verdict}")


if __name__ == "__main__":
    main()
