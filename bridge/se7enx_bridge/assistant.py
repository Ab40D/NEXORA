"""Optional LLM intent interpreter for "Talk to SE7ENX".

Disabled unless the operator sets ``SE7ENX_LLM_URL`` + ``SE7ENX_LLM_MODEL`` (any OpenAI-compatible
chat-completions API, for example a local Ollama/llama.cpp server on the LAN).

The LLM never executes anything. It receives the user's sentence plus a minimal description of the
selected light, and must answer with a JSON *intent*. The hub validates that JSON strictly against a
fixed schema. The browser then sends the intent through the normal command pipeline (same capability
checks, emergency stop, first-test confirmation and rate limits as a button press). Invalid or
unexpected output becomes ``unknown``, which the UI turns into a clarification question.

Privacy: the user's text is sent to the configured provider; it is never written to the hub's logs.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import httpx2
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .config import Settings
from .core.rbac import PERMISSIONS
from .devices.model import ApiModel, DeviceError
from .security import Session, SlidingWindowLimiter
from .stt import SttClient

log = logging.getLogger("se7enx.assistant")
audit = logging.getLogger("se7enx.audit")

REQUEST_TIMEOUT_S = 15.0
MAX_RESPONSE_BYTES = 64 * 1024

Intent = Literal[
    "turn_on", "turn_off", "toggle", "set_brightness", "adjust_brightness", "query_state", "greeting", "help", "unknown"
]
Lang = Literal["en", "fr", "ar", "dz"]

SYSTEM_PROMPT = """You convert one message to a smart-light assistant into a JSON intent.
The user may write English, French, Modern Standard Arabic or Algerian Darija (Arabic or Latin
script), or mix them. Reply with ONE JSON object and nothing else:
{"intent": "<intent>", "value": <integer or null>, "language": "<en|fr|ar|dz>"}

intents:
- turn_on, turn_off, toggle
- set_brightness: absolute level, value 0-100 ("half" = 50, "full/maximum" = 100)
- adjust_brightness: relative change, value -100..100, not 0 ("a little more" = 10, "a little less" = -10)
- query_state: the user asks whether the light is on or how bright it is
- greeting, help
- unknown: anything else, anything ambiguous, or anything not about this light

