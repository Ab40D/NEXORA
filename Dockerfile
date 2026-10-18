# syntax=docker/dockerfile:1
#
# SE7ENX appliance image: the local hub (Python: FastAPI + xknx) serving the web UI on the same
# origin. One container, one port, non-root, works with a read-only root filesystem.
#
#   docker build -t se7enx:2.0.0 --build-arg SE7ENX_VERSION=2.0.0 .
#   docker compose -f deploy/appliance/compose.yaml up -d      (recommended)
#
# Node is only used at build time to produce the static UI (SE7ENX_BUILD_TARGET=appliance).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.13-slim-bookworm

# --------------------------------------------------------------------------- 1. web UI
FROM ${NODE_IMAGE} AS ui
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY public ./public
# postinstall copies the MediaPipe WASM runtime into public/ (no network access needed for it)
RUN npm ci --no-audit --no-fund
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs next-env.d.ts ./
COPY src ./src
# The build re-verifies the hand-landmark model's SHA-256 (scripts/prepare-assets.mjs).
RUN SE7ENX_BUILD_TARGET=appliance NEXT_PUBLIC_SE7ENX_APPLIANCE=true npm run build

# --------------------------------------------------------------------------- 2. hub runtime
FROM ${PYTHON_IMAGE} AS runtime
ARG SE7ENX_VERSION=dev
LABEL org.opencontainers.image.title="SE7ENX" \
      org.opencontainers.image.description="Local-first SE7ENX smart-building hub and web UI (Home Assistant, Shelly, KNX)" \
      org.opencontainers.image.version="${SE7ENX_VERSION}" \
      org.opencontainers.image.licenses="MIT"

# Appliance defaults (override in deploy/appliance/.env):
# - same-origin UI only: Host allowlist "auto", no cross-origin web apps
# - persistent configuration in /data (volume)
# - KNX is not contacted until a KNX interface is configured (SE7ENX_KNX_AUTOCONNECT=true)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SE7ENX_HOST=0.0.0.0 \
    SE7ENX_PORT=8787 \
    SE7ENX_DATA_DIR=/data \
    SE7ENX_UI_DIR=/app/ui \
    SE7ENX_ALLOWED_HOSTS=auto \
    SE7ENX_ALLOWED_ORIGINS=none \
    SE7ENX_KNX_AUTOCONNECT=false

RUN useradd --system --uid 10001 --user-group --home-dir /app --shell /usr/sbin/nologin se7enx \
 && install -d -o se7enx -g se7enx -m 0750 /data

WORKDIR /app
COPY bridge/pyproject.toml bridge/README.md bridge/constraints.txt /tmp/se7enx-bridge/
COPY bridge/se7enx_bridge /tmp/se7enx-bridge/se7enx_bridge
# constraints.txt pins the exact runtime versions the hub was tested with
RUN pip install --no-cache-dir -c /tmp/se7enx-bridge/constraints.txt /tmp/se7enx-bridge \
 && rm -rf /tmp/se7enx-bridge

COPY --from=ui /src/out /app/ui

USER se7enx
EXPOSE 8787
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD python -c "import os,ssl,urllib.request as u; tls=os.environ.get('SE7ENX_TLS_CERT') or os.environ.get('SE7ENX_TLS','off') in ('local-ca','files'); u.urlopen(('https' if tls else 'http')+'://127.0.0.1:'+os.environ.get('SE7ENX_PORT','8787')+'/api/v1/health', timeout=4, context=ssl._create_unverified_context())" || exit 1

CMD ["se7enx-bridge"]
