# SE7ENX: Deployment & Validation Checklist

Use this checklist for every deployment. Tick items only after verifying them yourself. Items marked
**[GATE]** are blocking for the scenario named. Severity references (SE7-xx) point to
[SECURITY_AUDIT.md](SECURITY_AUDIT.md). Configuration names are the real ones from
`.env.example` and `bridge/.env.example`.

| Scenario (audit §7) | Current decision |
| --- | --- |
| Local developer demo | Ready |
| Controlled test with your own hardware | Ready with restrictions (§2, §3) |
| Public Vercel frontend-only demo | Ready with restrictions (§1) |
| Real users connecting their own Home Assistant | **Not ready** (§6) |
| Production with physical devices | **Not ready** (§6) |

---

## 1. Web app (Vercel or any static host)

### Before deploying
- [ ] `npm ci && npm run check` passes (lint, typecheck, unit/integration tests, build).
- [ ] `npm run test:e2e` passes (after `npx playwright install chromium`).
- [ ] **[GATE: public demo]** `SE7ENX_DEV_BRIDGE_REWRITE` is **not set** in the project's environment variables (SE7-10).
- [ ] No environment variable contains a secret (the web app needs none). Only these exist:
      `NEXT_PUBLIC_DEFAULT_BRIDGE_URL`, `NEXT_PUBLIC_HAND_MODEL_URL`, `NEXT_PUBLIC_MEDIAPIPE_WASM_BASE`,
      `SE7ENX_FRAME_ANCESTORS`, `SE7ENX_ALLOWED_DEV_ORIGINS` (dev only), `SE7ENX_DEV_BRIDGE_REWRITE` (demo only).
