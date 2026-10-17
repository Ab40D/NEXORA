# SE7ENX local appliance: installation & operations

Run SE7ENX on your own machine (mini PC, NAS, server, Raspberry Pi class hardware) and use it on your
local network. One container serves the web UI **and** the hub API on the same port, keeps its
configuration in a Docker volume, and talks to your Home Assistant, Shelly and KNX equipment
**locally**. No public domain, port forwarding or cloud backend is needed.

> Status (1.1.0): build, Compose start-up, persistence, health checks, simulated devices, a fake
> Home Assistant in a second container and the UI were tested in Docker Engine 26.1 / Compose 2.26
> on x86-64. **Physical Shelly, KNX and real Home Assistant installations were not available for
> testing**; see [HARDWARE_TEST_MATRIX.md](HARDWARE_TEST_MATRIX.md). ARM64 (Raspberry Pi) builds are
> expected to work (multi-arch base images) but were not tested.

## 1. Requirements

* Docker Engine **25 or newer** and Docker Compose **2.24 or newer** (the health check uses
  `--start-interval`; the Compose file uses optional `env_file` and `!reset`).
* About 300 MB of disk for the image, and a few MB for configuration.
* Building the image needs internet access (base images, npm and PyPI packages). **Running** it does not.

There is no official registry image yet. Build it from this repository (step 2 does this
automatically). Releases are tagged `se7enx:<version>`, currently `se7enx:1.1.0`.

## 2. Install

```bash
git clone <your copy of this repository> se7enx   # or download and unpack a release archive
cd se7enx/deploy/appliance
cp .env.example .env            # optional: all settings have safe defaults
docker compose up -d --build    # builds se7enx:1.1.0 and starts it
docker compose ps               # wait for "(healthy)", usually a few seconds
docker compose logs se7enx      # shows the one-time pairing code
```

Open `http://<IP of this machine>:8787` (or `http://localhost:8787` on the machine itself), go to
the **Devices** tab and enter the pairing code. Codes are single-use and rotate every 15 minutes. A
new one is printed after each pairing.

## 3. First steps in the UI

1. **Devices → Add device → Simulated** (or set `SE7ENX_SAMPLE_DEVICES=true`) to try the interface
   without hardware. Simulated devices are labelled everywhere and never touch hardware.
2. **Home Assistant**: enter the URL **as reachable from the container** (see §5) and a
   long-lived access token (HA → your profile → Security). Prefer a dedicated non-admin HA user.
   **Test connection**, **Save & connect**, then add the entities you want. The token is stored on
   the hub in `secrets.json` only. The browser never receives it.
3. **Shelly**: enter the device's IP address (and password if enabled), **Identify device**,
   choose a channel, add it. Gen1 (HTTP) and Gen2+ (Plus/Pro/Gen3/Gen4, RPC) are detected
   automatically. Only the capabilities the device reports are offered.
4. **KNX**: configure the KNX interface in `.env` (§4), then add devices with their explicit
   group addresses: switch/light (1.001), absolute brightness (5.001), relative dimming (3.007),
   blinds (1.008 / stop / 5.001 position) and sensors (any DPT supported by xknx).
5. Every real device starts **read-only**. Check that the reported state is correct, then use
   **Enable control…** and confirm the warning. **Stop all devices** (the hub emergency stop) blocks
   real-device commands from every browser until you resume.

## 4. Configuration (`deploy/appliance/.env`)

Defaults baked into the image: `SE7ENX_DATA_DIR=/data`, `SE7ENX_UI_DIR=/app/ui`,
`SE7ENX_ALLOWED_HOSTS=auto`, `SE7ENX_ALLOWED_ORIGINS=none` (same-origin UI only),
`SE7ENX_KNX_AUTOCONNECT=false`.

