# Security model

SE7ENX can switch real electrical loads. The design goal is that **nothing can
operate the KNX bus unless a person with access to the bridge console (or the
Home Assistant account) explicitly allowed this browser, for an explicitly
allowed group address, and the command passed every safety gate.**

> **Audit status (2026-10-15).** This model was reviewed in the
> [technical & security audit](../SECURITY_AUDIT.md). Statements below were corrected where the
> audit found them inaccurate. Open weaknesses are listed under
> [Known limitations](#known-limitations-from-the-audit). Where this page and the audit disagree,
> the audit's evidence wins.

## Components and trust boundaries

```
 Browser (untrusted network, user's device)
   │  HTTPS UI from Vercel (static + /api/health only; no KNX, no proxy)
   │
   ├─► SE7ENX Bridge (customer LAN)  ── Bearer session ── origin allowlist ── GA allowlist ──► KNXnet/IP interface ──► KNX bus
   │      (plain HTTP unless TLS/Tailscale/reverse proxy is set up)
   │
   ├─► Home Assistant (customer)     ── HA OAuth tokens (full rights of the HA user) ──► HA KNX integration ──► KNX bus
   │
   └─► Google odml.pa.googleapis.com ── MediaPipe usage telemetry (no images), sent by the hand-tracking library
```

## Threats and controls

| Threat | Control |
| --- | --- |
| A malicious website in another tab drives the bridge (CSRF / DNS rebinding / LAN scanning) | Bridge rejects any request whose `Origin` is not in `SE7ENX_ALLOWED_ORIGINS` (wildcards and `null` refused at startup). All state-changing endpoints need a Bearer token that only paired clients have; tokens are sent in a header, never cookies. Pairing itself requires a code printed on the bridge console. (The Origin check stops *browsers*; non-browser LAN clients still need a token or pairing code.) |
| Brute-forcing the pairing code | Random codes: 8 characters from a 32-symbol alphabet (40 bits), single use, rotate every 15 min, compared in constant time; 5 attempts/min per source address; 20 failures → pairing locked for 5 min **for everyone** and the code rotates. **Caveats:** the global lock lets anyone who can reach the bridge block pairing (DoS); with `SE7ENX_TRUST_PROXY=true` the "source address" comes from a client-controllable `X-Forwarded-For` header ([SE7-06](../SECURITY_AUDIT.md)); a fixed `SE7ENX_PAIRING_CODE` is only checked for format, not strength ([SE7-13](../SECURITY_AUDIT.md)). |
| Stolen session token | Random 32 bytes, stored only as SHA-256 on the bridge, expires (default 12 h), max 10 sessions; kept in the tab's `sessionStorage` only (never `localStorage`, never on Vercel). **Disconnect** revokes the token server-side (verified). **Caveats:** only the token holder can revoke it; there is no admin revocation except restarting the bridge ([SE7-04](../SECURITY_AUDIT.md)); over plain HTTP the token is visible on the LAN ([SE7-05](../SECURITY_AUDIT.md)). |
| Abuse of an authenticated session to hit other loads | **Default-deny** group-address policy (`SE7ENX_ALLOWED_GROUP_ADDRESSES`), enforced for writes *and* reads; only DPT 1.001 / 5.001 with validated values; per-session and global command rate limits; idempotent `requestId`s prevent duplicate sends on retries. **Caveat:** every paired session may use every allowlisted address and may disconnect the shared KNX link; there are no roles ([SE7-04](../SECURITY_AUDIT.md)). |
| Bridge used as a proxy into the private network | The browser cannot choose arbitrary hosts unless `SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG=true`; even then only IPv4 literals inside configured private CIDRs (default list includes link-local `169.254.0.0/16`, see [SE7-14](../SECURITY_AUDIT.md)), only on the KNXnet/IP protocol, only for authenticated sessions. The web app never proxies requests into LANs. The optional `SE7ENX_DEV_BRIDGE_REWRITE` is a build-time, operator-fixed, demo-only rewrite, off by default but **not technically blocked in production** ([SE7-10](../SECURITY_AUDIT.md)). |
| Exposing KNX to the internet | The Python package and systemd unit bind to `127.0.0.1` by default; **the Docker image binds `0.0.0.0` with host networking** ([SE7-15](../SECURITY_AUDIT.md)). Docs require LAN/tailnet access only (Tailscale, bridge TLS on LAN, Cloudflare Access) and **never port forwarding**. The KNX interface itself is never exposed. |
| Credential leakage to the frontend | KNX Secure keyrings/passwords live only in bridge env vars and are masked in `check-config`. The frontend has no secrets (`.env.example` contains none; no secrets found in git history or the client bundle). Home Assistant uses its own OAuth: the user signs in on their HA login page and SE7ENX never sees the password. **However**, the resulting HA access token (30 min) **and refresh token** (valid up to 90 days after last use) are stored in the tab's `sessionStorage`, readable by any script in the origin. They carry the HA user's full rights, since HA has no scopes. Revocation on Disconnect is best-effort ([SE7-01](../SECURITY_AUDIT.md)). Use a dedicated non-admin HA user. |
| Forged Home Assistant OAuth callback (login CSRF) | A random `state` nonce is stored in `sessionStorage` and must match the callback; callbacks older than 10 min are refused; code/state are removed from the URL immediately. |
| Untrusted input (URLs, group addresses) | URLs: scheme allowlist, no credentials/query/fragment, mixed-content and address-space checks. Group addresses: strict grammar (3-level/2-level/free), range checks, broadcast `0/0/0` refused, validated in the browser **and** again on the bridge (shared test vectors). Pydantic models with `extra="forbid"`, 16 KiB body limit. **Caveat:** on the Home Assistant path there is no server-side allowlist; any syntactically valid address can be written ([SE7-08](../SECURITY_AUDIT.md)). |
| Accidental operation | No automatic ON/OFF after connecting. The wizard's test command requires an explicit acknowledgement of the risk. Gestures need dwell + cooldown + re-arm + confidence gating; voice accepts only an exact allowlist (negations rejected). A visible **emergency stop** (header button, `Esc`) blocks all gesture and voice dispatch **in this browser** and ends listening; manual control stays available. **Caveat:** the stop is client-side only; the bridge has no kill switch or per-address switching interval ([SE7-07](../SECURITY_AUDIT.md)). |
| Overstated success | Real commands are only reported as confirmed when the backend proves it: positive `L_Data.con` (bridge) or an observed outgoing `knx_event` (HA admin). Negative / missing confirmations are errors. Device state is shown only from status telegrams or read responses; otherwise the lamp says `UNVERIFIED`. Simulation is labelled everywhere and never touches hardware. **Caveat:** after a read timeout or KNX reconnect the bridge can return a *cached* value as current, so "Device confirmed" may be stale ([SE7-02](../SECURITY_AUDIT.md)). |
| Clickjacking of the control UI | `frame-ancestors 'none'` + `X-Frame-Options: DENY` by default (`SE7ENX_FRAME_ANCESTORS` to opt in). |
| Camera / microphone privacy | Camera starts only after "Enable camera". Frames and landmarks are processed locally by self-hosted MediaPipe WASM and are never uploaded or recorded. **However, the MediaPipe Tasks Vision library sends usage telemetry** (SDK version, task type, latency statistics, together with the client's IP address, user agent and page origin) to Google's `odml.pa.googleapis.com` about every 60 s while tracking runs. No images, landmarks or audio are included. This was confirmed by network capture; there is no documented opt-out ([SE7-03](../SECURITY_AUDIT.md)). The microphone is only used during an explicit Listen press or a 60 s hands-free session; listening stops on emergency stop and when the tab is hidden. The UI states that browser speech services (Google/Apple) may process audio unless on-device recognition is enabled. |
| Supply chain | Web dependencies pinned to exact versions with a lockfile; production npm tree has 0 known vulnerabilities; the hand-landmark model is checksum-verified (SHA-256) at build time and self-hosted; no CDN scripts at runtime. **Caveats:** bridge Python dependencies use version ranges without a lock file ([SE7-16](../SECURITY_AUDIT.md)); a dev-only `braces` advisory is accepted ([SE7-17](../SECURITY_AUDIT.md)); the MediaPipe library's telemetry (above) was not vetted before inclusion. |

## HTTP security headers

Web app (`next.config.ts`): CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors`), with
two known weaknesses: `script-src` includes `'unsafe-inline'`, and `connect-src` allows any
http(s)/ws(s) host because bridge/HA endpoints are user-defined ([SE7-09](../SECURITY_AUDIT.md)).
Also `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (camera/microphone self
only), `Cross-Origin-Opener-Policy`. The app does **not** emit `Strict-Transport-Security`; HSTS must
come from the hosting platform.

Bridge: `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, HSTS when TLS is enabled.

## Known limitations (from the audit)

| ID | Severity | Summary |
| --- | --- | --- |
| SE7-01 | High | Full-scope HA access + refresh tokens in `sessionStorage`; admin account recommended in the wizard |
| SE7-02 | High | Stale cached state can be shown as "Device confirmed" |
| SE7-03 | Medium | MediaPipe usage telemetry to Google |
| SE7-04 | Medium | No roles; no admin session revocation; unthrottled shared-link disconnect |
| SE7-05 | Medium | Plain HTTP to the bridge by default |
| SE7-06 | Medium | `X-Forwarded-For` trusted from any peer with `SE7ENX_TRUST_PROXY=true`; global pairing lockout |
| SE7-07 | Medium | Emergency stop is client-side only |
| SE7-08 | Medium | No group-address allowlist on the Home Assistant path |
| SE7-09 | Medium | CSP `'unsafe-inline'`, broad `connect-src`, no HSTS from the app |
| SE7-10 | Medium | Demo rewrite not blocked in production builds |
| SE7-11 … SE7-26 | Low / Info | See the [findings register](../SECURITY_AUDIT.md#4-findings-register); deployment questions answered in [PRE_DEPLOYMENT_REVIEW.md](../PRE_DEPLOYMENT_REVIEW.md) |

## Deployment checklist

The full checklist, including hardware and Home Assistant validation plans, is in
[DEPLOYMENT_CHECKLIST.md](../DEPLOYMENT_CHECKLIST.md). Minimum:

- [ ] Web app served over HTTPS, with HSTS from the host.
- [ ] `SE7ENX_DEV_BRIDGE_REWRITE` not set in production.
- [ ] `SE7ENX_ALLOWED_ORIGINS` lists exactly your web app origin(s).
- [ ] `SE7ENX_ALLOWED_GROUP_ADDRESSES` lists only the light's switching + status addresses.
- [ ] Bridge reachable only from your LAN / tailnet over HTTPS (Tailscale Serve, mkcert certificate, or a reverse proxy with access control); no router port forwarding. Docker: override `SE7ENX_HOST`.
- [ ] Random pairing codes (leave `SE7ENX_PAIRING_CODE` unset).
- [ ] `SE7ENX_TRUST_PROXY` only behind a proxy that clients cannot bypass.
- [ ] Use a dedicated tunnelling slot / KNX Secure where available.
- [ ] Home Assistant: dedicated non-admin user for SE7ENX.
- [ ] Privacy notice discloses the MediaPipe telemetry and browser speech services.
- [ ] Review the bridge audit log (`se7enx.audit`): every configuration change and command is logged with client name and outcome (client names are not sanitised).

## Reporting

Please report vulnerabilities privately to the project maintainers rather than in public issues.
