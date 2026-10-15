# SE7ENX Bridge

Authenticated LAN bridge between the **SE7ENX Smart Light** web app and a KNX
installation, built on [xknx](https://xknx.io) (the KNX library behind Home
Assistant's KNX integration). It runs next to your KNX IP interface or router —
on a PC, Raspberry Pi, NAS or in Docker — never in the cloud.

* KNXnet/IP **UDP tunnelling**, **TCP tunnelling**, **KNX Secure tunnelling**,
  **routing** and **secure routing**; automatic interface discovery.
* Real `GroupValueWrite` / `GroupValueRead` for DPT **1.001** (switch) and **5.001** (percentage).
* Reports exactly what the interface confirmed (positive / negative `L_Data.con`, timeout)
  and device state from the **status (feedback) address**.
* Pairing codes, short-lived hashed session tokens, origin allowlist, default-deny
  group-address policy, rate limits, audit log. See [`../docs/SECURITY.md`](../docs/SECURITY.md).
* HTTP API + server-sent events — contract in [`../docs/API.md`](../docs/API.md).

## Requirements

* Python **3.11+** (tested with 3.13) on a machine in the **same network** as the KNX
  interface/router (UDP/TCP port 3671 reachable; multicast 224.0.23.12 for routing/discovery).
* A **KNXnet/IP tunnelling interface** with a free tunnel slot, or a **KNX IP router**
  (routing). For KNX Secure: the `.knxkeys` keyring exported from ETS.
* A switch actuator channel whose switching object is linked to a group address
  (DPT 1.001), ideally with a **status/feedback object** on its own group address.

## Install and run

```bash
cd bridge
python3 -m venv .venv && . .venv/bin/activate
pip install .                      # or: pip install -e ".[dev]" for tests
cp .env.example .env               # edit it, then export it, e.g.:
set -a && . ./.env && set +a
se7enx-bridge check-config         # validate, secrets masked
se7enx-bridge scan                 # optional: find KNXnet/IP interfaces
se7enx-bridge                      # start; the pairing code is printed in the log
```

### Docker (Linux)

```bash
cp .env.example .env   # set SE7ENX_HOST=0.0.0.0 or your LAN IP
docker compose up -d --build
docker compose logs -f se7enx-bridge     # pairing code
```

`network_mode: host` is used because KNXnet/IP UDP tunnelling, routing multicast
and discovery need direct LAN access. On Docker Desktop (macOS/Windows) use TCP
tunnelling, or UDP tunnelling with `SE7ENX_KNX_ROUTE_BACK=true`, and publish port 8787.

### systemd (Raspberry Pi etc.)

See [`deploy/se7enx-bridge.service`](deploy/se7enx-bridge.service) (hardened unit,
env file `/etc/se7enx-bridge.env`). `journalctl -u se7enx-bridge -f` shows the pairing code.

## Configuration reference

All settings are environment variables (see [`.env.example`](.env.example)).
Invalid values stop the bridge with a clear message (exit code 2).

| Variable | Default | Notes |
| --- | --- | --- |
| `SE7ENX_HOST` / `SE7ENX_PORT` | `127.0.0.1` / `8787` | Use `0.0.0.0` / LAN IP for other devices. Never port-forward. |
| `SE7ENX_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Exact origins of the web app. `*` refused. |
| `SE7ENX_ALLOWED_GROUP_ADDRESSES` | *(empty = deny all)* | `1/2/3`, `1/2/*`, `1/2/10-20`, `*`. Applies to writes and reads. |
| `SE7ENX_KNX_CONNECTION_TYPE` | `tunneling` if a gateway IP is set, else `automatic` | `automatic`, `tunneling`, `tunneling_tcp`, `tunneling_tcp_secure`, `routing`, `routing_secure` |
| `SE7ENX_KNX_GATEWAY_IP` / `_PORT` | – / `3671` | Interface IP (or hostname) |
| `SE7ENX_KNX_LOCAL_IP` | auto | Local interface for multi-homed hosts |
| `SE7ENX_KNX_ROUTE_BACK` | `false` | UDP tunnelling through NAT (Docker bridge networks) |
| `SE7ENX_KNX_INDIVIDUAL_ADDRESS` | – | Routing source address / requested tunnel slot |
| `SE7ENX_KNX_AUTOCONNECT` | `true` | Connect at startup and retry with back-off (connecting never switches anything) |
| `SE7ENX_KNX_KEYRING_PATH` / `_PASSWORD` | – | KNX Secure keyring from ETS |
| `SE7ENX_KNX_SECURE_USER_ID` / `_USER_PASSWORD` / `_DEVICE_AUTH_PASSWORD` | – | Manual secure tunnelling credentials |
| `SE7ENX_KNX_BACKBONE_KEY` | – | Secure routing (32 hex chars) |
| `SE7ENX_PAIRING_CODE` | random | Fixed code (8–32 alphanumerics) — treat like a password |
| `SE7ENX_PAIRING_TTL_MIN` | `15` | Rotation interval of random codes |
| `SE7ENX_SESSION_TTL_HOURS` / `SE7ENX_MAX_SESSIONS` | `12` / `10` | |
| `SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG` | `false` | Let the browser choose the interface (IPv4 in the CIDRs below only) |
| `SE7ENX_CLIENT_GATEWAY_CIDRS` | RFC 1918 + link-local | |
| `SE7ENX_ENABLE_DISCOVERY` / `SE7ENX_ENABLE_DOCS` | `true` / `false` | Docs = FastAPI `/docs` |
| `SE7ENX_TLS_CERT` / `SE7ENX_TLS_KEY` | – | Serve HTTPS directly |
| `SE7ENX_TRUST_PROXY` | `false` | Honour `X-Forwarded-For` from a trusted reverse proxy |
| `SE7ENX_COMMAND_LIMIT` / `_COMMAND_WINDOW_S` / `_GLOBAL_COMMAND_LIMIT` | `6` / `10` / `20` | Command rate limits |
| `SE7ENX_LOG_LEVEL` | `INFO` | |

## Reaching the bridge from the web app

Browsers enforce rules you cannot bypass; pick one setup:

| Setup | Works in | How |
| --- | --- | --- |
| Web app and bridge on the **same computer** | Chrome, Edge, Firefox (not Safari) | Bridge URL `http://127.0.0.1:8787` (loopback is allowed from HTTPS pages). |
| **Tailscale Serve** (recommended for phones) | All browsers | `tailscale serve --bg 8787` → `https://<host>.<tailnet>.ts.net`; add the web origin to `SE7ENX_ALLOWED_ORIGINS`; set `SE7ENX_TRUST_PROXY=true`. |
| **Bridge TLS on the LAN** | All browsers that trust the cert | e.g. `mkcert bridge.local 192.168.1.5` and install the mkcert CA on your devices; set `SE7ENX_TLS_CERT/KEY`, `SE7ENX_HOST=0.0.0.0`; URL `https://192.168.1.5:8787`. |
| Plain `http://<LAN-IP>:8787` from the HTTPS app | Chrome/Edge 142+ only | Chrome asks for **Local network access** permission — allow it. Safari and Firefox block this as mixed content. |
| Run the web app locally (`npm run dev`) | All browsers | An `http://localhost:3000` page may call `http://` bridges. |
| Reverse proxy / Cloudflare Tunnel **with access control** (advanced) | All browsers | Only behind an identity-aware proxy (e.g. Cloudflare Access). Never expose the bridge or the KNX interface publicly without it. Disable response buffering/compression for `/api/v1/events`. |

## How the bridge talks KNX

* Writes go through xknx's `TelegramQueue.process_telegram_outgoing`, serialized
  with a lock, which waits for the interface's `L_Data.con` (3 s). A subclassed
  `CEMIHandler` records the confirm bit so negative confirmations are reported as
  errors (xknx itself only waits for the frame).
* Routing has no confirmation — commands are reported as `sent_unconfirmed`.
* Every incoming GroupValueWrite/Response updates a per-address cache and is pushed
  to subscribed clients for their registered lights only.
* Reads (`?refresh=1`) send GroupValueRead and wait 2.5 s; actuators answer only if the
  object's **read flag** is set in ETS.

## Development & tests

```bash
pip install -e ".[dev]"
python -m pytest            # 98 tests: config, security, GA vectors, API, real xknx ↔ fake interface
ruff check . && ruff format --check .
python tools/fake_knx_interface.py --port 3671      # FAKE interface (testing only)
python tools/dev_stack.py --port 8799               # real bridge + fake interface in one process (demos/e2e)
```

The fake interface speaks real KNXnet/IP (connect, heartbeat, description,
tunnelling with ACKs, positive/negative/missing `L_Data.con`, actuator feedback,
read responses) and identifies itself as `SE7ENX FAKE KNX (TEST ONLY)`.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `KNX_CONNECT_TIMEOUT` | Wrong IP/port, interface off, firewall blocks UDP 3671, bridge on another VLAN/Wi-Fi with client isolation. |
| `KNX_CONNECT_FAILED` "no more connections" | All tunnel slots in use (ETS, HA, visualisations). Free one or use another slot (`SE7ENX_KNX_INDIVIDUAL_ADDRESS` with TCP/secure). |
| `KNX_NO_GATEWAY_FOUND` | Discovery multicast blocked — set `SE7ENX_KNX_GATEWAY_IP`. |
| Connected, but `KNX_CONFIRMATION_TIMEOUT` | Interface not attached to the bus / bus power missing / overloaded. |
| `KNX_NEGATIVE_CONFIRMATION` | The interface could not transmit on the line (no bus voltage, line coupler filter). |
| Command confirmed, lamp stays "waiting for feedback" | Status address wrong, status object not linked, or actuator sends no feedback. |
| Read state never answers | Read flag not set on the actuator object; feedback telegrams still work. |
| `GA_NOT_ALLOWED` | Add the address to `SE7ENX_ALLOWED_GROUP_ADDRESSES`. |
| Browser shows "Cannot reach the SE7ENX Bridge" | URL/port, `SE7ENX_HOST` still `127.0.0.1`, origin missing in `SE7ENX_ALLOWED_ORIGINS`, mixed-content rules (see table above). |
| Live updates missing behind a proxy | The proxy buffers/compresses SSE — disable for `/api/v1/events` (bridge already sends `Cache-Control: no-transform`). |
| Docker: connects but no telegrams arrive | Use `network_mode: host`, or `SE7ENX_KNX_ROUTE_BACK=true`, or TCP tunnelling. |
