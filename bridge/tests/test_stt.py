"""Local speech-to-text proxy (SE7ENX_STT_URL): contract, limits, permissions, privacy."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.core.rbac import DEFAULT_MATRIX
from se7enx_bridge.stt import SttClient, whisper_language

from .accounts import account_settings, owner_api, user_api

STT_KEY = "stt-test-key-not-a-secret"
TRANSCRIPT = "allume la lumière du salon"


class FakeStt:
    """Stands in for an OpenAI-compatible /v1/audio/transcriptions endpoint."""

    def __init__(self) -> None:
        self.status = 200
        self.payload: Any = {"text": f"  {TRANSCRIPT}  ", "language": "fr"}
        self.fail: Exception | None = None
        self.requests: list[httpx2.Request] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        if self.fail:
            raise self.fail
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["authorization"] == f"Bearer {STT_KEY}"
        self.requests.append(request)
        if isinstance(self.payload, bytes):
            return httpx2.Response(self.status, content=self.payload)
        return httpx2.Response(self.status, json=self.payload)


def _client(tmp_path: Path, fake: FakeStt | None, **overrides: Any) -> TestClient:
    stt_settings = {"stt_url": "http://127.0.0.1:9/v1", "stt_model": "base", "stt_api_key": STT_KEY} if fake else {}
    settings = account_settings(tmp_path, autoconnect=False, **stt_settings, **overrides)
    speech = SttClient(settings, transport=httpx2.MockTransport(fake.handler)) if fake else None
    return TestClient(create_app(settings, speech=speech))


def _post_audio(
    c: TestClient, token: str | None, body: bytes, ctype: str = "audio/webm;codecs=opus", lang: str | None = "fr-FR"
) -> Any:
    headers = {"Content-Type": ctype}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = "/api/v1/assistant/transcribe" + (f"?lang={lang}" if lang else "")
    return c.post(url, content=body, headers=headers)


def test_whisper_language() -> None:
    assert whisper_language("fr-FR") == "fr"
    assert whisper_language("ar-DZ") == "ar"
    assert whisper_language("en") == "en"
    assert whisper_language(None) is None
    assert whisper_language("x") is None


def test_transcribe_forwards_audio_and_returns_text_only(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    fake = FakeStt()
    with _client(tmp_path, fake) as c:
        owner = owner_api(c)
        info = owner.get("/assistant").json()["stt"]
        assert info == {"enabled": True, "model": "base", "host": "127.0.0.1", "maxSeconds": 15}
        audio = b"\x1aE\xdf\xa3" + b"\x00" * 4000  # WebM magic + padding
        r = _post_audio(c, owner.token, audio)
        assert r.status_code == 200, r.text
        body = r.json()
        assert (
            body["text"] == TRANSCRIPT
            and body["language"] == "fr"
            and body["engine"] == "hub"
            and body["model"] == "base"
        )
        sent = fake.requests[-1]
        assert b'name="model"\r\n\r\nbase' in sent.content
        assert b'name="language"\r\n\r\nfr' in sent.content
        assert b'filename="utterance.webm"' in sent.content
        assert audio in sent.content
    assert TRANSCRIPT not in caplog.text  # the hub never logs what was said


def test_transcribe_permissions_and_auth(tmp_path: Path) -> None:
    fake = FakeStt()
    with _client(tmp_path, fake) as c:
        owner = owner_api(c)
        user = user_api(c, owner, "user")  # plain users may use the assistant
        assert _post_audio(c, user.token, b"\x00" * 100).status_code == 200
        assert _post_audio(c, None, b"\x00" * 100).status_code == 401
        # revoke assistant.use from the user role: the hub refuses
        perms = sorted(DEFAULT_MATRIX["user"] - {"assistant.use"})
        assert owner.put("/roles/user", {"permissions": perms}).status_code == 200
        assert _post_audio(c, user.token, b"\x00" * 100).status_code == 403


def test_transcribe_validation_and_limits(tmp_path: Path) -> None:
    fake = FakeStt()
    with _client(tmp_path, fake) as c:
        owner = owner_api(c)
        assert _post_audio(c, owner.token, b"\x00" * 10, ctype="text/plain").status_code == 415
        assert _post_audio(c, owner.token, b"", ctype="audio/wav").status_code == 400
        assert _post_audio(c, owner.token, b"\x00" * 10, lang="fr;rm -rf").status_code == 422
        big = _post_audio(c, owner.token, b"\x00" * (2 * 1024 * 1024 + 4096))
        assert big.status_code == 413
        # the larger limit applies to this endpoint only
        r = owner.post("/assistant/interpret", {"text": "x" * 20000, "lang": "en"})
        assert r.status_code == 413


def test_transcribe_upstream_failures_are_reported(tmp_path: Path) -> None:
    fake = FakeStt()
    with _client(tmp_path, fake) as c:
        owner = owner_api(c)
        fake.status = 500
        assert _post_audio(c, owner.token, b"\x00" * 10).json()["error"]["code"] == "STT_UNAVAILABLE"
        fake.status, fake.payload = 200, b"not json"
        assert _post_audio(c, owner.token, b"\x00" * 10).json()["error"]["code"] == "STT_INVALID_OUTPUT"
        fake.payload = {"text": 42}
        assert _post_audio(c, owner.token, b"\x00" * 10).json()["error"]["code"] == "STT_INVALID_OUTPUT"
        fake.fail = httpx2.ConnectError("refused")
        r = _post_audio(c, owner.token, b"\x00" * 10)
        assert r.status_code == 502 and r.json()["error"]["code"] == "STT_UNAVAILABLE"
        fake.fail = httpx2.ReadTimeout("slow")
        assert _post_audio(c, owner.token, b"\x00" * 10).status_code == 504


def test_transcribe_disabled_by_default(tmp_path: Path) -> None:
    with _client(tmp_path, None) as c:
        owner = owner_api(c)
        assert owner.get("/assistant").json()["stt"]["enabled"] is False
        r = _post_audio(c, owner.token, b"\x00" * 10)
        assert r.status_code == 404 and r.json()["error"]["code"] == "STT_DISABLED"