- [ ] `SE7ENX_FRAME_ANCESTORS` left unset (= `'none'`) unless embedding is required.
- [ ] **[GATE: public demo]** A privacy notice is published that discloses the MediaPipe usage
      telemetry to Google (SE7-03), browser speech services, and the browser storage listed in
      [TECHNICAL_SPECIFICATION.md §7](TECHNICAL_SPECIFICATION.md#7-privacy--security), **or** the telemetry is blocked.
- [ ] Home Assistant and bridge paths are labelled experimental in any public announcement.

### After deploying
- [ ] `https://<app>/api/health` returns `"ok": true` and `"knx": {"handledHere": false}`.
- [ ] Response headers (`curl -sI https://<app>/`) include `Content-Security-Policy` with
      `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
      `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- [ ] `Strict-Transport-Security` is present. The app does not set it itself (SE7-09), so it must come
      from the host; check both the platform domain and any custom domain (not verified by the audit).
- [ ] `https://<app>/demo-bridge/api/v1/health` returns **404** (no demo rewrite active).
- [ ] The app opens in **Simulation**; camera and microphone are requested only after clicking
      **Enable camera** / **Enable voice commands**.
- [ ] Optional: `AUDIT_BASE_URL=https://<app> node audit/network-egress.mjs` and review every off-origin request.

---

## 2. SE7ENX Bridge host

### Installation
- [ ] Host is on the **same LAN** as the KNX IP interface, with a fixed IP or DHCP reservation.
- [ ] Installed from the repository (`pip install .` in a venv, the systemd unit
      `bridge/deploy/se7enx-bridge.service`, or `docker compose` in `bridge/`).
- [ ] `se7enx-bridge check-config` prints the expected configuration (secrets masked).
- [ ] `se7enx-bridge scan` finds the interface (if multicast is allowed on the network).

### Configuration (`bridge/.env.example`)
- [ ] `SE7ENX_ALLOWED_ORIGINS` lists **exactly** the web app origin(s), e.g. `https://se7enx.example.com`.
- [ ] **[GATE: hardware test]** `SE7ENX_ALLOWED_GROUP_ADDRESSES` lists **only** the test light's switching and status addresses.
- [ ] `SE7ENX_PAIRING_CODE` **unset** (random, single-use, rotating codes). If a fixed code is
      unavoidable: ≥ 16 random characters, env file readable by the service user only (SE7-13).
- [ ] `SE7ENX_KNX_CONNECTION_TYPE` and `SE7ENX_KNX_GATEWAY_IP` set explicitly (avoid `automatic` in production).
- [ ] KNX Secure: `SE7ENX_KNX_KEYRING_PATH` / `SE7ENX_KNX_KEYRING_PASSWORD` (or user ID/passwords)
      stored with restrictive permissions; never committed.
- [ ] `SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG=false` (default). If enabled, narrow `SE7ENX_CLIENT_GATEWAY_CIDRS`
      to the interface's subnet and drop `169.254.0.0/16` (SE7-14).
- [ ] `SE7ENX_ENABLE_DOCS=false` (default).
- [ ] `SE7ENX_TRUST_PROXY=true` **only** when the bridge sits behind a reverse proxy **and** cannot be reached
      directly (bind to `127.0.0.1`). Even then, rate-limit identities can be spoofed through the left-most
      `X-Forwarded-For` entry until SE7-06 is fixed. Otherwise leave it `false`.
- [ ] Rate limits reviewed: `SE7ENX_COMMAND_LIMIT` / `SE7ENX_COMMAND_WINDOW_S` (default 6 per 10 s),
      `SE7ENX_GLOBAL_COMMAND_LIMIT` (default 20 per 10 s).
- [ ] `SE7ENX_SESSION_TTL_HOURS` as short as practical (default 12).

### Network exposure
- [ ] **[GATE: hardware test]** Browsers reach the bridge over **HTTPS** (Tailscale Serve, mkcert certificate via
      `SE7ENX_TLS_CERT`/`SE7ENX_TLS_KEY`, or a reverse proxy) or over `http://127.0.0.1` on the same computer.
      **No plain `http://<LAN-IP>` across shared Wi-Fi** (SE7-05).
- [ ] **Docker:** the image sets `SE7ENX_HOST=0.0.0.0` with host networking. Override it to `127.0.0.1`
      (behind Tailscale/proxy) or firewall the port to trusted clients only (SE7-15).
- [ ] **No router port forwarding** to the bridge or to the KNX interface. Verify from outside the LAN that the
      port is closed.
- [ ] The KNX interface/router is not reachable from the internet or guest networks.

### Logs
- [ ] Logs (stdout/journald/docker) are readable only by administrators: they contain pairing codes and the audit trail.
- [ ] Audit log (`se7enx.audit`) entries appear for configuration changes and commands. Note that client names
      are not sanitised, so do not trust them blindly (SE7-12).

---

## 3. KNX commissioning & hardware validation (to be executed; not yet done)

Record date, firmware versions and results for each item. **Never test on loads where unexpected
switching could cause harm.**

| # | Test | Expected result | Result |
| --- | --- | --- | --- |
| H1 | Pair, *Test link* | All checks green; **no telegram written** during the test (verify with the ETS bus monitor) | |
| H2 | **Send test ON/OFF** with UDP tunnelling | Light switches; history shows **bus confirmed**; ETS monitor shows exactly one GroupValueWrite per command | |
| H3 | Status feedback | Lamp shows "Device confirmed" within ~1 s; matches the real light | |
| H4 | Read flag | **Read current state (GroupValueRead)** returns the real state | |
| H5 | Wall switch / ETS toggles the light while connected | Lamp follows via status telegram | |
| H6 | Bus power removed from the interface | Command → `KNX_NEGATIVE_CONFIRMATION` or `KNX_CONFIRMATION_TIMEOUT`; **never success** | |
| H7 | Interface unplugged from the network, then restored | `RECONNECTING`, then reconnects; check whether the shown state is correct (known issue SE7-02) | |
| H8 | Light switched at the wall **while the link is down**, then link restored | Expected today: possible stale "Device confirmed" (SE7-02). Record the behaviour | |
| H9 | Actuator without status object | `UNVERIFIED` shown, never "Device confirmed" | |
| H10 | Group address **not** in the allowlist | `GA_NOT_ALLOWED`; ETS monitor shows nothing | |
| H11 | Rapid commands (button mashing) | 429 after the configured limit; no telegram storm | |
| H12 | Emergency stop (**Stop hands-free** / `Esc`) during gesture/voice use | No further hands-free telegrams from this browser | |
| H13 | Tunnel slots: start ETS/HA tunnels alongside the bridge | Bridge reports a clear error when no slot is free; other systems unaffected | |
| H14 | Bridge restart | Browsers must pair again; no automatic ON/OFF on reconnect | |
| H15 | TCP tunnelling (`tunneling_tcp`) | As H2–H6 | |
| H16 | KNX Secure tunnelling (`tunneling_tcp_secure`) | As H2–H6; secrets never in logs or `check-config` output | |
| H17 | Routing (`routing`) | Commands reported as **accepted** (never bus confirmed); feedback via status address | |
| H18 | DPT 5.001 dimming actuator | ON sends the configured level; OFF sends 0 | |

---

## 4. Home Assistant validation (to be executed; not yet done)

| # | Test | Expected result | Result |
| --- | --- | --- | --- |
| A1 | **Sign in with Home Assistant** against a real HA over HTTPS | HA login page shown; redirect back accepted; *Test link* checks green | |
| A2 | Tampered/expired callback (reload an old callback URL) | Refused; sign-in must restart | |
| A3 | Non-admin user | Commands **accepted**; no bus confirmation; state via `knx.read` (if HA supports it) | |
| A4 | Admin user | Bus confirmation via outgoing `knx_event`; live status updates | |
| A5 | **Disconnect** with HA reachable | HA profile → Security → Refresh tokens: SE7ENX entry removed | |
| A6 | **Disconnect** with HA unreachable | Token remains in HA (expected today, SE7-01); delete it manually | |
| A7 | Group address typo | Confirm the risk described in SE7-08 on a harmless address | |
| A8 | HA restart during control | `RECONNECTING`, then recovery; no automatic ON/OFF | |

---

## 5. Browsers and devices (to be executed; Chromium only so far)

| Feature | Chrome/Edge desktop | Android Chrome | iOS Safari | macOS Safari | Firefox |
| --- | --- | --- | --- | --- | --- |
| Simulation + manual control | ✅ (automated) | ✅ (emulated) | ☐ | ☐ | ☐ |
| Gestures with a real camera and hand | ☐ | ☐ | ☐ | ☐ | ☐ |
| Voice with the real speech service | ☐ | ☐ | ☐ | ☐ | n/a |
| Bridge over HTTPS | ☐ | ☐ | ☐ | ☐ | ☐ |
| Local network access prompt (`http://<LAN-IP>`) | ☐ | ☐ | n/a (blocked) | n/a (blocked) | n/a |
| Reduced motion / keyboard / screen reader | ☐ | ☐ | ☐ | ☐ | ☐ |

---

## 6. Gates before real users or production (from the audit; all proposed work)

**Real users connecting their own Home Assistant: all required**
- [ ] SE7-01: HA tokens no longer persisted in browser storage; non-admin guidance in the UI.
- [ ] SE7-08: group address confirmation in the UI, or an agent-side allowlist.
- [ ] SE7-09: nonce-based CSP and HSTS.
- [ ] SE7-03: MediaPipe telemetry blocked or disclosed in the UI.
- [ ] §4 executed against a real HA, with results recorded.
- [ ] Account design (if accounts are introduced) follows the
      [target architecture](docs/ARCHITECTURE.md#target-architecture-proposed--not-implemented): no HA tokens or KNX secrets in the cloud.
- [ ] Privacy policy, terms, incident-response contact, external penetration test.

**Production with physical devices: all of the above, plus**
- [ ] SE7-02: stale-state semantics fixed and re-tested (H7, H8).
- [ ] SE7-04: roles, admin session list/revoke, throttled disconnect.
- [ ] SE7-05: HTTPS by default for the bridge.
- [ ] SE7-07: bridge-side emergency stop and per-address switching interval.
- [ ] SE7-06, SE7-11 to SE7-16 addressed or explicitly accepted.
- [ ] §3 fully executed on representative hardware, including KNX Secure if used.
- [ ] Monitoring/alerting for bridge availability and failed commands; an update process for installed bridges.

---

## 7. Operations quick reference

| Situation | Action today |
| --- | --- |
| Suspected unauthorised client | **Restart the bridge**: all sessions are dropped (there is no per-session admin revoke yet) |
| Pairing code leaked | Leave `SE7ENX_PAIRING_CODE` unset (random codes rotate every 15 min), or change the fixed code and restart |
| Stop all remote/app control immediately | Stop the bridge service (`systemctl stop se7enx-bridge` / `docker compose down`); wall switches keep working |
| HA token exposure suspected | HA profile → Security → Refresh tokens → delete the SE7ENX entry; change the HA user's password |
| Repeated `PAIRING_LOCKED` | Someone may be guessing codes: check logs for source addresses; restrict network access to the bridge |

---

## 8. Sign-off

| Role | Name | Date | Scope approved |
| --- | --- | --- | --- |
| Installer | | | |
| Operator / owner | | | |
| Security reviewer | | | |
