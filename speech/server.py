"""SE7ENX Speech: optional local speech-to-text service (OpenAI-compatible subset).

    POST /v1/audio/transcriptions   multipart form: file, model (ignored alias), language (ISO-639-1,
                                    optional), response_format (json | text | verbose_json), temperature
    GET  /health

Runs faster-whisper (CTranslate2) on the CPU by default. Audio is decoded in memory and discarded:
nothing is written to disk, and transcripts are never logged (only sizes and timings).

Environment:
    SE7ENX_SPEECH_MODEL       tiny | base | small | medium | large-v3 | distil-* | a local path (default: base)
    SE7ENX_SPEECH_DEVICE      cpu | cuda | auto (default: cpu)
    SE7ENX_SPEECH_COMPUTE     int8 | int8_float16 | float16 | float32 (default: int8)
    SE7ENX_SPEECH_THREADS     CPU threads, 0 = automatic (default: 0)
    SE7ENX_SPEECH_MODELS_DIR  model cache directory (default: /models)
    SE7ENX_SPEECH_OFFLINE     true = never download; the model must already be in the cache
    SE7ENX_SPEECH_API_KEY / SE7ENX_SPEECH_API_KEY_FILE   optional bearer key required from callers
    SE7ENX_SPEECH_MAX_BYTES   largest accepted upload (default: 2 MiB)
    SE7ENX_SPEECH_PROMPT      optional initial prompt (vocabulary hints)
"""

from __future__ import annotations

import asyncio
import hmac
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response

log = logging.getLogger("se7enx.speech")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
for _noisy in ("httpx", "httpx2", "huggingface_hub"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


MODEL = os.environ.get("SE7ENX_SPEECH_MODEL", "base")
DEVICE = os.environ.get("SE7ENX_SPEECH_DEVICE", "cpu")
COMPUTE = os.environ.get("SE7ENX_SPEECH_COMPUTE", "int8")
THREADS = int(os.environ.get("SE7ENX_SPEECH_THREADS", "0"))
MODELS_DIR = os.environ.get("SE7ENX_SPEECH_MODELS_DIR", "/models")
OFFLINE = _env_bool("SE7ENX_SPEECH_OFFLINE")
MAX_BYTES = int(os.environ.get("SE7ENX_SPEECH_MAX_BYTES", str(2 * 1024 * 1024)))
PROMPT = os.environ.get("SE7ENX_SPEECH_PROMPT") or None
_key_file = os.environ.get("SE7ENX_SPEECH_API_KEY_FILE")
API_KEY = (Path(_key_file).read_text(encoding="utf-8").strip() if _key_file else os.environ.get("SE7ENX_SPEECH_API_KEY")) or None

state: dict[str, Any] = {"model": None, "loaded_at": None, "error": None}
_gate = asyncio.Semaphore(1)  # one transcription at a time: protects small home servers
_waiting = 0
MAX_QUEUE = 4


def _load_model() -> None:
    from faster_whisper import WhisperModel

    t0 = time.monotonic()
    state["model"] = WhisperModel(
        MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS, download_root=MODELS_DIR, local_files_only=OFFLINE
    )
    state["loaded_at"] = time.time()
    log.info("Model %s loaded on %s/%s in %.1f s", MODEL, DEVICE, COMPUTE, time.monotonic() - t0)


@asynccontextmanager
async def lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
    try:
        await asyncio.to_thread(_load_model)
    except Exception as err:  # noqa: BLE001 - reported on /health, the service stays up
        state["error"] = f"{type(err).__name__}: {err}"
        log.error("Could not load the speech model %s: %s", MODEL, state["error"])
    yield


app = FastAPI(title="SE7ENX Speech", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health")
async def health() -> Response:
    ready = state["model"] is not None
    body = {"ready": ready, "model": MODEL, "device": DEVICE, "compute": COMPUTE, "error": state["error"]}
    return JSONResponse(body, status_code=200 if ready else 503)


def _check_key(authorization: str | None) -> None:
    if API_KEY is None:
        return
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token.encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="invalid API key")


MAX_DECODED_S = 60  # never decode more than this, whatever the container claims (decompression bombs)
SAMPLE_RATE = 16000


def _decode(data: bytes) -> Any:
    """Any container/codec FFmpeg knows (WebM/Opus, Ogg, MP4/AAC, WAV, ...) -> 16 kHz mono float32.

    Decoded here rather than by faster-whisper: faster-whisper 1.2.1 passes an argument that PyAV 16+
    no longer accepts, which made every request fail on fresh installs.
    """
    import av
    import numpy as np

    limit = MAX_DECODED_S * SAMPLE_RATE
    chunks: list[Any] = []
    total = 0
    with av.open(io.BytesIO(data), mode="r") as container:
        stream = next((st for st in container.streams if st.type == "audio"), None)
        if stream is None:
            raise ValueError("no audio stream")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                arr = out.to_ndarray().reshape(-1)
                chunks.append(arr)
                total += arr.size
            if total >= limit:
                break
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return (np.concatenate(chunks)[:limit].astype(np.float32)) / 32768.0


def _transcribe(data: bytes, language: str | None, temperature: float) -> dict[str, Any]:
    model = state["model"]
    audio = _decode(data)
    if audio.size < SAMPLE_RATE // 10:
        return {"text": "", "language": language, "duration": round(audio.size / SAMPLE_RATE, 2)}
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=1,
        temperature=temperature,
        vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt=PROMPT,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),  # noqa: B008 - FastAPI dependency declaration
    model: str = Form("whisper-1"),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
    authorization: str | None = Header(None),
) -> Response:
    global _waiting
    _check_key(authorization)
    if state["model"] is None:
        raise HTTPException(status_code=503, detail=f"model not loaded: {state['error'] or 'loading'}")
    if language is not None and not (len(language) == 2 and language.isalpha()):
        raise HTTPException(status_code=400, detail="language must be an ISO-639-1 code")
    if response_format not in ("json", "text", "verbose_json"):
        raise HTTPException(status_code=400, detail="unsupported response_format")
    data = await file.read(MAX_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="empty audio")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="audio too large")
    if _waiting >= MAX_QUEUE:
        raise HTTPException(status_code=503, detail="busy")
    _waiting += 1
    try:
        async with _gate:
            t0 = time.monotonic()
            try:
                result = await asyncio.to_thread(_transcribe, data, language, max(0.0, min(1.0, temperature)))
            except Exception as err:  # noqa: BLE001 - undecodable audio etc.
                log.info("transcription failed (%d bytes): %s", len(data), type(err).__name__)
                raise HTTPException(status_code=422, detail="audio could not be decoded") from err
            log.info("transcribed %d bytes (%.1f s audio) in %.2f s", len(data), result["duration"], time.monotonic() - t0)
    finally:
        _waiting -= 1
    if response_format == "text":
        return PlainTextResponse(result["text"])
    return JSONResponse(result if response_format == "verbose_json" else {"text": result["text"], "language": result["language"]})
