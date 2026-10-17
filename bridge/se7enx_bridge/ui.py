"""Serve the static web UI (Next.js static export) on the same origin as the API.

Used by the appliance image (``SE7ENX_UI_DIR``). The UI talks only to this origin, so the CSP
uses ``connect-src 'self'``. In particular, the MediaPipe library's usage telemetry to Google
cannot leave the browser in the local appliance.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")

UI_CSP = "; ".join(
    [
        "default-src 'self'",
        # Next.js static export inlines bootstrap scripts; MediaPipe needs WebAssembly compilation.
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: mediastream:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

UI_HEADERS = {
    "Content-Security-Policy": UI_CSP,
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}


def mount_ui(app: FastAPI, ui_dir: str) -> None:
    root = Path(ui_dir).resolve()
    not_found = root / "404.html"

    def headers_for(target: Path) -> dict[str, str]:
        h = dict(UI_HEADERS)
        rel = target.relative_to(root).as_posix()
        if rel.startswith("_next/static/"):
            h["Cache-Control"] = "public, max-age=31536000, immutable"  # content-hashed build assets
        elif rel.startswith(("mediapipe/", "models/")):
            h["Cache-Control"] = "public, max-age=86400"
        else:
            h["Cache-Control"] = "no-cache"  # HTML: always revalidate so upgrades show up
        return h

    @app.get("/{path:path}", include_in_schema=False)
    async def ui(path: str, request: Request) -> Response:
        if path == "api" or path.startswith("api/"):
            raise StarletteHTTPException(status_code=404, detail="Not found")
        try:
            target = (root / path).resolve() if path else root / "index.html"
            target.relative_to(root)  # refuses ../ traversal and symlinks pointing outside
        except (ValueError, OSError):
            raise StarletteHTTPException(status_code=404, detail="Not found") from None
        if target.is_dir():
            target = target / "index.html"
        elif not target.exists() and target.with_suffix(".html").is_file():
            target = target.with_suffix(".html")
        if not target.is_file():
            if not_found.is_file():
                return FileResponse(not_found, status_code=404, headers=headers_for(not_found))
            raise StarletteHTTPException(status_code=404, detail="Not found")
        return FileResponse(target, headers=headers_for(target))
