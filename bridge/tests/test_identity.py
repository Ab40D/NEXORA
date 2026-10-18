"""SE7ENX Core identity: password rules, owner setup, sign-in, cookies, CSRF, lockout, sessions."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core.db import Database
from se7enx_bridge.core.identity import IdentityError, IdentityService
from se7enx_bridge.core.passwords import PasswordRejectedError, check_password, hash_password, verify_password

from .accounts import OWNER_PW, SAME_ORIGIN, Api, account_settings, login, owner_api, setup_owner
from .conftest import ORIGIN, PAIRING_CODE

# ------------------------------------------------------------------ password rules (NIST SP 800-63B-4)


@pytest.mark.parametrize(
    ("password", "code"),
    [
        ("short phrase", "PASSWORD_TOO_SHORT"),
        ("passwordpassword", "PASSWORD_TOO_COMMON"),
        ("1234567890123456", "PASSWORD_TOO_COMMON"),
        ("qwertyuiopasdfgh", "PASSWORD_TOO_COMMON"),
        ("Password 2026 !!!!!!", "PASSWORD_TOO_COMMON"),
        ("azerty azerty azerty", "PASSWORD_TOO_COMMON"),
        ("my se7enx hub is great fun", "PASSWORD_CONTAINS_CONTEXT"),
        ("amina loves green tea daily", "PASSWORD_CONTAINS_CONTEXT"),
        ("x" * 257, "PASSWORD_TOO_LONG"),
    ],
)
def test_password_rules_reject_with_a_reason(password: str, code: str) -> None:
    with pytest.raises(PasswordRejectedError) as err:
        check_password(password, min_length=15, context=("amina",))
    assert err.value.code == code
    assert err.value.message


def test_password_rules_accept_passphrases_unicode_and_no_composition_rules() -> None:
    check_password("violet tram sings at dawn", min_length=15)  # no digits/symbols required
    check_password("خويا زيد الضو شوية الليلة", min_length=15)  # Arabic passphrase: code points counted
    check_password("mets la lumière du salon", min_length=15)


def test_argon2id_parameters_and_nfkc_normalisation() -> None:
    stored = hash_password("ﬁne café passphrase 2026")  # "ﬁ" ligature
    assert stored.startswith("$argon2id$v=19$m=19456,t=2,p=1$")
    assert verify_password(stored, "fine café passphrase 2026") == (True, False)
    assert verify_password(stored, "fine cafe passphrase 2026")[0] is False
    assert verify_password("not-a-hash", "x") == (False, False)


# ------------------------------------------------------------------ first-run setup


def test_owner_setup_with_console_code_sets_an_httponly_strict_cookie() -> None:
    with TestClient(create_app(account_settings())) as c:
        status = c.get("/api/v1/auth/status").json()
        assert status["mode"] == "pairing" and status["setupRequired"] is True and status["passwordMinLength"] == 15

        bad = setup_owner(c, setupCode="WRONG-CODE")
        assert bad.status_code == 401 and bad.json()["error"]["code"] == "SETUP_CODE_INVALID"

        r = setup_owner(c)
        assert r.status_code == 201, r.text
        body = r.json()
        assert "token" not in body and body["transport"] == "cookie"
        assert body["user"]["role"] == "owner" and body["user"]["username"] == "amina"
        assert "user.manage" in body["permissions"] and "role.manage" in body["permissions"]
        cookie = r.headers["set-cookie"]
        assert cookie.startswith("se7enx_session=")
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Path=/" in cookie
        assert "Max-Age" not in cookie  # browser-session cookie unless "keep me signed in"

        me = c.get("/api/v1/auth/status").json()
        assert me["mode"] == "accounts" and me["me"]["user"]["username"] == "amina"
        assert setup_owner(c, username="other").json()["error"]["code"] == "ALREADY_SET_UP"
        health = c.get("/api/v1/health").json()
        assert health["pairingRequired"] is False and health["auth"] == {"mode": "accounts", "setupRequired": False}
        pair = c.post("/api/v1/pair", json={"code": PAIRING_CODE, "clientName": "x"}, headers={"Origin": ORIGIN})
        assert pair.status_code == 403 and pair.json()["error"]["code"] == "PAIRING_DISABLED"


def test_setup_rejects_a_weak_password_without_spending_the_single_use_code() -> None:
    app = create_app(account_settings(pairing_code=None))
    with TestClient(app) as c:
        code = app.state.bridge.pairing.current_code()
        weak = setup_owner(c, setupCode=code, password="short")
        assert weak.status_code == 422 and weak.json()["error"]["code"] == "PASSWORD_TOO_SHORT"
        assert setup_owner(c, setupCode=code).status_code == 201


def test_owner_setup_revokes_legacy_pairing_sessions() -> None:
    with TestClient(create_app(account_settings())) as c:
        r = c.post("/api/v1/pair", json={"code": PAIRING_CODE, "clientName": "legacy"}, headers={"Origin": ORIGIN})
        paired = Api(c, r.json()["token"])
        assert paired.get("/devices", headers={"Origin": ORIGIN}).status_code == 200
        owner_api(c)
        assert paired.get("/devices", headers={"Origin": ORIGIN}).status_code == 401


# ------------------------------------------------------------------ sign-in


def test_login_errors_are_generic_and_logout_clears_the_session() -> None:
    with TestClient(create_app(account_settings())) as c:
        owner_api(c)
        wrong = login(c, "amina", "wrong passphrase entirely")
        unknown = login(c, "nobody", "wrong passphrase entirely")
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json()["error"] == unknown.json()["error"]
        assert wrong.json()["error"]["message"] == "The username or password is incorrect."

        r = c.post(
            "/api/v1/auth/login",
            json={"login": "AMINA", "password": OWNER_PW, "remember": True},
            headers={"Origin": SAME_ORIGIN},
        )
        assert r.status_code == 200, r.text
        assert "Max-Age=2592000" in r.headers["set-cookie"]  # 30 days
        assert c.get("/api/v1/auth/me").json()["user"]["username"] == "amina"
        out = c.post("/api/v1/auth/logout", headers={"Origin": SAME_ORIGIN})
        assert out.status_code == 204 and "se7enx_session=" in out.headers["set-cookie"]
        assert c.get("/api/v1/auth/me").status_code == 401


@pytest.mark.parametrize("username", ["amina", "ghost"])
def test_repeated_failures_lock_the_login_name_whether_it_exists_or_not(username: str) -> None:
    with TestClient(create_app(account_settings())) as c:
        owner_api(c)
        for _ in range(5):
            assert login(c, username, "wrong passphrase entirely").status_code == 401
        locked = login(c, username, OWNER_PW)
        assert locked.status_code == 429 and locked.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"
        assert int(locked.headers["retry-after"]) >= 1


def test_cookie_sessions_require_same_origin_for_unsafe_requests() -> None:
    with TestClient(create_app(account_settings())) as c:
        assert setup_owner(c).status_code == 201  # cookie session in the client's jar
        assert c.get("/api/v1/devices").status_code == 200  # safe method, no Origin needed
        no_origin = c.post("/api/v1/safety/stop")
        assert no_origin.status_code == 403 and no_origin.json()["error"]["code"] == "CSRF_REJECTED"
        evil = c.post("/api/v1/safety/stop", headers={"Origin": "http://evil.example"})
        assert evil.status_code == 403 and evil.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"
        fetch_meta = c.post("/api/v1/safety/stop", headers={"Sec-Fetch-Site": "same-origin"})
        assert fetch_meta.status_code == 200
        assert c.post("/api/v1/safety/resume", headers={"Origin": SAME_ORIGIN}).status_code == 200


def test_allowed_cross_origin_apps_get_a_bearer_token_and_no_cookie() -> None:
    with TestClient(create_app(account_settings())) as c:
        r = setup_owner(c, origin=ORIGIN)  # e.g. the Vercel deployment, listed in SE7ENX_ALLOWED_ORIGINS
        assert r.status_code == 201
        assert r.json()["transport"] == "bearer" and r.json()["token"]
        assert "set-cookie" not in r.headers
        api = Api(c, r.json()["token"])
        assert api.get("/auth/me", headers={"Origin": ORIGIN}).status_code == 200
        assert api.post("/safety/stop").status_code == 200  # bearer: no CSRF exposure, no Origin needed


def test_sessions_and_accounts_survive_a_restart(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        token = owner_api(c).token
    assert (tmp_path / "se7enx.db").stat().st_mode & 0o077 == 0  # owner-only file
    with TestClient(create_app(account_settings(tmp_path))) as c:
        assert Api(c, token).get("/auth/me").json()["user"]["role"] == "owner"
        assert c.get("/api/v1/health").json()["auth"]["mode"] == "accounts"


def test_idle_and_absolute_session_timeouts() -> None:
    now = [1_000_000.0]
    ids = IdentityService(Database(None), session_idle_s=3600, session_ttl_s=8 * 3600, clock=lambda: now[0])
    user = ids.create_user(username="sami", display_name="Sami", role="user", password="copper kites drift over rivers")
    token, _ = ids.create_session(user, remember=False, transport="cookie", client="t", ip="1.2.3.4")
    now[0] += 3599
    assert ids.authenticate(token) is not None  # activity resets the idle timer
    for _ in range(8):  # 3599 s + 8 x 3000 s = 7.7 h, always active
        now[0] += 3000
        assert ids.authenticate(token) is not None
    now[0] += 3000  # 8.5 h since creation: absolute timeout despite activity
    assert ids.authenticate(token) is None
    token2, _ = ids.create_session(user, remember=False, transport="cookie", client="t", ip="1.2.3.4")
    now[0] += 3601
    assert ids.authenticate(token2) is None  # idle timeout


def test_last_owner_cannot_lose_owner_rights() -> None:
    ids = IdentityService(Database(None))
    owner = ids.create_user(username="amina", display_name="Amina", role="owner", password=OWNER_PW)
    for kwargs in ({"role": "admin"}, {"disabled": True}):
        with pytest.raises(IdentityError) as err:
            ids.update_user(owner.id, **kwargs)  # type: ignore[arg-type]
        assert err.value.code == "LAST_OWNER"
    with pytest.raises(IdentityError):
        ids.delete_user(owner.id)


# ------------------------------------------------------------------ password change, reset codes, registration


def test_password_change_signs_out_other_sessions() -> None:
    with TestClient(create_app(account_settings())) as c:
        a = owner_api(c)
        b = Api(c, login(c, "amina", OWNER_PW).json()["token"])
        r = a.post("/auth/password", {"currentPassword": OWNER_PW, "newPassword": "amber gulls circle the old pier"})
        assert r.status_code == 200, r.text
        assert b.get("/auth/me").status_code == 401
        assert a.get("/auth/me").status_code == 200
        assert login(c, "amina", OWNER_PW).status_code == 401
        assert login(c, "amina", "amber gulls circle the old pier").status_code == 200
        wrong = a.post("/auth/password", {"currentPassword": "nope nope nope", "newPassword": "x" * 20})
        assert wrong.json()["error"]["code"] == "CURRENT_PASSWORD_WRONG"


def test_new_user_without_password_gets_a_single_use_setup_code() -> None:
    with TestClient(create_app(account_settings())) as c:
        owner = owner_api(c)
        r = owner.post("/users", {"username": "nadia", "displayName": "Nadia", "role": "technician"})
        assert r.status_code == 201, r.text
        code = r.json()["setupCode"]["code"]
        assert r.json()["user"]["hasPassword"] is False
        assert login(c, "nadia", "anything at all here").status_code == 401
        redeem = c.post(
            "/api/v1/auth/reset",
            json={"code": code.lower().replace("-", " "), "newPassword": "brass lantern hums near quiet docks"},
            headers={"Origin": SAME_ORIGIN},
        )
        assert redeem.status_code == 200, redeem.text
        assert redeem.json()["user"]["role"] == "technician"
        again = c.post(
            "/api/v1/auth/reset",
            json={"code": code, "newPassword": "brass lantern hums near quiet docks"},
            headers={"Origin": SAME_ORIGIN},
        )
        assert again.status_code == 403 and again.json()["error"]["code"] == "RESET_CODE_INVALID"


def test_registration_modes_disabled_invite_and_open() -> None:
    with TestClient(create_app(account_settings())) as c:
        owner = owner_api(c)
        body = {
            "username": "lina",
            "displayName": "Lina",
            "password": "gentle orbit maps the tidal moon",
            "transport": "bearer",
        }
        r = c.post("/api/v1/auth/register", json=body, headers={"Origin": SAME_ORIGIN})
        assert r.status_code == 403 and r.json()["error"]["code"] == "REGISTRATION_DISABLED"

        assert owner.put("/system/security", {"registration": "invite"}).status_code == 200
        r = c.post("/api/v1/auth/register", json=body, headers={"Origin": SAME_ORIGIN})
        assert r.json()["error"]["code"] == "INVITE_REQUIRED"
        invite = owner.post("/invites", {"role": "technician", "ttlHours": 2}).json()
        r = c.post(
            "/api/v1/auth/register", json={**body, "inviteCode": invite["code"]}, headers={"Origin": SAME_ORIGIN}
        )
        assert r.status_code == 201, r.text
        assert r.json()["user"]["role"] == "technician"
        r = c.post(
            "/api/v1/auth/register",
            json={**body, "username": "lina2", "inviteCode": invite["code"]},
            headers={"Origin": SAME_ORIGIN},
        )
        assert r.json()["error"]["code"] == "INVITE_INVALID"

        assert owner.put("/system/security", {"registration": "open"}).status_code == 200
        r = c.post("/api/v1/auth/register", json={**body, "username": "omar"}, headers={"Origin": SAME_ORIGIN})
        assert r.status_code == 201 and r.json()["user"]["role"] == "user"


def test_cli_recovery_issues_a_single_use_reset_code(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from se7enx_bridge.__main__ import cmd_reset_password, cmd_users

    settings = account_settings(tmp_path)
    with TestClient(create_app(settings)) as c:
        owner_api(c)
    cmd_users(settings)
    assert "amina" in capsys.readouterr().out
    cmd_reset_password(settings, "amina")
    out = capsys.readouterr().out
    code = out.split(": ", 1)[1].split()[0]
    with TestClient(create_app(settings)) as c:
        r = c.post(
            "/api/v1/auth/reset",
            json={"code": code, "newPassword": "amber gulls circle the old pier", "transport": "bearer"},
            headers={"Origin": SAME_ORIGIN},
        )
        assert r.status_code == 200, r.text
        ledger = Api(c, r.json()["token"]).get("/audit", params={"action": "user.reset_code_issued"}).json()["entries"]
        assert ledger[0]["source"] == "cli" and ledger[0]["actor"]["name"] == "host console"
    with pytest.raises(SystemExit):
        cmd_reset_password(settings, "nobody")
