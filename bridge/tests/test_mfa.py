"""Two-factor authentication (TOTP, RFC 6238) and recovery codes."""

from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core import totp

from .accounts import OWNER_PW, STRONG_PW, Api, account_settings, login, owner_api, user_api

RFC_SECRET = base64.b32encode(b"12345678901234567890").decode()  # RFC 6238 Appendix B, SHA-1 key


def test_rfc6238_vectors() -> None:
    vectors = {
        59: "94287082",
        1111111109: "07081804",
        1111111111: "14050471",
        1234567890: "89005924",
        2000000000: "69279037",
    }
    for ts, expected in vectors.items():
        assert totp.hotp(RFC_SECRET, totp.step_at(ts), digits=8) == expected
        assert totp.hotp(RFC_SECRET, totp.step_at(ts)) == expected[-6:]


def test_verify_drift_and_replay() -> None:
    now = 1_700_000_000.0
    step = totp.step_at(now)
    assert totp.verify(RFC_SECRET, totp.hotp(RFC_SECRET, step), now=now) == step
    assert totp.verify(RFC_SECRET, totp.hotp(RFC_SECRET, step - 1), now=now) == step - 1  # 30 s of clock drift
    assert totp.verify(RFC_SECRET, totp.hotp(RFC_SECRET, step - 2), now=now) is None
    assert totp.verify(RFC_SECRET, totp.hotp(RFC_SECRET, step), now=now, last_step=step) is None  # replay
    assert totp.verify(RFC_SECRET, "12 34", now=now) is None
    uri = totp.provisioning_uri("ABC", "amina")
    assert uri.startswith("otpauth://totp/SE7ENX%3Aamina?secret=ABC&issuer=SE7ENX")


def code(secret: str, offset: int = 0) -> str:
    return totp.hotp(secret, totp.step_at(time.time()) + offset)


def enable_mfa(api: Api, password: str) -> tuple[str, list[str]]:
    r = api.post("/auth/mfa/totp/setup", {"password": password})
    assert r.status_code == 200, r.text
    secret = r.json()["secret"]
    assert api.post("/auth/mfa/totp/confirm", {"code": "000000"}).status_code == 400
    r = api.post("/auth/mfa/totp/confirm", {"code": code(secret)})
    assert r.status_code == 200, r.text
    return secret, r.json()["recoveryCodes"]


def mfa_login(c: TestClient, username: str, password: str) -> str:
    r = login(c, username, password)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (
        body["mfaRequired"] is True and "token" not in body and "user" not in body
    )  # no session before the 2nd factor
    assert "se7enx_session" not in r.headers.get("set-cookie", "")
    return body["mfaToken"]


def second(c: TestClient, token: str, **kw: Any) -> Any:
    return c.post("/api/v1/auth/login/mfa", json={"mfaToken": token, **kw})


def test_totp_sign_in_flow(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        owner = owner_api(c)
        assert owner.post("/auth/mfa/totp/setup", {"password": "wrong password here"}).status_code == 401
        secret, recovery = enable_mfa(owner, OWNER_PW)
        assert len(recovery) == 10 and len(set(recovery)) == 10
        assert owner.get("/auth/me").json()["user"]["mfaEnabled"] is True
        assert owner.get("/auth/mfa").json() == {"enabled": True, "recoveryCodesLeft": 10}

        token = mfa_login(c, "amina", OWNER_PW)
        assert second(c, token, code="000000").status_code == 401
        assert second(c, token).status_code == 400
        # the step used to confirm cannot be replayed; the next step (within drift) is accepted
        ok = second(c, token, code=code(secret, +1))
        assert ok.status_code == 200, ok.text
        assert ok.json()["user"]["username"] == "amina" and ok.json()["token"]
        assert second(c, token, code=code(secret, +1)).json()["error"]["code"] == "MFA_EXPIRED"  # single use

        # recovery codes work exactly once
        token = mfa_login(c, "amina", OWNER_PW)
        assert second(c, token, recoveryCode=recovery[0].lower().replace("-", " ")).status_code == 200
        token = mfa_login(c, "amina", OWNER_PW)
        assert second(c, token, recoveryCode=recovery[0]).status_code == 401
        assert owner.get("/auth/mfa").json()["recoveryCodesLeft"] == 9

        audit = owner.get("/audit", params={"action": "auth.mfa"}).json()["entries"]
        assert any(e["details"].get("method") == "recovery" for e in audit)
        assert all(secret not in str(e) for e in owner.get("/audit").json()["entries"])  # never logged


def test_challenge_attempt_limit_and_disable(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        owner = owner_api(c)
        secret, recovery = enable_mfa(owner, OWNER_PW)
        token = mfa_login(c, "amina", OWNER_PW)
        for _ in range(5):
            second(c, token, code="111111")
        r = second(c, token, code=code(secret, +1))
        assert r.status_code in (401, 429) and r.json()["error"]["code"] in ("MFA_EXPIRED", "TOO_MANY_ATTEMPTS")

        # failed second factors count as failed sign-ins: the account is temporarily locked
        assert (
            owner.post("/auth/mfa/totp/disable", {"password": OWNER_PW, "recoveryCode": recovery[0]}).status_code == 429
        )


def test_disabling_needs_password_and_second_factor(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        owner = owner_api(c)
        _secret, recovery = enable_mfa(owner, OWNER_PW)
        assert owner.post("/auth/mfa/totp/disable", {"password": OWNER_PW}).status_code == 401  # no 2nd factor
        assert owner.post("/auth/mfa/recovery-codes", {"password": OWNER_PW, "code": "000000"}).status_code == 401
        r = owner.post("/auth/mfa/recovery-codes", {"password": OWNER_PW, "recoveryCode": recovery[0]})
        assert r.status_code == 200 and len(r.json()["recoveryCodes"]) == 10
        new_codes = r.json()["recoveryCodes"]
        assert (
            owner.post("/auth/mfa/totp/disable", {"password": OWNER_PW, "recoveryCode": recovery[1]}).status_code == 401
        )  # old codes revoked
        r = owner.post("/auth/mfa/totp/disable", {"password": OWNER_PW, "recoveryCode": new_codes[0]})
        assert r.status_code == 200 and owner.get("/auth/mfa").json()["enabled"] is False
        r = login(c, "amina", OWNER_PW)
        assert r.status_code == 200 and "token" in r.json()


def test_admin_can_reset_a_lost_authenticator(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        owner = owner_api(c)
        user = user_api(c, owner, "user")
        user_id = user.get("/auth/me").json()["user"]["id"]
        enable_mfa(user, STRONG_PW["user"])
        assert user.get("/auth/me").status_code == 200  # the enabling session stays valid
        r = owner.delete(f"/users/{user_id}/mfa")
        assert r.status_code == 200 and r.json()["user"]["mfaEnabled"] is False
        assert user.get("/auth/me").status_code == 401  # sessions revoked on reset
        r = login(c, "user1", STRONG_PW["user"])
        assert r.status_code == 200 and "token" in r.json()  # plain password sign-in again
        assert user.delete(f"/users/{user_id}/mfa").status_code == 401
        entries = owner.get("/audit", params={"action": "user.mfa_reset"}).json()["entries"]
        assert entries and entries[0]["target"]["id"] == user_id