| Variable | Purpose |
| --- | --- |
| `SE7ENX_IMAGE`, `SE7ENX_HTTP_PORT`, `SE7ENX_BIND_ADDRESS` | Compose only: image tag (pin it), host port, host interface to publish on |
| `SE7ENX_ALLOWED_HOSTS` | Host names accepted in the browser's address bar. `auto` = IP addresses, `localhost`, `*.local`, `*.home.arpa`; add your own, e.g. `auto,se7enx.example.lan` |
| `SE7ENX_PAIRING_CODE` | Leave unset for random single-use codes (recommended) |
| `SE7ENX_SESSION_TTL_HOURS` | Browser session lifetime (default 12) |
| `SE7ENX_SAMPLE_DEVICES` | Add simulated demo devices when the list is empty |
| `SE7ENX_HA_URL`, `SE7ENX_HA_TOKEN_FILE` (or `SE7ENX_HA_TOKEN`), `SE7ENX_HA_VERIFY_TLS` | Home Assistant via environment (then read-only in the UI). Prefer the Docker secret file (commented example in `compose.yaml`) |
| `SE7ENX_SHELLY_POLL_S` | Shelly status polling interval (default 5 s) |
| `SE7ENX_KNX_AUTOCONNECT`, `SE7ENX_KNX_CONNECTION_TYPE`, `SE7ENX_KNX_GATEWAY_IP`, `SE7ENX_KNX_GATEWAY_PORT`, `SE7ENX_KNX_ROUTE_BACK`, KNX Secure variables | KNX interface (see `bridge/.env.example` for all KNX options) |
| `SE7ENX_ALLOWED_GROUP_ADDRESSES` | Optional operator ceiling: KNX devices may only use addresses inside it |
| `SE7ENX_DEVICE_MIN_INTERVAL_MS` | Minimum time between two commands to the same device (default 300 ms) |
| `SE7ENX_TLS_CERT`, `SE7ENX_TLS_KEY` | Serve HTTPS directly (mount `./certs`, see `compose.yaml`) |
| `SE7ENX_LOG_LEVEL` | `INFO` (default), `DEBUG`, `WARNING`, `ERROR` |

Restart after changes: `docker compose up -d`.

## 5. Network addressing

The hub connects **from inside the container**. Use addresses the container can reach.

| Where Home Assistant runs | URL to enter |
| --- | --- |
| Another machine on the LAN | `http://192.168.x.y:8123` (an IP is most reliable: containers usually cannot resolve mDNS `*.local` names) |
| Another container in **this** Compose project | `http://<service-name>:8123` (tested with a container named `fake-ha` on the project network) |
| Another Compose project / standalone container | Join both to a shared Docker network, then use the container name |
| The same host, outside Docker | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service and use `http://host.docker.internal:8123` |
| Home Assistant OS with HTTPS and a self-signed certificate | `https://...` with **Verify TLS certificate** turned off (LAN only) |

Home Assistant never has to be exposed to the internet.

* **Shelly**: device IPs on your LAN are reachable through Docker's default bridge network (NAT).
  Device addresses must be private / link-local (the hub refuses public addresses and loopback).
* **KNX tunnelling**: use `SE7ENX_KNX_CONNECTION_TYPE=tunneling_tcp` (works through NAT) or UDP
  `tunneling` with `SE7ENX_KNX_ROUTE_BACK=true`.
* **KNX routing (multicast) and interface discovery** need host networking. This is **opt-in**:
  `docker compose -f compose.yaml -f compose.host-network.yaml up -d`, with `SE7ENX_HOST` set to the
  machine's LAN IP. Do this only if you need routing.

## 6. HTTPS (camera gestures and voice)

Browsers allow the camera and microphone only on `https://` pages or `http://localhost`. Over
`http://<LAN-IP>` everything except gestures and voice works. Options:

* Mount a certificate trusted by your devices (e.g. created with mkcert) and set `SE7ENX_TLS_CERT`
  / `SE7ENX_TLS_KEY`. Open `https://<name>:8787` and add the name to `SE7ENX_ALLOWED_HOSTS`.
* Put a TLS reverse proxy (Caddy, Traefik, Tailscale Serve) in front of the hub. Add the proxy's host
  name to `SE7ENX_ALLOWED_HOSTS`. The proxy must forward the original `Host` header.

Never forward the port on your router.

## 7. Data, backup and export

The volume `se7enx_se7enx-data` (mounted at `/data`) holds:

* `config.json`: devices and settings, **no secrets** (plus `config.json.bak`, the previous version);
* `secrets.json`: Home Assistant token and device passwords (mode 0600).

**Export without credentials** (safe to share): **Devices → Export**, or `GET /api/v1/config/export`.
Devices that need credentials are marked `credentialsRequired: true`.

**Full backup** (includes `secrets.json`, so protect the file):

```bash
docker compose stop
docker run --rm --user 0 -v se7enx_se7enx-data:/data:ro -v "$PWD":/backup --entrypoint tar \
  se7enx:1.1.0 czf /backup/se7enx-data-$(date +%Y%m%d).tgz -C /data .
docker compose start
```

**Restore** into the (stopped) volume:

```bash
docker compose stop
docker run --rm --user 0 -v se7enx_se7enx-data:/data -v "$PWD":/backup:ro --entrypoint sh \
  se7enx:1.1.0 -c 'tar xzf /backup/se7enx-data-YYYYMMDD.tgz -C /data && chown -R se7enx:se7enx /data'
docker compose start
```

