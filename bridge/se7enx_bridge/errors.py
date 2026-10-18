"""Error type and JSON error envelope shared by every HTTP router.

Every error response has the shape ``{"error": {"code", "message", "hint"}}``.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(
        self, status: int, code: str, message: str, hint: str | None = None, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.retry_after = retry_after


def error_response(
    status: int, code: str, message: str, hint: str | None = None, retry_after: float | None = None
) -> JSONResponse:
    headers = {"Retry-After": str(max(1, round(retry_after)))} if retry_after else None
    if status == 401:
        headers = {**(headers or {}), "WWW-Authenticate": "Bearer"}
    return JSONResponse(
        {"error": {"code": code, "message": message, "hint": hint}}, status_code=status, headers=headers
    )
