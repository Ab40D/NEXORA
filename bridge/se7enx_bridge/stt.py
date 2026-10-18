"""Optional local speech-to-text for the assistant (SE7ENX_STT_URL).

Why: the browser Web Speech API is not a local or universal solution. Firefox has no speech
recognition at all, Chromium builds without Google API keys (e.g. Arch Linux's chromium) fail with
a "network" error, and Chrome/Safari send audio to their vendor's cloud. SE7ENX can instead
record a short utterance in the browser (MediaRecorder, after an explicit click) and transcribe it
on a speech service in your own network.

The hub forwards the audio to an OpenAI-compatible ``POST {SE7ENX_STT_URL}/audio/transcriptions``
endpoint (the optional SE7ENX speech container in ``speech/``, or any compatible local server) and
returns only the text. Audio and transcripts are never stored or logged by the hub; the
transcript is then handled by the normal assistant pipeline (allowlisted intents, permissions).
"""

from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import urlsplit

import httpx2

from .config import Settings
from .devices.model import DeviceError

log = logging.getLogger("se7enx.stt")

MAX_AUDIO_BYTES = 2 * 1024 * 1024  # ~2 min of Opus, ~60 s of 16 kHz WAV: far above one command
MAX_RESPONSE_BYTES = 64 * 1024
REQUEST_TIMEOUT_S = 45.0
AUDIO_TYPES = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
}


def audio_extension(content_type: str | None) -> str | None:
    base = (content_type or "").split(";", 1)[0].strip().lower()
    return AUDIO_TYPES.get(base)


def whisper_language(tag: str | None) -> str | None:
    """BCP-47 (e.g. "fr-FR", "ar-DZ") to the ISO-639-1 code Whisper expects ("fr", "ar")."""
    if not tag:
        return None
    primary = tag.split("-", 1)[0].strip().lower()
    return primary if len(primary) == 2 and primary.isalpha() else None


class SttClient:
    def __init__(self, settings: Settings, transport: httpx2.AsyncBaseTransport | None = None) -> None:
        self.enabled = bool(settings.stt_url)
        self.model = settings.stt_model if self.enabled else None
        self.host = urlsplit(settings.stt_url).hostname if settings.stt_url else None
        self.max_seconds = settings.stt_max_seconds
        self._url = f"{settings.stt_url}/audio/transcriptions" if settings.stt_url else ""
        headers = {"Accept": "application/json"}
        if settings.stt_api_key:
            headers["Authorization"] = f"Bearer {settings.stt_api_key}"
        self._http: httpx2.AsyncClient | None = (
            httpx2.AsyncClient(
                timeout=httpx2.Timeout(REQUEST_TIMEOUT_S), headers=headers, transport=transport, follow_redirects=False
            )
            if self.enabled
            else None
        )

    def info(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "model": self.model, "host": self.host, "maxSeconds": self.max_seconds}

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def transcribe(self, audio: bytes, content_type: str | None, lang: str | None) -> dict[str, Any]:
        if not self.enabled or self._http is None:
            raise DeviceError(
                "STT_DISABLED",
                "Local speech recognition is not configured on this hub.",
                hint="Set SE7ENX_STT_URL (e.g. the SE7ENX speech container) or use the browser's speech recognition.",
                status=404,
            )
        ext = audio_extension(content_type)
        if ext is None:
            raise DeviceError("STT_BAD_AUDIO", "Unsupported audio format.", status=415)
        if not audio:
            raise DeviceError("STT_BAD_AUDIO", "No audio was received.", status=400)
        if len(audio) > MAX_AUDIO_BYTES:
            raise DeviceError("STT_BAD_AUDIO", "The recording is too long.", status=413)
        data: dict[str, str] = {"model": self.model or "whisper-1", "response_format": "json", "temperature": "0"}
        language = whisper_language(lang)
        if language:
            data["language"] = language
        files = {"file": (f"utterance.{ext}", audio, (content_type or "").split(";", 1)[0])}
        t0 = time.monotonic()
        try:
            resp = await self._http.post(self._url, data=data, files=files)
        except httpx2.TimeoutException as err:
            raise DeviceError("STT_TIMEOUT", "The speech service did not answer in time.", status=504) from err
        except httpx2.HTTPError as err:
            raise DeviceError(
                "STT_UNAVAILABLE",
                "The speech service cannot be reached.",
                hint="Check SE7ENX_STT_URL on the hub and that the speech service is running.",
                status=502,
            ) from err
        if resp.status_code >= 400:
            raise DeviceError("STT_UNAVAILABLE", f"The speech service answered HTTP {resp.status_code}.", status=502)
        if len(resp.content) > MAX_RESPONSE_BYTES:
            raise DeviceError("STT_INVALID_OUTPUT", "The speech service's answer was too large.", status=502)
        try:
            payload = resp.json()
            text = payload["text"]
        except (ValueError, KeyError, TypeError) as err:
            raise DeviceError(
                "STT_INVALID_OUTPUT", "The speech service's answer was not understood.", status=502
            ) from err
        if not isinstance(text, str):
            raise DeviceError("STT_INVALID_OUTPUT", "The speech service's answer was not understood.", status=502)
        detected = payload.get("language") if isinstance(payload, dict) else None
        elapsed = int((time.monotonic() - t0) * 1000)
        log.info("transcribed %d bytes in %d ms", len(audio), elapsed)  # never the text or the audio
        return {
            "text": " ".join(text.split())[:500],
            "language": detected if isinstance(detected, str) and len(detected) <= 16 else language,
            "engine": "hub",
            "model": self.model,
            "ms": elapsed,
        }