Rules: never invent devices, rooms or values; if unsure use "unknown"; brightness requests only
when the light is dimmable, otherwise "unknown". "language" is the language of the message
("dz" for Algerian Darija, "ar" for Modern Standard Arabic)."""


class LlmIntent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    intent: Intent
    value: int | None = None
    language: Lang | None = None

    @model_validator(mode="after")
    def _value_matches_intent(self) -> LlmIntent:
        if self.intent == "set_brightness":
            if self.value is None or not 0 <= self.value <= 100:
                raise ValueError("set_brightness needs value 0-100")
        elif self.intent == "adjust_brightness":
            if self.value is None or not -100 <= self.value <= 100 or self.value == 0:
                raise ValueError("adjust_brightness needs a non-zero value -100..100")
        else:
            self.value = None
        return self


class DeviceContext(ApiModel):
    name: str = Field(default="the light", max_length=80)
    dimmable: bool = False
    on: bool | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)


class InterpretRequest(ApiModel):
    text: str = Field(min_length=1, max_length=300)
    lang: Lang = "en"
    device: DeviceContext | None = None


def _extract_json(content: str) -> Any:
    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        match = re.search(r"\{.*\}", content or "", re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


class LlmInterpreter:
    def __init__(self, settings: Settings, transport: httpx2.AsyncBaseTransport | None = None) -> None:
        self.enabled = bool(settings.llm_url and settings.llm_model)
        self.model = settings.llm_model if self.enabled else None
        self.host = urlsplit(settings.llm_url).hostname if settings.llm_url else None
        self._url = f"{settings.llm_url}/chat/completions" if settings.llm_url else ""
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if settings.llm_api_key:
            headers["Authorization"] = f"Bearer {settings.llm_api_key}"
        self._http: httpx2.AsyncClient | None = (
            httpx2.AsyncClient(
                timeout=httpx2.Timeout(REQUEST_TIMEOUT_S), headers=headers, transport=transport, follow_redirects=False
            )
            if self.enabled
            else None
        )

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def interpret(self, req: InterpretRequest) -> dict[str, Any]:
        if not self.enabled or self._http is None:
            raise DeviceError("LLM_DISABLED", "No AI provider is configured on this hub.", status=404)
        d = req.device or DeviceContext()
        state = "unknown" if d.on is None else ("on" if d.on else "off")
        if d.on and d.brightness is not None:
            state += f", brightness {d.brightness}%"
        context = (
            f'\n\nSelected light: "{d.name}". Dimmable: {"yes" if d.dimmable else "no"}. '
            f"Last reliable state: {state}. Interface language: {req.lang}."
        )
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 120,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT + context},
                {"role": "user", "content": req.text},
            ],
        }
        try:
            resp = await self._http.post(self._url, json=body)
        except httpx2.TimeoutException as err:
            raise DeviceError("LLM_TIMEOUT", "The AI provider did not answer in time.", status=504) from err
        except httpx2.HTTPError as err:
            raise DeviceError(
                "LLM_UNAVAILABLE",
                "The AI provider cannot be reached.",
                hint="Check SE7ENX_LLM_URL on the hub. The built-in assistant still works.",
                status=502,
            ) from err
        if resp.status_code >= 400:
            raise DeviceError("LLM_UNAVAILABLE", f"The AI provider answered HTTP {resp.status_code}.", status=502)
        if len(resp.content) > MAX_RESPONSE_BYTES:
            raise DeviceError("LLM_INVALID_OUTPUT", "The AI provider's answer was too large.", status=502)
        try:
            content = resp.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as err:
            raise DeviceError("LLM_INVALID_OUTPUT", "The AI provider's answer was not understood.", status=502) from err
        parsed = _extract_json(content if isinstance(content, str) else "")
        try:
            intent = LlmIntent.model_validate(parsed)
        except ValidationError:
            log.info("LLM output rejected by the intent schema")
            return {
                "intent": "unknown",
                "value": None,
                "language": None,
                "valid": False,
                "provider": "llm",
                "model": self.model,
            }
        return {
            "intent": intent.intent,
            "value": intent.value,
            "language": intent.language,
            "valid": True,
            "provider": "llm",
            "model": self.model,
        }


def build_assistant_router(
    interpreter: LlmInterpreter,
    require: Callable[[str], Callable[..., Awaitable[Session]]],
    limit: Callable[[SlidingWindowLimiter, str, str], None],
    stt: SttClient | None = None,
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    need = {p: require(p) for p in PERMISSIONS}
    limiter = SlidingWindowLimiter(10, 60.0)
    global_limiter = SlidingWindowLimiter(30, 60.0)
    stt_limiter = SlidingWindowLimiter(20, 60.0)
    stt_global = SlidingWindowLimiter(60, 60.0)

    @r.get("/assistant")
    async def assistant_info(_s: Session = Depends(need["assistant.use"])) -> dict[str, Any]:
        return {
            "llm": {"enabled": interpreter.enabled, "model": interpreter.model, "host": interpreter.host},
            "stt": stt.info() if stt else {"enabled": False, "model": None, "host": None, "maxSeconds": 0},
        }

    @r.post("/assistant/transcribe")
    async def transcribe(
        request: Request,
        lang: Annotated[str | None, Query(max_length=16, pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")] = None,
        session: Session = Depends(need["assistant.use"]),
    ) -> dict[str, Any]:
        """Raw audio body (Content-Type audio/webm|ogg|mp4|wav|...) -> text. Nothing is stored."""
        if stt is None or not stt.enabled:
            raise DeviceError("STT_DISABLED", "Local speech recognition is not configured on this hub.", status=404)
        limit(stt_limiter, session.id, "speech requests")
        limit(stt_global, "all", "speech requests")
        audio = await request.body()
        audit.info("assistant transcribe client=%r bytes=%d", session.client_name, len(audio))
        return await stt.transcribe(audio, request.headers.get("content-type"), lang)

    @r.post("/assistant/interpret")
    async def interpret(body: InterpretRequest, session: Session = Depends(need["assistant.use"])) -> dict[str, Any]:
        if not interpreter.enabled:
            raise DeviceError("LLM_DISABLED", "No AI provider is configured on this hub.", status=404)
        limit(limiter, session.id, "AI requests")
        limit(global_limiter, "all", "AI requests")
        audit.info("assistant interpret client=%r chars=%d", session.client_name, len(body.text))
        return await interpreter.interpret(body)

    return r
