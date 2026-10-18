"""Helpers for account-mode tests (SE7ENX Core identity)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from se7enx_bridge.config import Settings

from .conftest import PAIRING_CODE, make_settings

SAME_ORIGIN = "http://testserver"  # the TestClient's own origin, i.e. a page served by the hub
OWNER_PW = "violet tram sings at dawn 42"
STRONG_PW = {
    "admin": "copper kites drift over rivers",
    "engineer": "gentle orbit maps the tidal moon",
    "technician": "brass lantern hums near quiet docks",
    "user": "seven quiet harbors glow tonight",
}


def account_settings(data_dir: Path | None = None, **overrides: Any) -> Settings:
    """Appliance-like settings: the hub serves the UI (Host allowlist), so same-origin requests are accepted."""
    return make_settings(None, allowed_hosts=("testserver",), data_dir=str(data_dir) if data_dir else None, **overrides)


def setup_owner(c: TestClient, *, transport: str = "cookie", origin: str = SAME_ORIGIN, **fields: Any) -> Any:
    body = {
        "setupCode": PAIRING_CODE,
        "username": "amina",
        "displayName": "Amina B.",
        "password": OWNER_PW,
        "transport": transport,
        **fields,
    }
    return c.post("/api/v1/auth/setup", json=body, headers={"Origin": origin})


class Api:
    """Bearer-token client for one signed-in user (independent of the TestClient cookie jar)."""

    def __init__(self, c: TestClient, token: str) -> None:
        self.c = c
        self.token = token

    def _h(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", **(extra or {})}

    def get(self, path: str, **kw: Any) -> Any:
        return self.c.get(f"/api/v1{path}", headers=self._h(kw.pop("headers", None)), **kw)

    def post(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self.c.post(
            f"/api/v1{path}", json=json if json is not None else {}, headers=self._h(kw.pop("headers", None)), **kw
        )

    def put(self, path: str, json: Any, **kw: Any) -> Any:
        return self.c.put(f"/api/v1{path}", json=json, headers=self._h(kw.pop("headers", None)), **kw)

    def patch(self, path: str, json: Any, **kw: Any) -> Any:
        return self.c.patch(f"/api/v1{path}", json=json, headers=self._h(kw.pop("headers", None)), **kw)

    def delete(self, path: str, **kw: Any) -> Any:
        return self.c.delete(f"/api/v1{path}", headers=self._h(kw.pop("headers", None)), **kw)


def owner_api(c: TestClient) -> Api:
    r = setup_owner(c, transport="bearer")
    assert r.status_code == 201, r.text
    c.cookies.clear()
    return Api(c, r.json()["token"])


def login(c: TestClient, username: str, password: str, **extra: Any) -> Any:
    return c.post(
        "/api/v1/auth/login",
        json={"login": username, "password": password, "transport": "bearer", **extra},
        headers={"Origin": SAME_ORIGIN},
    )


def user_api(c: TestClient, owner: Api, role: str, username: str | None = None) -> Api:
    name = username or f"{role}1"
    r = owner.post("/users", {"username": name, "displayName": role.title(), "role": role, "password": STRONG_PW[role]})
    assert r.status_code == 201, r.text
    r = login(c, name, STRONG_PW[role])
    assert r.status_code == 200, r.text
    return Api(c, r.json()["token"])


def add_sim_light(api: Api, device_id: str = "lamp") -> dict[str, Any]:
    r = api.post("/devices", {"device": {"integration": "simulated", "id": device_id, "name": "Lamp", "type": "light"}})
    assert r.status_code == 201, r.text
    return r.json()
