# SE7ENX Speech: optional local speech-to-text for the SE7ENX hub (OpenAI-compatible subset).
# Build: docker build -t se7enx-speech:2.0.0 speech/
FROM python:3.13-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    SE7ENX_SPEECH_MODELS_DIR=/models \
    SE7ENX_SPEECH_MODEL=base

RUN useradd --system --uid 10002 --home-dir /models --shell /usr/sbin/nologin speech \
 && mkdir -p /models /app && chown speech:speech /models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

USER speech
VOLUME ["/models"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
