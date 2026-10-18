"""Local HTTPS helpers: TLS status, CA certificate download and the setup page (all public).

Only public material is served: the CA *certificate* and its fingerprint. The CA private key and
the server key never leave ``$SE7ENX_DATA_DIR/tls`` (mode 0600).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from .config import Settings
from .errors import error_response
from .hosts import HostPolicy, split_host_header
from .tls import ca_info, setup_page

CA_FILENAME = "se7enx-local-ca.crt"


def ca_path(settings: Settings) -> Path | None:
    if settings.tls_mode != "local-ca" or not settings.data_dir:
        return None
    path = Path(settings.data_dir) / "tls" / "ca.pem"
    return path if path.is_file() else None


def _cert_hosts(settings: Settings) -> list[str]:
    if not settings.tls_cert:
        return []
    try:
        from cryptography import x509

        pem = Path(settings.tls_cert).read_bytes()
        cert = x509.load_pem_x509_certificate(pem)
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        return [str(n.value) for n in san if isinstance(n, (x509.DNSName, x509.IPAddress))]
    except Exception:
        return []


def _ca_response(path: Path) -> Response:
    return Response(
        path.read_bytes(),
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": f'attachment; filename="{CA_FILENAME}"', "Cache-Control": "no-cache"},
    )


def build_tls_router(settings: Settings) -> APIRouter:
    r = APIRouter(prefix="/api/v1/tls", tags=["tls"])
    hosts = _cert_hosts(settings)

    @r.get("")
    async def tls_status(request: Request) -> dict[str, Any]:
        ca = ca_path(settings)
        host = split_host_header(request.headers.get("host") or "")
        out: dict[str, Any] = {
            "mode": settings.tls_mode,
            "https": request.url.scheme == "https",
            "certificateHosts": hosts,
            "requestHostCovered": (host in hosts) if hosts else None,
            "caDownload": bool(ca),
        }
        if ca:
            out.update(ca_info(ca))
        return out

    @r.get("/ca.crt", include_in_schema=False)
    async def tls_ca() -> Response:
        ca = ca_path(settings)
        if not ca:
            return error_response(404, "NO_LOCAL_CA", "This hub does not use the SE7ENX local CA.")
        return _ca_response(ca)

    return r


def mount_setup_page(app: FastAPI, settings: Settings) -> None:
    @app.get("/setup/ca", include_in_schema=False)
    async def setup_ca() -> Response:
        ca = ca_path(settings)
        if not ca:
            return error_response(404, "NO_LOCAL_CA", "This hub does not use the SE7ENX local CA.")
        return HTMLResponse(setup_page(str(ca_info(ca)["fingerprintSha256"]), None), headers=_PAGE_HEADERS)


_PAGE_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}


def create_redirect_app(settings: Settings) -> FastAPI:
    """Plain-HTTP helper (SE7ENX_HTTP_REDIRECT_PORT): CA download page, everything else -> HTTPS.

    No API is served over plain HTTP. Redirect targets are built from a validated Host header only,
    so this cannot be used as an open redirect.
    """
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    policy = HostPolicy(settings.allowed_hosts or ("auto",))  # IPs and local names only by default

    def https_url(request: Request, path: str) -> str | None:
        host = split_host_header(request.headers.get("host") or "")
        if not host or not policy.allows(request.headers.get("host")):
            return None
        netloc = f"[{host}]" if ":" in host else host
        if settings.port != 443:
            netloc = f"{netloc}:{settings.port}"
        query = urlsplit(str(request.url)).query
        return f"https://{netloc}{path}" + (f"?{query}" if query else "")

    @app.get("/setup/ca", include_in_schema=False)
    @app.get("/", include_in_schema=False)
    async def page(request: Request) -> Response:
        ca = ca_path(settings)
        target = https_url(request, "/")
        if target is None:
            return error_response(421, "HOST_NOT_ALLOWED", "This host name is not allowed for the SE7ENX hub.")
        if not ca:
            return RedirectResponse(target, status_code=308)
        return HTMLResponse(setup_page(str(ca_info(ca)["fingerprintSha256"]), target), headers=_PAGE_HEADERS)

    @app.get("/api/v1/tls/ca.crt", include_in_schema=False)
    async def ca_download(request: Request) -> Response:
        ca = ca_path(settings)
        if not ca:
            return error_response(404, "NO_LOCAL_CA", "This hub does not use the SE7ENX local CA.")
        return _ca_response(ca)

    @app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE"], include_in_schema=False)
    async def redirect(request: Request, path: str) -> Response:
        target = https_url(request, "/" + path)
        if target is None:
            return error_response(421, "HOST_NOT_ALLOWED", "This host name is not allowed for the SE7ENX hub.")
        return RedirectResponse(target, status_code=308)

    @app.middleware("http")
    async def headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        resp: Response = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    return app
