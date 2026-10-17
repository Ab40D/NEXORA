# Changelog

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
