# SE7ENX Bridge container. Run with host networking on Linux (see docker-compose.yml):
# KNXnet/IP UDP tunnelling, routing multicast and discovery need direct LAN access.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SE7ENX_HOST=0.0.0.0

WORKDIR /app
RUN useradd --create-home --uid 10001 se7enx

COPY pyproject.toml README.md ./
COPY se7enx_bridge ./se7enx_bridge
RUN pip install --no-cache-dir .

USER se7enx
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,ssl,urllib.request; s='https' if os.environ.get('SE7ENX_TLS_CERT') else 'http'; urllib.request.urlopen(f'{s}://127.0.0.1:{os.environ.get(\"SE7ENX_PORT\",\"8787\")}/api/v1/health', timeout=4, context=ssl._create_unverified_context())" || exit 1

CMD ["se7enx-bridge"]
