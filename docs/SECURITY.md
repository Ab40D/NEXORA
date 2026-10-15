# Security model

SE7ENX can switch real electrical loads. The design goal is that **nothing can
operate the KNX bus unless a person with access to the bridge console (or the
Home Assistant account) explicitly allowed this browser, for an explicitly
allowed group address, and the command passed every safety gate.**

## Components and trust boundaries

```
 Browser (untrusted network, user's device)
   │  HTTPS UI from Vercel (static + /api/health only — no KNX, no proxy)
   │
   ├─► SE7ENX Bridge (customer LAN)  ── Bearer session ── origin allowlist ── GA allowlist ──► KNXnet/IP interface ──► KNX bus
   │
   └─► Home Assistant (customer)     ── HA OAuth session (short-lived) ──► HA KNX integration ──► KNX bus
```

## Threats and controls

| Threat | Control |
| --- | --- |
| A malicious website in another tab drives the bridge (CSRF / DNS rebinding / LAN scanning) | Bridge rejects any request whose `Origin` is not in `SE7ENX_ALLOWED_ORIGINS` (wildcards refused at startup). All state-changing endpoints need a Bearer token that only paired clients have; tokens are sent in a header, never cookies. Pairing itself requires a code printed on the bridge console. |
| Brute-forcing the pairing code | 8 characters from a 32-symbol alphabet (40 bits), single use, rotates every 15 min, compared in constant time; 5 attempts/min per client; 20 failures → pairing locked for 5 min and the code rotates. |
| Stolen session token | Random 32 bytes, stored only as SHA-256 on the bridge, expires (default 12 h), revocable (`Disconnect`), max 10 sessions; kept in the tab's `sessionStorage` only (never `localStorage`, never on Vercel). |
| Abuse of an authenticated session to hit other loads | **Default-deny** group address policy (`SE7ENX_ALLOWED_GROUP_ADDRESSES`), enforced for writes *and* reads; only DPT 1.001 / 5.001 with validated values; per-session and global command rate limits; idempotent `requestId`s prevent duplicate sends on retries. |
| Bridge used as a proxy into the private network | The browser cannot choose arbitrary hosts unless `SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG=true`; even then only IPv4 literals inside configured private CIDRs, only on the KNXnet/IP protocol, only for authenticated sessions. The web app never proxies requests into LANs (the optional `SE7ENX_DEV_BRIDGE_REWRITE` is a build-time, operator-fixed, dev/demo-only rewrite — off by default). |
| Exposing KNX to the internet | Bridge binds to `127.0.0.1` by default; docs require LAN/tailnet access only (Tailscale, bridge TLS on LAN, Cloudflare Access) and **never port forwarding**. The KNX interface itself is never exposed. |
| Credential leakage to the frontend | KNX Secure keyrings/passwords live only in bridge env vars and are masked in `check-config`. The frontend has no secrets (`.env.example` contains none). Home Assistant uses its own OAuth: the user signs in on their HA login page; SE7ENX never sees the password and asks for no long-lived token; tokens are short-lived, tab-scoped and revoked on disconnect. |
| Forged Home Assistant OAuth callback (login CSRF) | A random `state` nonce is stored in `sessionStorage` and must match the callback; callbacks older than 10 min are refused; code/state are removed from the URL immediately. |
| Untrusted input (URLs, group addresses) | URLs: scheme allowlist, no credentials/query/fragment, mixed-content and address-space checks. Group addresses: strict grammar (3-level/2-level/free), range checks, broadcast `0/0/0` refused — validated in the browser **and** again on the bridge (shared test vectors). Pydantic models with `extra="forbid"`, 16 KiB body limit. |
| Accidental operation | No automatic ON/OFF after connecting. The wizard's test command requires an explicit acknowledgement of the risk. Gestures need dwell + cooldown + re-arm + confidence gating; voice accepts only an exact allowlist (negations rejected). A visible **emergency stop** (header button, `Esc`) blocks all gesture and voice dispatch and ends listening; manual control stays available. |
| Overstated success | Real commands are only reported as confirmed when the backend proves it: positive `L_Data.con` (bridge) or an observed outgoing `knx_event` (HA admin). Negative / missing confirmations are errors. Device state is shown only from status telegrams or read responses; otherwise the lamp says `UNVERIFIED`. Simulation is labelled everywhere and never touches hardware. |
| Clickjacking of the control UI | `frame-ancestors 'none'` + `X-Frame-Options: DENY` by default (`SE7ENX_FRAME_ANCESTORS` to opt in). |
| Camera / microphone privacy | Camera starts only after "Enable camera"; frames are processed locally by self-hosted MediaPipe WASM and never uploaded. The microphone is only used during an explicit Listen press or a 60 s hands-free session; listening stops on emergency stop and when the tab is hidden. The UI states that browser speech services (Google/Apple) may process audio unless on-device recognition is enabled. |
| Supply chain | Pinned dependency versions; the hand-landmark model is checksum-verified (SHA-256) and self-hosted; no CDN scripts at runtime. |

## HTTP security headers

Web app (`next.config.ts`): CSP (`default-src 'self'`, `connect-src` limited to
http(s)/ws(s) because bridge/HA endpoints are user-defined, `object-src 'none'`,
`frame-ancestors`), `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` (camera/microphone self only), `Cross-Origin-Opener-Policy`.

Bridge: `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, HSTS when TLS is enabled.

## Deployment checklist

- [ ] Web app served over HTTPS (Vercel does this).
- [ ] `SE7ENX_ALLOWED_ORIGINS` lists exactly your web app origin(s).
- [ ] `SE7ENX_ALLOWED_GROUP_ADDRESSES` lists only the light's switching + status addresses.
- [ ] Bridge reachable only from your LAN / tailnet; no router port forwarding.
- [ ] Prefer HTTPS to the bridge (Tailscale Serve, mkcert certificate, or a reverse proxy with access control).
- [ ] Random pairing codes (leave `SE7ENX_PAIRING_CODE` unset) unless you protect the env file.
- [ ] Use a dedicated tunnelling slot / KNX Secure where available.
- [ ] Review the bridge audit log (`se7enx.audit`) — every configuration change and command is logged with client name and outcome.

## Reporting

Please report vulnerabilities privately to the project maintainers rather than in public issues.
