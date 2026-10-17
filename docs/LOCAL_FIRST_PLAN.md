# SE7ENX: Local-First Audit & Implementation Plan

Status: **plan + progress record**. Audit date 2026-10-17, base commit `3c47836`. Facts below were
verified in the repository; anything not yet built is marked *planned*.

---

## 1. Audit of the existing project

### 1.1 What exists

| Area | Verified facts |
| --- | --- |
| **Frontend** | Next.js 16.4.1 / React 19.3.1 / TypeScript; R3F + drei 3D lamp; zustand store with a pure reducer for **one light** (`src/lib/state/light-machine.ts`); MediaPipe gestures; Web Speech voice; zod contracts. Entry: `src/app/page.tsx` → `app-shell.tsx`. Only server route: `GET /api/health` |
| **Backend** | `bridge/` Python package `se7enx_bridge` (FastAPI 0.143 + xknx 4.0.0), CLI `se7enx-bridge`. 16 routes under `/api/v1` (pairing, session, KNX link, per-session `lights`, SSE `events`). Sessions in memory. Configuration by environment variables only (35 `SE7ENX_*`) |
| **Home Assistant** | **Browser-side only**: OAuth redirect → tokens in `sessionStorage` (`src/lib/ha/oauth.ts:81`) → browser WebSocket to HA (`src/lib/adapters/ha-adapter.ts`). No server-side HA code. HA must be reachable over HTTPS from the browser |
| **Shelly** | **None.** No code, docs or tests mention Shelly (`grep -ri shelly` → no matches) |
| **KNX** | Real implementation through xknx in the bridge: tunnelling UDP/TCP/Secure and routing; positive/negative `L_Data.con`; GA allowlist from `SE7ENX_ALLOWED_GROUP_ADDRESSES` (default deny). Device model: **one switch GA + optional status GA**, DPT 1.001 or 5.001 (ON level). No relative dimming, blinds or sensors |
| **Simulation** | Browser `SimulationAdapter` (never touches hardware); protocol-level fake KNXnet/IP interface and mock HA server **for tests/demos only** |
| **Persistence** | None server-side. Browser `localStorage` holds non-secret preferences |
| **Deployment** | Vercel for the UI; bridge via venv, systemd unit, or Docker (bridge only, `network_mode: host`, `SE7ENX_HOST=0.0.0.0`). No container for the UI, no data volume, no release/upgrade process |
| **Tests** | Vitest 185 (unit + integration), pytest 98, Playwright 24 (+1 intentional skip), audit probes (`audit/`) |
| **Cloud / internet dependencies** | Vercel hosting (optional); MediaPipe usage telemetry to Google when the camera is used; browser speech services (Google/Apple) unless on-device; HA OAuth path needs HA reachable from the browser |
| **Known issues** | 26 findings in [SECURITY_AUDIT.md](../SECURITY_AUDIT.md); most relevant here: SE7-01 (HA tokens in browser storage), SE7-02 (stale state), SE7-04 (no roles), SE7-05 (plain HTTP), SE7-07 (client-only stop), SE7-08 (no HA allowlist), SE7-15 (Docker `0.0.0.0`), SE7-26 (no Host check) |

### 1.2 Implemented vs simulated vs incomplete

| Capability | Status |
| --- | --- |
| Simulation, 3D lamp, gestures, voice, wizard | Implemented (browser) |
| KNX single light via bridge | Implemented; verified against the **fake** interface only |
| HA via browser OAuth | Implemented; verified against a **mock** only; conflicts with "no tokens in browser storage" |
| Shelly | **Not implemented** |
| Multi-device model, device list, persistent configuration | **Not implemented** |
| Local installable appliance (UI + backend) | **Not implemented** (bridge-only container) |
| KNX dimming (relative), blinds, sensors | **Not implemented** |

### 1.3 Constraint discovered during the audit

Browsers allow the **camera and microphone only in a secure context**: HTTPS, or `http://localhost`.
A local appliance opened as `http://192.168.x.y:8787` can do manual and device control, but **not
gestures or voice**. HTTPS options (bridge TLS with a trusted certificate, Tailscale Serve, a local
reverse proxy) are documented rather than silently assumed.

---

## 2. Architecture decision

**Evolve the existing bridge into the local SE7ENX hub. Do not add a second backend or a second KNX
stack.**

