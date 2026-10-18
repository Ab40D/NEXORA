# Changelog

## Unreleased

### Added: SE7ENX Core foundation (M1 of the Building OS roadmap)
- **Accounts:**
  - The owner account is created on first run with the console setup code.
  - Sign-in by username or e-mail; *keep me signed in* (30 days).
  - Profile, preferences (language follows the account; assistant personality), password change, list and revoke
    signed-in devices.
  - Single-use reset codes, issued by an administrator or by the host CLI: `se7enx-bridge reset-password`.
  - Invitations and self-registration (off by default).
- **Roles and permissions:**
  - Five roles: owner, administrator, engineer, technician, user.
  - A permission catalogue enforced by the hub on every API route.
  - A configurable matrix with guardrails, and rank-based user management.
- **Building model:** sites, buildings, floors, rooms and zones; device placement; templates (apartment, house, office)
  imported atomically; stored in `config.json`, schema v2 (v1 files upgrade in place).
- **Audit ledger:** who did what, through which interface (app, voice, gesture, assistant, console) and the real outcome.
  Secrets are never stored. Retention is set with `SE7ENX_AUDIT_RETENTION_DAYS`. Shown in the **Activity** tab.
- **UI:**
  - Appliance: onboarding and sign-in gate.
  - Guest mode (simulation only, remembered, never nagged).
  - Account menu; **Building**, **Activity** and **Settings** tabs (users, invitations, roles matrix).
  - All in English, French, Arabic and Algerian Darija.
- **Docs:** research and decision record, roadmap, innovation backlog, engineering log; `docs/API.md` (Core API);
  deployment and user guides.

### Security
- Passwords: Argon2id (m=19 MiB, t=2, p=1); NIST SP 800-63B-4 rules (min 15, no composition rules, blocklist).
- Sessions persist in SQLite and only their hashes are stored.
  - Same-origin UI: HttpOnly, SameSite=Strict cookie, with a CSRF check on the `Origin` header.
  - Allowed cross-origin apps: bearer tokens.
- Brute force: progressive lockout per login name, existing or not. The per-IP limit counts **failed** sign-ins only.
- Once accounts exist, pairing is disabled. SE7-04 (no roles) is mitigated; see `SECURITY_AUDIT.md`.

### Fixed
- **Dev stack showed the wrong address.** `bridge/tools/dev_stack.py` printed only the internal fake
  KNX interface (`127.0.0.1:<random UDP port>`), never the bridge URL. Entering that address in the
  app failed with "Cannot reach the SE7ENX Bridge". The dev stack now prints a banner once the
  bridge is listening: Bridge URL, pairing code, allowed origins and the simulated light. The fake
  interface is marked *internal, not the bridge URL*. If the port is taken, it says so and
  suggests `--port`. Regression tests: `bridge/tests/test_dev_stack.py`.
- **"Cannot reach the SE7ENX Bridge" hint.** It now names the usual causes: not the bridge's own
  URL (default port 8787; not the KNX interface's 3671); the origin not allowed, recognisable by the
  bridge's `Rejected request from origin '…'` log line; or, with the Docker appliance, opening
  its own address instead. The browser cannot tell these causes apart. The bridge's
  `Cross-Origin-Resource-Policy: same-origin` header also blocks `no-cors` probes, so the hint lists
  both rather than guessing.
- The bridge URL field warns when port **3671** (KNXnet/IP) is entered.
- One ESLint error in `tests/e2e/fixtures.ts` (Playwright's `use` callback flagged as a React
  hook).

## 1.1.0 (2026-10-17): local-first hub

### Added
- **Local appliance**: `Dockerfile` (one image: static web UI + hub), `deploy/appliance/compose.yaml`,
  `.env.example`, opt-in host-network override for KNX routing/discovery, health check, persistent
  `/data` volume, pinned runtime dependencies (`bridge/constraints.txt`).
- **Unified device layer** in the hub: device model with capabilities, reported vs requested state,
  persistent configuration (`config.json`) with credentials kept separately (`secrets.json`, 0600),
  credential-free export, simulated sample devices.
- **Shelly** by local IP: Gen1 HTTP API and Gen2+ RPC (Plus/Pro/Gen3/Gen4), digest/basic auth,
  identification, capability detection from the device, relays, dimmers (absolute + relative),
  covers (positioning only when calibrated), power/energy, multi-channel, status polling.
- **Home Assistant (server-side)**: WebSocket client in the hub with reconnect, entity allowlist,
  confirmation via `state_changed`; the access token never reaches the browser.
- **KNX device mapping** on the existing xknx connection: switch, light (5.001 absolute, 3.007
  relative), cover (1.008, stop, 5.001 position with inversion), sensors; only configured addresses
  are written.
- **Safety**: per-device "real control" switch (off by default, explicit acknowledgement), hub-wide
  emergency stop, per-device minimum command interval, one command in flight per device.
- **Network policy**: optional `Host` allowlist (`SE7ENX_ALLOWED_HOSTS`, `auto`) with same-origin
  acceptance; `SE7ENX_ALLOWED_ORIGINS=none`; device hosts restricted to local addresses.
- **UI**: Devices tab (pairing in the appliance, integration status, capability-driven controls,
  add Shelly / Home Assistant / KNX / simulated devices, export).
- Docs: `docs/LOCAL_DEPLOYMENT.md`, `docs/HARDWARE_TEST_MATRIX.md`, `docs/LOCAL_FIRST_PLAN.md`,
  device API in `docs/API.md`.

### Changed
- Browser-side Home Assistant OAuth tokens are kept in memory only (no `sessionStorage`); the
  wizard no longer recommends an HA administrator account. In the appliance the browser-side HA mode
  is replaced by the server-side integration.
- The appliance UI uses `connect-src 'self'`, which also blocks the MediaPipe usage telemetry.
- Bridge runtime dependencies now declare `httpx2` and `websockets` explicitly.

### Fixed
- Actuator status feedback that arrived before the command's HTTP response was treated as stale
  ("No status feedback"). Reproduced on 1.0 as well; fixed with a regression test.

### Not verified
- Physical Shelly devices, real Home Assistant installations and real KNX hardware (see
  `docs/HARDWARE_TEST_MATRIX.md`); ARM64 builds; Proxmox LXC (not provided yet).

## 1.0.0 (2026-10-15)
- SE7ENX Smart Light Experience: simulation, 3D lamp, gestures, voice, KNX bridge (xknx), browser
  Home Assistant path, Vercel deployment, audits and documentation.