(Both commands were tested; file modes, including 0600 for `secrets.json`, are preserved.)

## 8. Upgrade and rollback

1. Back up (§7) and note the current tag (`SE7ENX_IMAGE`, default `se7enx:1.1.0`).
2. Get the new release source, then build and start it (Compose tags the build with `SE7ENX_IMAGE`):
   `SE7ENX_IMAGE=se7enx:<new> SE7ENX_VERSION=<new> docker compose up -d --build`
   (or put both variables in `.env`).
3. Check `docker compose ps` (healthy), `docker compose logs`, and that your devices report state.

**Rollback**: set `SE7ENX_IMAGE` back to the previous tag and `docker compose up -d`. The
configuration file carries a schema `version`. A hub refuses to start on a configuration it cannot
read (clear message in the log), rather than overwriting it. If a newer release migrated the
configuration, restore the backup taken in step 1.

Always pin a version tag. There is no `latest` tag on purpose.

## 9. Health, logs, start and stop

* `docker compose ps` shows `(healthy)` once `GET /api/v1/health` answers (checked every 30 s, every
  2 s during start-up).
* `docker compose logs -f se7enx`: pairing codes, the audit trail (`se7enx.audit`: device changes,
  real-control enablement, commands with outcome) and integration errors. Tokens and passwords are
  never logged. Logs rotate (3 × 10 MB).
* `docker compose stop` shuts down gracefully (tested: under 1 s).

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `HOST_NOT_ALLOWED` (HTTP 421) | You opened SE7ENX by a host name that is not allowed: use its IP, or add the name to `SE7ENX_ALLOWED_HOSTS` |
| Pairing code rejected | Codes are single-use and rotate every 15 min: take the newest from `docker compose logs se7enx` |
| A public website cannot reach the hub | By design: the appliance accepts only its own UI (`SE7ENX_ALLOWED_ORIGINS=none`) |
| Home Assistant `disconnected` / `HA_UNREACHABLE` | Use an address the container can reach (§5), check `http` vs `https`, firewall, HA port |
| Home Assistant `token rejected` | Create a new long-lived token and save it. SE7ENX does not retry a rejected token on its own (HA may ban IPs) |
| Shelly `SHELLY_AUTH_FAILED` / `SHELLY_THROTTLED` | Check the password (Gen2+: user `admin`); after many failed logins, Gen2+ devices throttle for minutes |
| Shelly offline | IP changed (use a DHCP reservation), device asleep (battery devices are not supported), different VLAN |
| KNX `not set up` / offline | Set `SE7ENX_KNX_AUTOCONNECT=true` and the gateway; use TCP tunnelling or `ROUTE_BACK=true`; free a tunnel slot on the interface |
| "Requested … waiting for the device to confirm" stays | The device accepted the command but did not report the new state: check the status/feedback address (KNX) or the entity in HA |
| Camera / voice unavailable | Use HTTPS or `localhost` (§6) |
| Container restarts with "config.json is invalid" | Restore `config.json.bak` or a backup (§7). The hub never overwrites an unreadable configuration |

## 11. Internet / external services

| Feature | Needs internet? |
| --- | --- |
| UI, device control, Home Assistant, Shelly, KNX | **No** (all local) |
| Building the image | Yes (base images, npm, PyPI) |
| Voice commands | Usually yes: the browser's speech service (Google/Apple) unless on-device recognition is available |
| Gesture recognition | No. The MediaPipe library's usage telemetry is **blocked** in the appliance by its content security policy (`connect-src 'self'`) |

## 12. Security notes

* Container: non-root user, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, no Docker socket, no device access, no host networking by default.
* Only the UI/API port is published. Do not forward it on your router. Use a VPN (e.g. Tailscale) for
  remote access.
* Browser sessions are created by pairing codes printed in the container log: whoever can read
  `docker compose logs` can pair. There are no user roles yet; every paired browser can manage
  devices (see [SECURITY_AUDIT.md](../SECURITY_AUDIT.md), SE7-04).

## 13. Proxmox LXC (future)

No LXC template is provided yet. Two workable approaches today:

* run Docker inside an **unprivileged** LXC container with nesting enabled, and use this guide
  unchanged;
* install natively in a Debian LXC: `pip install -c bridge/constraints.txt ./bridge`, build the UI
  with `SE7ENX_BUILD_TARGET=appliance npm run build`, and run `se7enx-bridge` from the systemd unit
  in `bridge/deploy/` with `SE7ENX_UI_DIR`, `SE7ENX_DATA_DIR` and `SE7ENX_ALLOWED_HOSTS=auto` set.

Neither approach has been tested yet. A maintained template is a planned next step.