```
Browser ──same origin──► SE7ENX container (one image, one port, non-root, read-only rootfs)
                           ├─ static UI (Next.js static export, built in the image)
                           ├─ /api/v1 (existing bridge API + new device API)
                           ├─ device registry ─┬─ KNX adapter      → existing KnxService (xknx)
                           │                   ├─ Shelly adapter   → device HTTP (Gen1) / RPC (Gen2+)
                           │                   ├─ HA adapter       → HA WebSocket API (token server-side)
                           │                   └─ simulated adapter (sample config, demos)
                           └─ /data volume: config.json (no secrets) + secrets.json (0600)
```

Reasons:
* Reuses the hardened bridge: pairing and sessions, Origin checks, rate limits, audit log, xknx.
* Same-origin UI: no CORS, no public demo origin trusted by default, and a public demo **cannot**
  drive a local hub.
* Home Assistant tokens move server-side: they are stored in `secrets.json` or provided via env/file,
  and never sent to the browser.
* One container keeps installation and upgrades simple. Node is needed only at image build time.

Security additions in the same stage:
* `Host` allowlist (fixes SE7-26) with same-origin acceptance only for allowed hosts.
* Hub-wide emergency stop (addresses SE7-07).
* Per-device "real control" switch, off by default, which needs an explicit acknowledgement.
* Per-device minimum command interval.
* Secrets excluded from API responses, logs and exports.

---

## 3. Staged plan

| Stage | Scope | Acceptance |
| --- | --- | --- |
| **1. Hub core** | Data dir + config/secrets store; unified device model; registry with policy (real-control flag, safety stop, rate limit, per-device interval); simulated adapter; device/integration/safety/export API; SSE device events; Host allowlist + same-origin; static UI serving | pytest for store, registry, API, host rules; existing 98 bridge tests still pass |
| **2. Shelly** | Gen1 HTTP + Gen2+ RPC client (digest SHA-256 / basic auth); identification; capability detection from status; switch, light, cover, power/energy, multi-channel; polling monitor; identify/add API | Tests against protocol-level fake Gen1/Gen2 devices built from the official docs |
| **3. Home Assistant (server-side)** | WebSocket client: auth, `get_states`, `subscribe_events`, `call_service`, ping, reconnect with back-off; status + last success; entity allowlist; confirmation via `state_changed`; token never leaves the server | Tests with a fake HA server: auth invalid, unreachable, reconnect, service errors, confirmation |
| **4. KNX mapping** | Device adapter on the existing `KnxService`: switch, light (absolute DPT 5.001 + relative DPT 3.007 + feedback), cover (1.008 up/down, stop, 5.001 position + feedback), sensors (9.xxx etc.) via xknx transcoders; only configured GAs are writable through the device API | Tests against the existing fake KNXnet/IP interface |
| **5. Appliance** | Static-export build target; multi-stage Dockerfile; `compose.yaml` (bridge network, no host networking by default; opt-in override for KNX routing/discovery); health check; `.env.example`; versioned tags; upgrade/rollback; backup/export; LXC notes | `docker build` + `docker compose up` + health + simulated devices + HA-unreachable behaviour tested |
| **6. UI** | Hub mode: devices panel (capability-driven controls, reported vs requested state, connection status), integration status, add Shelly/HA/KNX/simulated devices, real-control acknowledgement, hub emergency stop, use any hub device as the lamp target | Lint, typecheck, unit tests, production build, browser test against a hub with simulated devices |
| **7. Docs** | Install guide, configuration reference, troubleshooting, hardware test matrix (what needs real Shelly/KNX), update security docs | Links/anchors checked |

**Out of scope for this iteration (documented):** automatic network discovery (only opt-in later;
manual add by IP is the supported path), user roles and accounts, an LXC template (notes only), a
remote-access relay, and deduplication beyond configurable linking/hiding.

---

## 4. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Breaking the existing app or bridge | Additive API only (`apiVersion` stays 1; frontend schemas ignore unknown keys); the existing 98 + 185 tests must keep passing |
| Real hardware switched unexpectedly | Devices added with control **disabled**; enabling requires an explicit acknowledgement; hub safety stop; nothing writes to unconfigured KNX GAs |
| Secrets leaking | Separate `secrets.json` (0600), never serialised in API/log/export; tests assert absence in responses, logs, exports and the UI bundle |
| SSRF through "device IP" fields | Shelly hosts must resolve to private/link-local addresses; HA URL scheme restricted; no network scanning |
| Container privilege creep | Non-root, read-only rootfs, `cap_drop: ALL`, no Docker socket; host networking only via an opt-in override |
| Claims without hardware | Fakes are labelled as fakes; the hardware test matrix lists what still needs physical Shelly/KNX/HA validation |
