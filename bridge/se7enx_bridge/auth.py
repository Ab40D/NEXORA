"""Request authentication and authorization for every API route.

A request is authenticated by one of:

* **Account session cookie** (same-origin web UI, e.g. the appliance). The cookie is ``HttpOnly;
  SameSite=Strict; Path=/``; under HTTPS it is also ``Secure`` and uses the ``__Host-`` prefix.
  Unsafe methods (POST/PUT/PATCH/DELETE) authenticated by cookie must prove same-origin through
  the ``Origin`` header (or ``Sec-Fetch-Site: same-origin``). This is the CSRF defence, on top of
  SameSite and the hub's origin allowlist.
* **Account bearer token** (allowed cross-origin web apps such as the Vercel deployment, and
  scripts). The client keeps the token; the hub stores only its hash.
* **Legacy pairing token**. Only possible while no owner account exists; once the owner is
  created, pairing is disabled and existing pairing sessions are revoked.

Authorization is a permission check against the role matrix (``core/rbac.py``), evaluated on
**every** request with the user's current role, so role changes take effect immediately. Denials
are written to the audit ledger.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import Request, Response

from .core.audit import SYSTEM, Actor, AuditLog
from .core.identity import AccountSession, IdentityService, User
from .core.rbac import RoleMatrix
from .errors import ApiError
from .security import Session, SessionStore

COOKIE = "se7enx_session"
SECURE_COOKIE = "__Host-se7enx_session"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_CACHE_LIMIT = 2000


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def is_https(request: Request) -> bool:
    return request.url.scheme == "https"


def same_origin(request: Request) -> bool:
    """Did this request come from a page served by this hub (same scheme, host and port)?"""
    origin = request.headers.get("origin")
    host = (request.headers.get("host") or "").strip().lower()
    if origin:
        parts = urlsplit(origin)
        return bool(host) and parts.netloc.lower() == host and parts.scheme == request.url.scheme
    return request.headers.get("sec-fetch-site") == "same-origin"


def cross_origin(request: Request) -> bool:
    return request.headers.get("origin") is not None and not same_origin(request)


class Auth:
    def __init__(
        self,
        identity: IdentityService,
        roles: Callable[[], RoleMatrix],
        pairing: SessionStore,
        audit: AuditLog,
    ) -> None:
        self.identity = identity
        self.roles = roles
        self.pairing = pairing
        self.audit = audit
        # account session id → Session object, so per-session state (rate limits, legacy lights) survives requests
        self._cache: dict[str, Session] = {}

    @property
    def accounts_enabled(self) -> bool:
        return self.identity.count_users() > 0

    # ------------------------------------------------------------------ principals

    def principal(self, user: User, acc: AccountSession, transport: str) -> Session:
        session = self._cache.get(acc.id)
        if session is None:
            session = Session(
                id=acc.id,
                token_hash="",
                client_name=user.username,
                created_at=acc.created_at,
                expires_at=acc.expires_at,
                ip=acc.ip,
            )
            self._cache[acc.id] = session
            while len(self._cache) > _CACHE_LIMIT:
                self._cache.pop(next(iter(self._cache)))
        session.kind = "account"
        session.user_id = user.id
        session.username = user.username
        session.role = user.role
        session.permissions = self.roles().permissions(user.role)
        session.transport = transport
        session.client_name = f"{user.display_name} (@{user.username})"[:80]
        return session

    def forget(self, session_id: str) -> None:
        self._cache.pop(session_id, None)

    def forget_user(self, user_id: str, *, except_session_id: str | None = None) -> None:
        for sid in [k for k, v in self._cache.items() if v.user_id == user_id and k != except_session_id]:
            self._cache.pop(sid, None)

    @staticmethod
    def actor(session: Session | None) -> Actor:
        if session is None:
            return SYSTEM
        if session.kind == "account":
            return Actor(session.user_id, session.username or session.client_name, session.role)
        return Actor(None, f"paired client {session.client_name}", "owner")

    # ------------------------------------------------------------------ resolution

    @staticmethod
    def _token(request: Request) -> tuple[str | None, str]:
        scheme, _, token = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            return token.strip(), "bearer"
        cookie = request.cookies.get(SECURE_COOKIE) or request.cookies.get(COOKIE)
        if cookie:
            return cookie, "cookie"
        return None, "none"

    async def resolve(self, request: Request) -> Session:
        token, transport = self._token(request)
        accounts = self.accounts_enabled
        if token is None:
            raise ApiError(
                401,
                "UNAUTHORIZED",
                "Sign in first." if accounts else "Missing bearer token.",
                "Sign in with your SE7ENX account." if accounts else "Pair this browser with the bridge first.",
            )
        if transport == "bearer":
            paired = self.pairing.authenticate(token)
            if paired is not None:
                return paired
        found = self.identity.authenticate(token)
        if found is None:
            raise ApiError(
                401,
                "SESSION_INVALID",
                "Your session has expired or was signed out."
                if accounts
                else "The session token is invalid, expired or revoked.",
                "Sign in again." if accounts else "Pair again with the current code from the bridge console.",
            )
        user, acc = found
        if transport == "cookie" and request.method in UNSAFE_METHODS and not same_origin(request):
            raise ApiError(
                403, "CSRF_REJECTED", "This request did not come from the SE7ENX app.", "Reload the app and try again."
            )
        return self.principal(user, acc, transport)

    def require(self, permission: str | None = None) -> Callable[[Request], Awaitable[Session]]:
        """FastAPI dependency: an authenticated caller, optionally holding ``permission``."""

        async def dependency(request: Request) -> Session:
            session = await self.resolve(request)
            if permission is not None and permission not in session.permissions:
                self.audit.record(
                    "access.denied",
                    actor=self.actor(session),
                    outcome="denied",
                    ip=client_ip(request),
                    details={"permission": permission, "method": request.method, "path": request.url.path},
                )
                raise ApiError(
                    403,
                    "FORBIDDEN",
                    "Your role does not allow this action.",
                    f"Required permission: {permission}. Ask an administrator if you need it.",
                )
            return session

        dependency.__name__ = f"require_{(permission or 'session').replace('.', '_')}"
        return dependency

    def is_active(self, session: Session) -> bool:
        if session.kind == "account":
            return self.identity.session_active(session.id)
        return self.pairing.is_active(session)

    # ------------------------------------------------------------------ cookies

    @staticmethod
    def set_cookie(response: Response, request: Request, token: str, *, remember: bool, max_age: int) -> None:
        secure = is_https(request)
        response.set_cookie(
            SECURE_COOKIE if secure else COOKIE,
            token,
            max_age=max_age if remember else None,
            path="/",
            secure=secure,
            httponly=True,
            samesite="strict",
        )

    @staticmethod
    def clear_cookie(response: Response) -> None:
        response.delete_cookie(COOKIE, path="/", httponly=True, samesite="strict")
        response.delete_cookie(SECURE_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
