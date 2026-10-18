"""Accounts API: first-run setup, sign-in, profile, users, invitations, roles and the audit ledger.

Public routes (no session): ``GET /auth/status``, ``POST /auth/setup`` (needs the console setup
code, only while no account exists), ``POST /auth/login``, ``POST /auth/register`` (only when
registration is enabled), ``POST /auth/reset`` (needs a one-time reset code). They are
rate-limited per IP. Every other route requires a session and a permission.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal, TypeVar

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from .auth import Auth, client_ip, cross_origin
from .config import Settings
from .core.audit import Actor, AuditLog
from .core.identity import IdentityError, IdentityService, User
from .core.rbac import EDITABLE_ROLES, PERMISSIONS, RANK, ROLES, RoleError, RoleMatrix, outranks
from .devices.model import ApiModel
from .devices.store import ConfigStore
from .errors import ApiError
from .security import PairingManager, Session, SessionStore, SlidingWindowLimiter

T = TypeVar("T")
Role = Literal["owner", "admin", "engineer", "technician", "user"]
Transport = Literal["cookie", "bearer"]
NEW_USER_CODE_TTL_S = 24 * 3600
RESET_CODE_TTL_S = 30 * 60


class _Credentials(ApiModel):
    remember: bool = False
    transport: Transport = "cookie"
    client_name: str = Field(default="SE7ENX web", min_length=1, max_length=80)


class SetupRequest(_Credentials):
    setup_code: str = Field(min_length=4, max_length=40)
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)
    email: str | None = Field(default=None, max_length=254)


class LoginRequest(_Credentials):
    login: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class RegisterRequest(_Credentials):
    invite_code: str | None = Field(default=None, max_length=40)
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)
    email: str | None = Field(default=None, max_length=254)


class ResetRequest(_Credentials):
    code: str = Field(min_length=4, max_length=40)
    new_password: str = Field(min_length=1, max_length=1024)


class MfaLoginRequest(ApiModel):
    mfa_token: str = Field(min_length=20, max_length=200)
    code: str | None = Field(default=None, max_length=12)
    recovery_code: str | None = Field(default=None, max_length=24)


class PasswordOnly(ApiModel):
    password: str = Field(min_length=1, max_length=1024)


class MfaCode(ApiModel):
    code: str = Field(min_length=6, max_length=12)


class MfaChange(ApiModel):
    password: str = Field(min_length=1, max_length=1024)
    code: str | None = Field(default=None, max_length=12)
    recovery_code: str | None = Field(default=None, max_length=24)


class PasswordChange(ApiModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


class Preferences(ApiModel):
    language: Literal["en", "fr", "ar", "dz"] | None = None
    theme: Literal["dark", "light", "system"] | None = None
    personality: Literal["professional", "friendly", "playful"] | None = None
    guide_level: Literal["beginner", "intermediate", "advanced"] | None = None
    guide_enabled: bool | None = None
    reduced_motion: bool | None = None
    home_view: str | None = Field(default=None, max_length=40, pattern=r"^[a-z0-9/_-]+$")
    dismissed: list[Annotated[str, Field(max_length=40, pattern=r"^[a-z0-9._-]+$")]] = Field(
        default_factory=list, max_length=50
    )


class ProfilePatch(ApiModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=64)
    email: str | None = Field(default=None, max_length=254)
    preferences: Preferences | None = None


class UserCreate(ApiModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)
    role: Role = "user"
    email: str | None = Field(default=None, max_length=254)
    # Omit to hand the user a one-time code instead (they choose their own password).
    password: str | None = Field(default=None, min_length=1, max_length=1024)


class UserPatch(ApiModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=64)
    email: str | None = Field(default=None, max_length=254)
    role: Role | None = None
    disabled: bool | None = None


class InviteCreate(ApiModel):
    role: Role = "user"
    ttl_hours: int = Field(default=72, ge=1, le=24 * 14)


class RoleUpdate(ApiModel):
    permissions: list[str] = Field(max_length=len(PERMISSIONS))


class SecurityUpdate(ApiModel):
    registration: Literal["disabled", "invite", "open"]


UserId = Path(pattern=r"^[0-9a-f]{16}$")


def build_auth_router(
    *,
    settings: Settings,
    auth: Auth,
    identity: IdentityService,
    audit: AuditLog,
    store: ConfigStore,
    roles_ref: Callable[[], RoleMatrix],
    pairing: PairingManager,
    pairing_sessions: SessionStore,
    limit: Callable[[SlidingWindowLimiter, str, str], None],
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    need = {p: auth.require(p) for p in PERMISSIONS}
    need_session = auth.require()
    # Failed sign-ins per IP (successful ones are not counted: behind a reverse proxy every user shares one IP).
    login_failures = SlidingWindowLimiter(10, 300.0)
    setup_limiter = SlidingWindowLimiter(5, 60.0)
    register_limiter = SlidingWindowLimiter(5, 600.0)
    account_limiter = SlidingWindowLimiter(20, 60.0)
    hash_slots = asyncio.Semaphore(2)  # Argon2 uses 19 MiB per hash: bound concurrent work
    setup_lock = asyncio.Lock()

    async def cpu(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        async with hash_slots:
            return await asyncio.to_thread(fn, *args, **kwargs)

    def actor_of(user: User) -> Actor:
        return Actor(user.id, user.username, user.role)

    def me_json(user: User, session_id: str | None) -> dict[str, Any]:
        return {
            "user": user.public(),
            "permissions": sorted(roles_ref().permissions(user.role)),
            "preferences": user.preferences,
            "session": next(
                (s.public(session_id) for s in identity.list_sessions(user.id) if s.id == session_id), None
            ),
        }

    def issue(request: Request, user: User, body: _Credentials, action: str, status: int = 200) -> JSONResponse:
        use_bearer = body.transport == "bearer" or cross_origin(request)
        token, acc = identity.create_session(
            user,
            remember=body.remember,
            transport="bearer" if use_bearer else "cookie",
            client=body.client_name.strip(),
            ip=client_ip(request),
        )
        payload = {**me_json(user, acc.id), "transport": "bearer" if use_bearer else "cookie"}
        if use_bearer:
            payload["token"] = token
        resp = JSONResponse(payload, status_code=status)
        if not use_bearer:
            ttl = settings.remember_ttl_s if body.remember else settings.session_ttl_s
            auth.set_cookie(resp, request, token, remember=body.remember, max_age=ttl)
        audit.record(
            action,
            actor=actor_of(user),
            source="ui",
            ip=client_ip(request),
            details={"transport": payload["transport"], "remember": body.remember},
        )
        return resp

    def manageable(actor: Session, target_role: str) -> None:
        if not outranks(actor.role, target_role):
            raise ApiError(
                403,
                "FORBIDDEN",
                "You can only manage users ranked below you.",
                f"Your role ({actor.role}) cannot manage {target_role} accounts.",
            )

    # ------------------------------------------------------------------ public

    @r.get("/auth/status")
    async def status(request: Request) -> dict[str, Any]:
        accounts = auth.accounts_enabled
        current: dict[str, Any] | None = None
        if accounts:
            try:
                session = await auth.resolve(request)
            except ApiError:
                session = None
            if session is not None and session.kind == "account" and session.user_id:
                user = identity.get_user(session.user_id)
                if user is not None:
                    current = me_json(user, session.id)
        return {
            "mode": "accounts" if accounts else "pairing",
            "setupRequired": not accounts,
            "registration": store.config.security.registration if accounts else "disabled",
            "passwordMinLength": settings.password_min_length,
            "me": current,
        }

    @r.post("/auth/setup")
    async def setup(body: SetupRequest, request: Request) -> JSONResponse:
        ip = client_ip(request)
        limit(setup_limiter, ip, "setup attempts")
        async with setup_lock:
            if auth.accounts_enabled:
                raise ApiError(409, "ALREADY_SET_UP", "The owner account already exists.", "Sign in instead.")
            locked = pairing.locked_for()
            if locked > 0:
                raise ApiError(429, "SETUP_LOCKED", "Setup is locked after repeated wrong codes.", retry_after=locked)
            # Validate the account first, so a rejected password does not spend the (single-use) code.
            username = identity.clean_username(body.username)
            email = identity.clean_email(body.email)
            name = identity.clean_display_name(body.display_name)
            identity.check_new_password(body.password, username=username, email=email, display_name=name)
            if not pairing.verify(body.setup_code):
                await asyncio.sleep(0.25)
                audit.record(
                    "auth.setup", outcome="failed", source="ui", ip=ip, details={"reason": "SETUP_CODE_INVALID"}
                )
                raise ApiError(
                    401,
                    "SETUP_CODE_INVALID",
                    "The setup code is wrong or has expired.",
                    "Use the current code printed in the hub console (for Docker: docker compose logs se7enx).",
                )
            user = await cpu(
                identity.create_user,
                username=username,
                display_name=name,
                role="owner",
                password=body.password,
                email=email,
            )
            revoked = pairing_sessions.revoke_all()
            audit.record(
                "pairing.disabled",
                source="system",
                details={"reason": "owner account created", "revokedSessions": revoked},
            )
            return issue(request, user, body, "auth.setup", status=201)

    @r.post("/auth/login")
    async def login(body: LoginRequest, request: Request) -> JSONResponse:
        ip = client_ip(request)
        wait = login_failures.blocked_for(ip)
        if wait > 0:
            raise ApiError(
                429,
                "RATE_LIMITED",
                f"Too many failed sign-ins from this device. Try again in {max(1, round(wait))} s.",
                retry_after=wait,
            )
        if not auth.accounts_enabled:
            raise ApiError(409, "SETUP_REQUIRED", "No account exists yet.", "Create the owner account first.")
        try:
            user = await cpu(identity.verify_login, body.login, body.password)
        except IdentityError as err:
            if err.status == 401:
                login_failures.hit(ip)
            known = identity.find_by_login(body.login)
            # Never record an unknown login string: people sometimes type their password into the username field.
            who = (
                Actor(known[0].id, known[0].username, known[0].role) if known else Actor(None, "unknown account", None)
            )
            audit.record(
                "auth.login",
                actor=who,
                outcome="failed" if err.status == 401 else "denied",
                source="ui",
                ip=ip,
                details={"reason": err.code},
            )
            raise
        if user.mfa_enabled:
            token = identity.begin_mfa_challenge(
                user,
                remember=body.remember,
                transport="bearer" if (body.transport == "bearer" or cross_origin(request)) else "cookie",
                client=body.client_name.strip(),
                ip=ip,
            )
            audit.record(
                "auth.login", actor=actor_of(user), outcome="pending", source="ui", ip=ip, details={"step": "mfa"}
            )
            return JSONResponse({"mfaRequired": True, "mfaToken": token, "methods": ["totp", "recovery"]})
        return issue(request, user, body, "auth.login")

    @r.post("/auth/login/mfa")
    async def login_mfa(body: MfaLoginRequest, request: Request) -> JSONResponse:
        ip = client_ip(request)
        wait = login_failures.blocked_for(ip)
        if wait > 0:
            raise ApiError(
                429,
                "RATE_LIMITED",
                f"Too many failed sign-ins. Try again in {max(1, round(wait))} s.",
                retry_after=wait,
            )
        if not (body.code or body.recovery_code):
            raise ApiError(400, "MFA_CODE_REQUIRED", "Enter the code from your authenticator app or a recovery code.")
        try:
            user, ctx, method = identity.complete_mfa_challenge(
                body.mfa_token, code=body.code, recovery_code=body.recovery_code
            )
        except IdentityError as err:
            if err.status == 401:
                login_failures.hit(ip)
            audit.record("auth.mfa", outcome="failed", source="ui", ip=ip, details={"reason": err.code})
            raise
        creds = _Credentials(
            remember=ctx["remember"], transport=ctx["transport"], client_name=ctx["client"] or "SE7ENX web"
        )
        if method == "recovery":
            audit.record(
                "auth.mfa",
                actor=actor_of(user),
                source="ui",
                ip=ip,
                details={"method": "recovery", "left": identity.recovery_codes_left(user.id)},
            )
        return issue(request, user, creds, "auth.login")

    @r.post("/auth/register")
    async def register(body: RegisterRequest, request: Request) -> JSONResponse:
        ip = client_ip(request)
        limit(register_limiter, ip, "registrations")
        mode = store.config.security.registration
        if not auth.accounts_enabled or mode == "disabled":
            raise ApiError(
                403,
                "REGISTRATION_DISABLED",
                "Self-registration is turned off on this hub.",
                "Ask an administrator for an account.",
            )
        if mode == "invite" or body.invite_code:
            if not body.invite_code:
                raise ApiError(
                    403, "INVITE_REQUIRED", "An invitation code is required.", "Ask an administrator for an invitation."
                )
            user = await cpu(
                identity.redeem_invite,
                body.invite_code,
                username=body.username,
                display_name=body.display_name,
                password=body.password,
                email=body.email,
            )
            how = "invite"
        else:
            user = await cpu(
                identity.create_user,
                username=body.username,
                display_name=body.display_name,
                role="user",
                password=body.password,
                email=body.email,
            )
            how = "open"
        audit.record(
            "user.registered",
            actor=actor_of(user),
            source="ui",
            ip=ip,
            target_type="user",
            target_id=user.id,
            details={"via": how, "role": user.role},
        )
        return issue(request, user, body, "auth.login", status=201)

    @r.post("/auth/reset")
    async def reset(body: ResetRequest, request: Request) -> JSONResponse:
        ip = client_ip(request)
        limit(register_limiter, ip, "reset attempts")
        try:
            user = await cpu(identity.redeem_reset, body.code, body.new_password)
        except IdentityError as err:
            audit.record("auth.reset", outcome="failed", source="ui", ip=ip, details={"reason": err.code})
            raise
        auth.forget_user(user.id)  # all of this user's sessions were revoked
        audit.record("auth.reset", actor=actor_of(user), source="ui", ip=ip, target_type="user", target_id=user.id)
        return issue(request, user, body, "auth.login")

    # ------------------------------------------------------------------ own account

    @r.post("/auth/logout", status_code=204)
    async def logout(request: Request, session: Session = Depends(need_session)) -> Response:
        if session.kind == "account":
            identity.revoke_session(session.id)
            auth.forget(session.id)
        else:
            pairing_sessions.revoke(session)
        resp = Response(status_code=204)
        auth.clear_cookie(resp)
        audit.record("auth.logout", actor=auth.actor(session), source="ui", ip=client_ip(request))
        return resp

    def account(session: Session) -> User:
        if session.kind != "account" or not session.user_id:
            raise ApiError(
                409, "NOT_AN_ACCOUNT", "This session is not linked to a user account.", "Sign in with an account."
            )
        return identity.require_user(session.user_id)

    @r.get("/auth/me")
    async def me(session: Session = Depends(need_session)) -> dict[str, Any]:
        return me_json(account(session), session.id)

    @r.patch("/auth/me")
    async def patch_me(body: ProfilePatch, session: Session = Depends(need_session)) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        fields = body.model_fields_set
        if "display_name" in fields or "email" in fields:
            identity.update_user(
                user.id,
                display_name=body.display_name,
                **({"email": body.email} if "email" in fields else {}),
            )
        if body.preferences is not None:
            identity.set_preferences(user.id, body.preferences.model_dump(by_alias=True, exclude_none=True))
        return me_json(identity.require_user(user.id), session.id)

    @r.post("/auth/password")
    async def change_password(
        body: PasswordChange, request: Request, session: Session = Depends(need_session)
    ) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        await cpu(identity.change_password, user.id, body.current_password, body.new_password, session_id=session.id)
        auth.forget_user(user.id, except_session_id=session.id)
        audit.record(
            "auth.password_changed",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user.id,
        )
        return me_json(identity.require_user(user.id), session.id)

    # ---- two-factor authentication (TOTP) for the signed-in account
    @r.get("/auth/mfa")
    async def mfa_status(session: Session = Depends(need_session)) -> dict[str, Any]:
        user = account(session)
        return {
            "enabled": user.mfa_enabled,
            "recoveryCodesLeft": identity.recovery_codes_left(user.id) if user.mfa_enabled else 0,
        }

    @r.post("/auth/mfa/totp/setup")
    async def mfa_setup(body: PasswordOnly, session: Session = Depends(need_session)) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        await cpu(identity.confirm_password, user.id, body.password)
        secret, uri = identity.totp_begin(user.id)
        return {"secret": secret, "otpauthUri": uri}

    @r.post("/auth/mfa/totp/confirm")
    async def mfa_confirm(body: MfaCode, request: Request, session: Session = Depends(need_session)) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        codes = identity.totp_confirm(user.id, body.code)
        auth.forget_user(user.id, except_session_id=session.id)
        identity.revoke_user_sessions(user.id, except_session_id=session.id)  # other sessions must sign in with 2FA
        audit.record(
            "auth.mfa_enabled",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user.id,
        )
        return {"recoveryCodes": codes}

    @r.post("/auth/mfa/totp/disable")
    async def mfa_disable(
        body: MfaChange, request: Request, session: Session = Depends(need_session)
    ) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        await cpu(identity.confirm_password, user.id, body.password)
        identity.check_second_factor(user.id, body.code, body.recovery_code)
        identity.totp_disable(user.id)
        audit.record(
            "auth.mfa_disabled",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user.id,
        )
        return {"enabled": False}

    @r.post("/auth/mfa/recovery-codes")
    async def mfa_new_codes(
        body: MfaChange, request: Request, session: Session = Depends(need_session)
    ) -> dict[str, Any]:
        user = account(session)
        limit(account_limiter, session.id, "account changes")
        await cpu(identity.confirm_password, user.id, body.password)
        identity.check_second_factor(user.id, body.code, body.recovery_code)
        codes = identity.regenerate_recovery_codes(user.id)
        audit.record(
            "auth.mfa_codes_renewed",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user.id,
        )
        return {"recoveryCodes": codes}

    @r.get("/auth/sessions")
    async def my_sessions(session: Session = Depends(need_session)) -> dict[str, Any]:
        user = account(session)
        return {"sessions": [s.public(session.id) for s in identity.list_sessions(user.id)]}

    @r.delete("/auth/sessions/{session_id}", status_code=204)
    async def revoke_my_session(
        session_id: str = Path(pattern=r"^[0-9a-f]{16}$"), session: Session = Depends(need_session)
    ) -> Response:
        user = account(session)
        target = identity.get_session(session_id)
        if target is None or target.user_id != user.id:
            raise ApiError(404, "SESSION_NOT_FOUND", "No such session.")
        identity.revoke_session(session_id)
        auth.forget(session_id)
        audit.record(
            "auth.session_revoked", actor=auth.actor(session), source="ui", target_type="session", target_id=session_id
        )
        return Response(status_code=204)

    # ------------------------------------------------------------------ users (administration)

    @r.get("/users")
    async def list_users(_s: Session = Depends(need["user.manage"])) -> dict[str, Any]:
        return {"users": [u.public() for u in identity.list_users()]}

    @r.post("/users", status_code=201)
    async def create_user(
        body: UserCreate, request: Request, session: Session = Depends(need["user.manage"])
    ) -> dict[str, Any]:
        limit(account_limiter, session.id, "account changes")
        manageable(session, body.role)
        user = await cpu(
            identity.create_user,
            username=body.username,
            display_name=body.display_name,
            role=body.role,
            password=body.password,
            email=body.email,
        )
        out: dict[str, Any] = {"user": user.public()}
        if body.password is None:
            code, meta = identity.issue_code(
                "reset", ttl_s=NEW_USER_CODE_TTL_S, user_id=user.id, created_by=session.user_id
            )
            out["setupCode"] = {"code": code, "expiresAt": meta["expiresAt"]}
        audit.record(
            "user.created",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user.id,
            details={"role": user.role, "withPassword": body.password is not None},
        )
        return out

    @r.patch("/users/{user_id}")
    async def patch_user(
        body: UserPatch,
        request: Request,
        user_id: str = UserId,
        session: Session = Depends(need["user.manage"]),
    ) -> dict[str, Any]:
        limit(account_limiter, session.id, "account changes")
        target = identity.require_user(user_id)
        if target.id == session.user_id and (body.role is not None or body.disabled):
            raise ApiError(
                403, "FORBIDDEN", "You cannot change your own role or disable yourself.", "Ask another administrator."
            )
        if target.id != session.user_id:
            manageable(session, target.role)
        if body.role is not None:
            manageable(session, body.role)
        fields = body.model_fields_set
        updated = identity.update_user(
            user_id,
            display_name=body.display_name,
            role=body.role,
            disabled=body.disabled,
            **({"email": body.email} if "email" in fields else {}),
        )
        if body.disabled:
            auth.forget_user(user_id)
        audit.record(
            "user.updated",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user_id,
            details={k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "email"},
        )
        return {"user": updated.public()}

    @r.delete("/users/{user_id}", status_code=204)
    async def delete_user(
        request: Request, user_id: str = UserId, session: Session = Depends(need["user.manage"])
    ) -> Response:
        target = identity.require_user(user_id)
        if target.id == session.user_id:
            raise ApiError(403, "FORBIDDEN", "You cannot delete your own account here.")
        manageable(session, target.role)
        identity.delete_user(user_id)
        auth.forget_user(user_id)
        audit.record(
            "user.deleted",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user_id,
            details={"username": target.username, "role": target.role},
        )
        return Response(status_code=204)

    @r.delete("/users/{user_id}/mfa")
    async def reset_user_mfa(
        request: Request, user_id: str = UserId, session: Session = Depends(need["user.manage"])
    ) -> dict[str, Any]:
        """Account recovery: turn off 2FA for a user who lost their phone (rank rule applies)."""
        target = identity.require_user(user_id)
        if target.id == session.user_id:
            raise ApiError(403, "FORBIDDEN", "Use your own security settings (with your password and a code).")
        manageable(session, target.role)
        identity.totp_disable(user_id)
        identity.revoke_user_sessions(user_id)
        auth.forget_user(user_id)
        audit.record(
            "user.mfa_reset",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user_id,
        )
        return {"user": identity.require_user(user_id).public()}

    @r.post("/users/{user_id}/reset-code")
    async def user_reset_code(
        request: Request, user_id: str = UserId, session: Session = Depends(need["user.manage"])
    ) -> dict[str, Any]:
        target = identity.require_user(user_id)
        if target.id != session.user_id:
            manageable(session, target.role)
        code, meta = identity.issue_code("reset", ttl_s=RESET_CODE_TTL_S, user_id=user_id, created_by=session.user_id)
        audit.record(
            "user.reset_code_issued",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="user",
            target_id=user_id,
        )
        return {"code": code, "expiresAt": meta["expiresAt"]}

    @r.get("/invites")
    async def list_invites(_s: Session = Depends(need["user.manage"])) -> dict[str, Any]:
        return {"invites": identity.list_invites(), "registration": store.config.security.registration}

    @r.post("/invites", status_code=201)
    async def create_invite(
        body: InviteCreate, request: Request, session: Session = Depends(need["user.manage"])
    ) -> dict[str, Any]:
        manageable(session, body.role)
        code, meta = identity.issue_code(
            "invite", ttl_s=body.ttl_hours * 3600, role=body.role, created_by=session.user_id
        )
        audit.record(
            "invite.created",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="invite",
            target_id=meta["id"],
            details={"role": body.role, "ttlHours": body.ttl_hours},
        )
        return {"code": code, **meta}

    @r.delete("/invites/{invite_id}", status_code=204)
    async def revoke_invite(
        invite_id: str = Path(pattern=r"^[0-9a-f]{12}$"), session: Session = Depends(need["user.manage"])
    ) -> Response:
        if not identity.revoke_invite(invite_id):
            raise ApiError(404, "INVITE_NOT_FOUND", "No such invitation.")
        audit.record(
            "invite.revoked", actor=auth.actor(session), source="ui", target_type="invite", target_id=invite_id
        )
        return Response(status_code=204)

    # ------------------------------------------------------------------ roles & security settings

    def roles_json() -> dict[str, Any]:
        return {
            "roles": list(ROLES),
            "rank": RANK,
            "editable": list(EDITABLE_ROLES),
            "permissions": PERMISSIONS,
            "matrix": roles_ref().as_json(),
        }

    @r.get("/roles")
    async def get_roles(session: Session = Depends(need_session)) -> dict[str, Any]:
        if not ({"user.manage", "role.manage"} & session.permissions):
            raise ApiError(
                403, "FORBIDDEN", "Your role does not allow this action.", "Required permission: user.manage."
            )
        return roles_json()

    @r.put("/roles/{role}")
    async def put_role(
        body: RoleUpdate,
        request: Request,
        role: str = Path(pattern=r"^[a-z]{3,16}$"),
        session: Session = Depends(need["role.manage"]),
    ) -> dict[str, Any]:
        try:
            granted = roles_ref().update(role, body.permissions, actor_role=session.role)
        except RoleError as err:
            raise ApiError(err.status, err.code, err.message) from err
        store.config.roles = roles_ref().overrides()  # type: ignore[assignment]
        store.save()
        audit.record(
            "role.updated",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type="role",
            target_id=role,
            details={"permissions": sorted(granted)},
        )
        return roles_json()

    @r.get("/system/security")
    async def get_security(_s: Session = Depends(need["system.configure"])) -> dict[str, Any]:
        return {"registration": store.config.security.registration, "passwordMinLength": settings.password_min_length}

    @r.put("/system/security")
    async def put_security(
        body: SecurityUpdate, request: Request, session: Session = Depends(need["system.configure"])
    ) -> dict[str, Any]:
        store.config.security.registration = body.registration
        store.save()
        audit.record(
            "system.security_updated",
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            details={"registration": body.registration},
        )
        return {"registration": body.registration, "passwordMinLength": settings.password_min_length}

    # ------------------------------------------------------------------ audit ledger

    @r.get("/audit")
    async def audit_log(
        limit_: int = Query(100, alias="limit", ge=1, le=500),
        before: int | None = Query(None, ge=1),
        action: str | None = Query(None, max_length=64, pattern=r"^[a-z_.]+$"),
        actor: str | None = Query(None, pattern=r"^[0-9a-f]{16}$"),
        target_type: str | None = Query(None, alias="targetType", max_length=32, pattern=r"^[a-z_]+$"),
        target_id: str | None = Query(None, alias="targetId", max_length=80),
        outcome: str | None = Query(None, max_length=32, pattern=r"^[a-z_]+$"),
        _s: Session = Depends(need["audit.view"]),
    ) -> dict[str, Any]:
        entries = audit.query(
            limit=limit_,
            before_id=before,
            action=action,
            actor_id=actor,
            target_type=target_type,
            target_id=target_id,
            outcome=outcome,
        )
        return {"entries": entries, "next": entries[-1]["id"] if len(entries) == limit_ else None}

    return r


def identity_exception_handlers() -> dict[type[Exception], Callable[[Request, Exception], Awaitable[JSONResponse]]]:
    from .errors import error_response

    async def on_identity(_r: Request, e: Exception) -> JSONResponse:
        assert isinstance(e, IdentityError)
        return error_response(e.status, e.code, e.message, e.hint, e.retry_after)

    return {IdentityError: on_identity}
