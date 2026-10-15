"""Shared fixtures: a fake KNXnet/IP interface running in its own thread/event loop,
and a bridge app (real xknx stack) connected to it over UDP."""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Future
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT))

from fake_knx_interface import Actuator, FakeInterface, start_fake_interface  # noqa: E402

from se7enx_bridge.api import create_app  # noqa: E402
from se7enx_bridge.config import Settings  # noqa: E402

ORIGIN = "http://localhost:3000"
PAIRING_CODE = "TESTCODE"


class FakeHandle:
    """Thread-safe access to a FakeInterface living in a background event loop."""

    def __init__(self, **kwargs: Any) -> None:
        self.loop = asyncio.new_event_loop()
        self._ready: Future[FakeInterface] = Future()
        self.thread = threading.Thread(target=self._run, kwargs=kwargs, daemon=True)
        self.thread.start()
        self.fake: FakeInterface = self._ready.result(timeout=5)
        self.host, self.port = self.fake.address

    def _run(self, **kwargs: Any) -> None:
        asyncio.set_event_loop(self.loop)

        async def boot() -> None:
            self._ready.set_result(await start_fake_interface("127.0.0.1", 0, **kwargs))

        self.loop.run_until_complete(boot())
        self.loop.run_forever()

    def call(self, fn: Callable[[FakeInterface], Any]) -> Any:
        fut: Future[Any] = Future()

        def run() -> None:
            try:
                fut.set_result(fn(self.fake))
            except Exception as err:
                fut.set_exception(err)

        self.loop.call_soon_threadsafe(run)
        return fut.result(timeout=5)

    def received(self) -> list[tuple[str, str, object]]:
        return self.call(lambda f: list(f.received))

    def close(self) -> None:
        def stop() -> None:
            if self.fake.transport:
                self.fake.transport.close()
            self.loop.stop()

        self.loop.call_soon_threadsafe(stop)
        self.thread.join(timeout=5)


@pytest.fixture
def fake() -> Iterator[FakeHandle]:
    handle = FakeHandle(actuator=Actuator(switch="0/0/1", status="0/0/2"))
    try:
        yield handle
    finally:
        handle.close()


def make_settings(fake: FakeHandle | None, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "allowed_origins": (ORIGIN,),
        "pairing_code": PAIRING_CODE,
        "allowed_group_addresses": ("0/0/1-9",),
        "autoconnect": fake is not None,
        "local_ip": "127.0.0.1",
        "command_limit": 50,
        "global_command_limit": 100,
    }
    if fake is not None:
        base.update(connection_type="tunneling", gateway_ip=fake.host, gateway_port=fake.port)
    else:
        base.update(connection_type="tunneling", gateway_ip="127.0.0.1", gateway_port=9)
    base.update(overrides)
    return Settings(**base)


def wait_for(predicate: Callable[[], bool], timeout: float = 8.0, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class BridgeClient:
    def __init__(self, client: TestClient) -> None:
        self.c = client
        self.token: str | None = None

    @property
    def h(self) -> dict[str, str]:
        headers = {"Origin": ORIGIN}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def pair(self) -> str:
        r = self.c.post("/api/v1/pair", json={"code": PAIRING_CODE, "clientName": "pytest"}, headers={"Origin": ORIGIN})
        assert r.status_code == 200, r.text
        self.token = r.json()["token"]
        return self.token

    def get(self, path: str, **kw: Any) -> Any:
        return self.c.get(f"/api/v1{path}", headers={**self.h, **kw.pop("headers", {})}, **kw)

    def post(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self.c.post(
            f"/api/v1{path}", json=json if json is not None else {}, headers={**self.h, **kw.pop("headers", {})}, **kw
        )

    def put(self, path: str, json: Any, **kw: Any) -> Any:
        return self.c.put(f"/api/v1{path}", json=json, headers={**self.h, **kw.pop("headers", {})}, **kw)


@pytest.fixture
def bridge(fake: FakeHandle) -> Iterator[BridgeClient]:
    app = create_app(make_settings(fake))
    with TestClient(app) as client:
        bc = BridgeClient(client)
        bc.pair()
        assert wait_for(lambda: bc.get("/knx/status").json()["state"] == "connected"), (
            "bridge did not connect to fake interface"
        )
        yield bc


class LiveServer:
    """The bridge served by a real uvicorn instance (needed for streaming responses,
    which Starlette's TestClient buffers until completion)."""

    def __init__(self, app: Any) -> None:
        import uvicorn

        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", loop="asyncio", lifespan="on")
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        assert wait_for(lambda: self.server.started, timeout=10), "uvicorn did not start"
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def close(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture
def live(fake: FakeHandle) -> Iterator[LiveServer]:
    server = LiveServer(create_app(make_settings(fake)))
    try:
        yield server
    finally:
        server.close()
