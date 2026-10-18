"""Server-enforced roles and permissions on hub routes, user management rules, role matrix guardrails."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core.rbac import DEFAULT_MATRIX, RoleError, RoleMatrix

from .accounts import Api, account_settings, add_sim_light, owner_api, user_api

TURN_ON = {"command": "turn_on", "requestId": "r-1", "source": "manual"}

# (method, path, body, roles allowed) — the rest must get 403 FORBIDDEN
MATRIX = [
    ("get", "/devices", None, {"owner", "admin", "engineer", "technician", "user"}),
    ("get", "/building", None, {"owner", "admin", "engineer", "technician", "user"}),
    ("post", "/devices/lamp/commands", TURN_ON, {"owner", "admin", "engineer", "technician", "user"}),
    ("patch", "/devices/lamp", {"name": "Desk lamp"}, {"owner", "admin", "engineer"}),
    ("get", "/integrations", None, {"owner", "admin", "engineer", "technician"}),
    ("get", "/audit", None, {"owner", "admin", "engineer", "technician"}),
    ("get", "/config/export", None, {"owner", "admin", "engineer"}),
    ("get", "/users", None, {"owner", "admin"}),
    ("put", "/system/security", {"registration": "disabled"}, {"owner", "admin"}),
    ("post", "/building/sites", {"name": "HQ"}, {"owner", "admin", "engineer"}),
    ("post", "/safety/stop", None, {"owner", "admin", "engineer", "technician", "user"}),
    ("post", "/safety/resume", None, {"owner", "admin", "engineer", "technician"}),
]


@pytest.fixture
def users() -> dict[str, Api]:
    c = TestClient(create_app(account_settings()))
    c.__enter__()
    owner = owner_api(c)
    add_sim_light(owner)
    apis = {"owner": owner}
    for role in ("admin", "engineer", "technician", "user"):
        apis[role] = user_api(c, owner, role)
    yield apis
    c.__exit__(None, None, None)


def call(api: Api, method: str, path: str, body: object) -> int:
    if method == "get":
        return int(api.get(path).status_code)
    fn = getattr(api, method)
    r = fn(path, body if body is not None else {})
    return int(r.status_code)


def test_every_role_gets_exactly_its_permissions(users: dict[str, Api]) -> None:
    failures = []
    for method, path, body, allowed in MATRIX:
        for role, api in users.items():
            status = call(api, method, path, body)
            if role in allowed and status == 403:
                failures.append(f"{role} {method.upper()} {path}: unexpectedly forbidden")
            if role not in allowed and status != 403:
                failures.append(f"{role} {method.upper()} {path}: expected 403, got {status}")
            if path == "/safety/stop" and status == 200:  # keep the next checks independent
                users["owner"].post("/safety/resume")
            if path == "/building/sites" and status == 201:
                site = users["owner"].get("/building").json()["sites"][-1]["id"]
                users["owner"].delete(f"/building/sites/{site}")
    assert not failures, "\n".join(failures)


def test_denials_are_recorded_in_the_audit_ledger(users: dict[str, Api]) -> None:
    r = users["user"].get("/users")
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"
    assert "user.manage" in r.json()["error"]["hint"]
    entries = users["owner"].get("/audit", params={"action": "access.denied"}).json()["entries"]
    assert any(e["actor"]["name"] == "user1" and e["details"]["permission"] == "user.manage" for e in entries)


def test_revoking_device_control_blocks_the_same_command_immediately(users: dict[str, Api]) -> None:
    assert users["user"].post("/devices/lamp/commands", TURN_ON).status_code == 200
    perms = sorted(DEFAULT_MATRIX["user"] - {"device.control"})
    assert users["owner"].put("/roles/user", {"permissions": perms}).status_code == 200
    blocked = users["user"].post("/devices/lamp/commands", {**TURN_ON, "requestId": "r-2"})
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "FORBIDDEN"
    ledger = users["owner"].get("/audit").json()["entries"]
    assert any(e["action"] == "access.denied" and e["details"]["permission"] == "device.control" for e in ledger)
    ok_cmds = [e for e in ledger if e["action"] == "device.command" and e["actor"]["name"] == "user1"]
    assert len(ok_cmds) == 1 and ok_cmds[0]["outcome"] == "simulated"


def test_user_management_is_rank_based(users: dict[str, Api]) -> None:
    admin, owner = users["admin"], users["owner"]
    r = admin.post("/users", {"username": "boss2", "displayName": "Boss", "role": "owner", "password": "x" * 20})
    assert r.status_code == 403
    r = admin.post("/users", {"username": "eng2", "displayName": "Eng", "role": "engineer"})
    assert r.status_code == 201 and r.json()["setupCode"]["code"]
    owner_id = next(u["id"] for u in owner.get("/users").json()["users"] if u["role"] == "owner")
    assert admin.patch(f"/users/{owner_id}", {"displayName": "x"}).status_code == 403
    assert admin.delete(f"/users/{owner_id}").status_code == 403
    me = owner.get("/auth/me").json()["user"]["id"]
    assert owner.patch(f"/users/{me}", {"role": "admin"}).status_code == 403  # no self-demotion
    assert users["engineer"].post("/invites", {"role": "user"}).status_code == 403


def test_disabling_a_user_ends_their_sessions_at_once(users: dict[str, Api]) -> None:
    tech_id = next(u["id"] for u in users["owner"].get("/users").json()["users"] if u["username"] == "technician1")
    assert users["technician"].get("/devices").status_code == 200
    assert users["admin"].patch(f"/users/{tech_id}", {"disabled": True}).status_code == 200
    assert users["technician"].get("/devices").status_code == 401


def test_role_matrix_guardrails() -> None:
    m = RoleMatrix()
    with pytest.raises(RoleError) as e:
        m.update("owner", [], actor_role="owner")
    assert e.value.code == "ROLE_FIXED"
    with pytest.raises(RoleError) as e:
        m.update("admin", ["device.view"], actor_role="admin")
    assert e.value.status == 403
    with pytest.raises(RoleError) as e:
        m.update("engineer", ["role.manage"], actor_role="admin")
    assert "owner" in e.value.message
    with pytest.raises(RoleError) as e:
        m.update("user", ["no.such"], actor_role="owner")
    assert e.value.code == "PERMISSION_UNKNOWN"
    m.update("technician", ["device.view"], actor_role="owner")
    assert m.permissions("technician") == frozenset({"device.view"})
    assert m.overrides() == {"technician": ["device.view"]}
    assert RoleMatrix(m.overrides()).permissions("technician") == frozenset({"device.view"})


def test_role_overrides_persist_across_restart(tmp_path: object) -> None:
    from pathlib import Path

    data = Path(str(tmp_path))
    with TestClient(create_app(account_settings(data))) as c:
        owner = owner_api(c)
        assert owner.put("/roles/user", {"permissions": ["device.view", "building.view"]}).status_code == 200
        token = owner.token
    with TestClient(create_app(account_settings(data))) as c:
        roles = Api(c, token).get("/roles").json()
        assert roles["matrix"]["user"] == ["building.view", "device.view"]
        assert roles["matrix"]["owner"] == sorted(DEFAULT_MATRIX["owner"])
