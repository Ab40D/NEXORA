# SE7ENX: Technical & Security Audit

| | |
| --- | --- |
| **System** | SE7ENX Smart Light Experience: Next.js web app + SE7ENX Bridge (Python/xknx) + optional Home Assistant path |
| **Commit audited** | `f51c06c` (branch `main`); audit tooling added afterwards under [`audit/`](audit/) |
| **Date** | 2026-10-15 |
| **Type** | Evidence-based white-box review: static code/config review + dynamic probes against a local production build, the real bridge code and a protocol-level fake KNXnet/IP interface |
| **Not covered** | Real KNX hardware, a real Home Assistant instance, Vercel itself, Safari/Firefox, real speech services, formal penetration test, fuzzing |
| **Revision** | 2026-10-16: SE7-24 to SE7-26 added and the SE7-09 HSTS note updated, following the [pre-deployment review](PRE_DEPLOYMENT_REVIEW.md) |
| **Companion docs** | [PRE_DEPLOYMENT_REVIEW.md](PRE_DEPLOYMENT_REVIEW.md) (can I deploy and share?) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (current + proposed architecture) · [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) · [USER_GUIDE.md](USER_GUIDE.md) · [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) · [docs/SECURITY.md](docs/SECURITY.md) |

> **How to read this document.** Every finding states its **evidence** (file:line, probe ID
> or captured output). **Facts** are things observed in code or at runtime. **Assumptions** are
> labelled as such. **Proposals** (fixes, new options, the target architecture) are clearly marked
> *proposed* and are **not implemented**. Application code was not changed by this audit; only
> documentation was corrected and audit tooling was added.

---

## 1. Executive summary

**What SE7ENX is today (fact).** A browser app that controls one KNX light at a time, in simulation
or for real through either (a) the self-hosted **SE7ENX Bridge** on the customer LAN (pairing
code → Bearer session → group-address allowlist → xknx → KNXnet/IP interface) or (b) the user's own
**Home Assistant** (HA OAuth sign-in → WebSocket → `knx.send`/`knx.read`). There are **no user
accounts, no database and no server-side token storage**; Vercel serves the UI and `GET /api/health`
only. The browser talks directly to the bridge or to HA.

**Can real users connect their Home Assistant today?** **No, not for real users at scale.**
There is no account system at all, and the HA path has only been exercised against a mock HA server.
It also stores full-scope HA tokens in browser storage (SE7-01) and has no server-side restriction on
which group addresses can be written (SE7-08). A technically skilled owner can try it on their own
installation under the restrictions in §7.

**Top risks**

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| SE7-01 | HA access **and refresh** tokens (full account rights, refresh valid up to 90 days) stored in JS-readable `sessionStorage`; the wizard recommends an HA **administrator**; CSP allows inline scripts | **High** | Confirmed (code + HA source) |
| SE7-02 | ⚡ Stale cached device state returned as current after a read timeout or reconnect, so the UI can show **"Device confirmed"** for a state that is no longer true | **High** | Confirmed (probes P08, P09) |
| SE7-03 | MediaPipe Tasks Vision sends **usage telemetry to Google** (`odml.pa.googleapis.com`), contradicting the "100 % on-device" claim | **Medium** | Confirmed (runtime egress capture) |
| SE7-04 | Bridge has **no roles**: any paired client can control every allowlisted address, disconnect the shared KNX link (unthrottled), and cannot be revoked by anyone else | **Medium** | Confirmed (P04, P05) |
| SE7-05 | Default bridge transport is **plain HTTP**: Bearer token and pairing code are visible on the LAN; the wizard gives no confidentiality warning | **Medium** | Confirmed (config) |
| SE7-07 | ⚡ Emergency stop is **client-side only**; no bridge kill switch, no per-address switching interval (6 toggles in < 0.1 s observed) | **Medium** | Confirmed (P10) |

**What is solid (verified).** Every sensitive bridge endpoint requires a session (P01). Foreign
origins are rejected (P02), and sessions cannot see each other's light registrations (P03). Group
addresses are default-deny on the bridge, for writes and reads alike (P17, tests). Tokens are random
256-bit values stored hashed, and Disconnect revokes them server-side (storage probe: 200 → 401).
Requests are strictly validated (extra fields rejected, 16 KiB body limit: P11). Negative or missing
KNX confirmations are reported as errors, never as success. There are no XSS sinks and no secrets in
the git history or the client bundle. The production npm tree has 0 known vulnerabilities, and
`pip-audit` on the bridge is clean.

---

## 2. Scope, method and evidence types

### 2.1 What was examined

* **Web app**: all of `src/` (state machine, policy, dispatcher, adapters, OAuth, URL validation,
  gesture/voice pipelines, UI), `next.config.ts`, `scripts/prepare-assets.mjs`, the production build output.
* **Bridge**: `bridge/se7enx_bridge/*` (config, security, API, KNX service), Dockerfile, compose file,
  systemd unit, `.env.example`.
* **Home Assistant**: the upstream HA source for auth (`homeassistant/auth/__init__.py`, `const.py`)
  and the KNX integration's services/WebSocket API, to establish token lifetimes and permission model.
* **Docs**: README, implementation report, API, architecture and security docs (claims vs. code).
* **Supply chain**: npm/pip dependency audits, git history, client bundle, the MediaPipe bundle.

### 2.2 Evidence types used

| Code | Meaning |
| --- | --- |
| **Code** | Read in source; cited as `path:line` at commit `f51c06c` |
| **Probe Pxx** | Dynamic probe in [`audit/bridge_probes.py`](audit/bridge_probes.py) against the real bridge code + fake KNXnet/IP interface; raw output in [`audit/results/bridge_probes.txt`](audit/results/bridge_probes.txt) |
| **Egress** | [`audit/network-egress.mjs`](audit/network-egress.mjs): Chromium + fake camera against the production build, records/aborts every off-origin request; output in [`audit/results/network_egress.txt`](audit/results/network_egress.txt) |
| **Storage** | [`audit/storage-and-revocation.mjs`](audit/storage-and-revocation.mjs): pairs a real browser with the bridge, dumps storage, verifies server-side revocation; output in [`audit/results/storage_and_revocation.txt`](audit/results/storage_and_revocation.txt) |
| **Headers** | `curl -sI` against `next start` (port 3100) and the bridge dev stack |
| **Tooling** | `npm audit`, `pip-audit`, `detect-secrets`, `git log -p` pattern search, bundle grep |

### 2.3 Severity method

Severity follows the **OWASP Risk Rating Methodology**: *Likelihood* (L) × *Impact* (I), each
Low / Medium / High.

| | Impact Low | Impact Medium | Impact High |
| --- | --- | --- | --- |
| **Likelihood High** | Medium | High | Critical |
| **Likelihood Medium** | Low | Medium | High |
| **Likelihood Low** | Info | Low | Medium |

**Smart-building safety modifier ⚡:** if a weakness can cause *unintended physical actuation* or a
*false belief about the physical state of a device*, its impact is raised one level (max High).

**Mapping.** Each finding is mapped to the **OWASP Top 10:2025** category (A01 Broken Access Control
· A02 Security Misconfiguration · A03 Software Supply Chain Failures · A04 Cryptographic Failures ·
A05 Injection · A06 Insecure Design · A07 Authentication Failures · A08 Software or Data Integrity
Failures · A09 Security Logging and Alerting Failures · A10 Mishandling of Exceptional Conditions)
and to the relevant **OWASP ASVS 5.0** chapter (V1–V17, chapter level only).

### 2.4 Status values

**Confirmed**: reproduced at runtime or unambiguous in code. **Suspected**: plausible from code,
not reproduced. **Unverified**: could not be tested here. **Fixed (docs)**: corrected by this
change set. **Accepted risk**: documented, no action proposed.

### 2.5 What "verified" means in this report

| Level | Result | Notes |
| --- | --- | --- |
| **Build passes** | ✅ Yes | `npm run build` (default env) succeeded; bridge packaging `pip install .` succeeded earlier in the project |
| **Automated tests pass** | ✅ Yes | ESLint 0 errors · `tsc` 0 errors · Vitest **185/185** (10 files) · pytest **98/98** · ruff check + format clean · Playwright **24 passed, 1 skipped** (intentional mobile-keyboard skip) |
| **Security review** | ✅ Done | This document: static review + 17 bridge probes + egress, storage and header captures |
| **Hardware verification** | ❌ Not done | No KNX interface, actuator, KNX Secure or routing setup available |
| **Real Home Assistant** | ❌ Not done | Only a mock HA WebSocket server was used |
| **Production platform** | ❌ Not done | No Vercel deployment, no Safari/Firefox, no real speech services, no real camera with a real hand |

Passing tests prove the code does what the tests assert, *not* that it is secure or that it works
on real hardware.

---

## 3. Architecture summary (verified)

Full diagrams, command trace, data-storage map and dependency map: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

| Component | Where it runs | Holds | Trust |
| --- | --- | --- | --- |
| Web app (Next.js 16.4.1, React 19) | Vercel / any static host + the user's browser | No secrets server-side. Browser: bridge token (`sessionStorage`), HA tokens (`sessionStorage`), settings (`localStorage`) | User-controlled device |
| `/api/health` | Vercel function | Nothing | Public |
| SE7ENX Bridge (FastAPI 0.143, xknx 4.0.0) | Customer LAN (PC/Pi/NAS/Docker) | Hashed sessions in memory; KNX Secure secrets in env; GA allowlist | Operator-controlled |
| Home Assistant (user's) | Customer | HA user accounts, KNX integration | Third party (user-owned) |
| KNX IP interface/router → TP bus | Customer LAN | Physical control | Must never be internet-exposed |
| Google `odml.pa.googleapis.com` | Internet | Receives MediaPipe usage telemetry (SE7-03) | **Undisclosed third party** |

**Command lifecycle (bridge path, traced):** UI → `requestCommand` (`store.ts:44`) →
`dispatchCommand` (`dispatcher.ts:53`) → policy gates (`policy.ts:32–46`) → `COMMAND_REQUESTED`
(`dispatcher.ts:69`) → adapter `send` with 10 s timeout (`dispatcher.ts:78`) →
`POST /api/v1/lights/{id}/on|off` with Bearer token (`client.ts:121–132, 223`) → bridge middleware:
Origin + body checks (`api.py:135–221`) → `require_session` (`api.py:374`) → idempotency, per-session
and global rate limits, GA allowlist (`api.py:633–636`) → `GroupValueWrite` (`knx.py:470–472`) →
`L_Data.con` evaluation (`knx.py:434–468`) → audit log (`api.py:679`) → response →
`COMMAND_SETTLED` (`dispatcher.ts:79`). Feedback: actuator status telegram → `_on_telegram`
(`knx.py:394–416`) → SSE `light.state` (`api.py:703`) → adapter (`bridge-adapter.ts:74–84`) →
`selectLampView` (`selectors.ts:120`) → lamp.

---

## 4. Findings register

L = likelihood, I = impact, ⚡ = safety modifier applied. Columns: ID · Severity · Status ·
Component · Evidence · Attack / failure scenario · User impact · Proposed remediation · Verification
of the fix · OWASP Top 10:2025 / ASVS 5.0.

| ID | Severity | Status | Component | Evidence | Attack / failure scenario | User impact | Proposed remediation | Verification of the fix | OWASP / ASVS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **SE7-01** | **High** (L:M × I:H) | Confirmed (code + HA source); not run against a real HA | Web app, HA mode | `src/lib/ha/oauth.ts:81` saves HA access + refresh tokens to `sessionStorage`; HA refresh tokens expire 90 days after last use and carry the user's full rights (HA has no per-entity scopes); wizard recommends an admin (`connection-wizard.tsx:949`, `ha-adapter.ts:263`); `script-src 'unsafe-inline'` (`next.config.ts:21`); revoke is best-effort (`oauth.ts:134`) | Any script in the SE7ENX origin (compromised dependency, injected inline script, extension with page access) or a person at an unlocked shared browser reads the refresh token and keeps control of the HA instance for months | With an admin account: everything in the home that HA controls (locks, alarms, cameras, every KNX address, HA configuration) | Keep HA tokens in memory only (no persistence; re-auth on reload); recommend a dedicated **non-admin** HA user and remove the admin recommendation; revoke on tab close; long term: HA-side agent holding the credential with an entity/GA allowlist (docs/ARCHITECTURE.md §Target) | After sign-in `sessionStorage` has no `se7enx.ha.tokens`; HA profile → refresh tokens shows none left after Disconnect | A07, A01 · V10 OAuth and OIDC, V14 Data Protection, V8 |
| **SE7-02** | **High** ⚡ (L:M × I:M→H) | Confirmed (P08, P09) | Bridge state cache + web adapter | `bridge/se7enx_bridge/api.py:620–627` returns the cached value when a refresh read gets no answer, without any staleness flag; `knx.py:372–379` (`_teardown`) never clears `values`; `src/lib/adapters/bridge-adapter.ts:101` stamps reports with the browser clock; UI then shows "Device confirmed" (`selectors.ts:120`) | KNX link drops (or actuator has no read flag); someone switches the light at the wall; after reconnect the read times out and the old `on` is returned as current; P08: device OFF, bridge answered `value=on via=status_address` | False belief about a physical device's state (e.g. "socket is off" when it is on); violates the requirement never to show confirmed state that is not confirmed | Return `stale: true` + server `observedAt` (or `value: null`) when a read times out; clear `values` in `_teardown`; adapter uses the server timestamp and shows `UNVERIFIED`/`STALE` | Re-run P08/P09 → stale flag present, cache empty after reconnect; add pytest regression | A10, A06 · V2 Validation and Business Logic, V16 |
| **SE7-03** | **Medium** (L:H × I:L) | Confirmed (egress capture + bundle analysis) | Web app gesture runtime (`@mediapipe/tasks-vision` 1.1.1) | [`network_egress.txt`](audit/results/network_egress.txt): exactly one off-origin request, `POST https://odml.pa.googleapis.com/v1/log` about 60 s after the camera started; 90-byte body with SDK version `1.1.1`; headers include `origin`, `referer`, `user-agent`, `x-goog-api-key`. The logger is created unconditionally in `vision_bundle.mjs`; CSP `connect-src … https:` (`next.config.ts:26`) allows it | Every visitor who keeps the camera on ≥ 60 s (or stops it) sends usage metadata and their IP address to Google without notice | Privacy/transparency breach (an EU privacy-notice issue); **no images, landmarks or audio are sent** | Disclose (docs fixed in this change set; UI still needs a notice); block with a scoped guard on `fetch`/`sendBeacon` for that host before loading the tracker, or run the tracker in a Worker under `connect-src 'self'`; add an egress regression test | `node audit/network-egress.mjs` → "off-origin requests: 0" | A03 · V14 Data Protection, V15 |
| **SE7-04** | **Medium** (L:M × I:M) | Confirmed (P04, P05; code) | Bridge authorization model | Only check is "has a session" (`api.py:374`); any session controls any allowlisted GA (P04) and can disconnect the shared KNX link (P05); `POST /knx/disconnect` has no rate limit (`api.py:514–517`); no endpoint to list or revoke other sessions; tokens live 12 h | A guest who once paired, or a stolen token, keeps control and can repeatedly cut the KNX link for every user; only a bridge restart evicts them | Loss of control/availability; no selective eviction | Roles bound at pairing (`viewer`/`operator`/`admin`); admin-only connect/disconnect/override/discover; admin `GET`/`DELETE /sessions`; rate-limit disconnect; per-session GA scopes | pytest: operator → 403 on `/knx/disconnect`; admin revokes a session → its token 401 | A01 · V8 Authorization, V7 Session Management |
| **SE7-05** | **Medium** (L:M × I:M) | Confirmed (config; audit runs used `http://`) | Bridge transport, wizard | TLS only when `SE7ENX_TLS_CERT`/`SE7ENX_TLS_KEY` are set; default `http://…:8787`; wizard accepts non-loopback `http://` with a browser-compatibility hint only (`src/lib/net/endpoint.ts:131–133`) | Attacker on the same Wi-Fi (guest network, compromised IoT device) sniffs the pairing request or any call and replays the Bearer token | Control of the allowlisted lights for up to 12 h | Make HTTPS paths the documented default (Tailscale Serve, mkcert, reverse proxy); wizard warning "unencrypted: your access token is visible on this network" for non-loopback `http://`; *proposed* bridge option to refuse non-loopback plaintext unless explicitly allowed | Wizard shows the warning for `http://192.168.x.x`; bridge refuses `0.0.0.0` without TLS unless opted in | A04 · V12 Secure Communication |
| **SE7-06** | **Medium** (L:M × I:M) | Confirmed (P12, P13; control P14; uvicorn source) | Bridge pairing protection | `bridge/se7enx_bridge/__main__.py:62–63`: with `SE7ENX_TRUST_PROXY=true`, uvicorn gets `forwarded_allow_ips="*"`. In that mode uvicorn takes the **left-most** `X-Forwarded-For` entry (`uvicorn/middleware/proxy_headers.py:176–177`, v0.54.0), which a client can pre-set even when a proxy appends the real address. Pairing lockout is global (`security.py:119–122`) | With trust_proxy on: rotating spoofed XFF evades per-client limits (12/12 attempts not limited) and forges source IPs in logs, directly or through an appending proxy. In any mode: 20 failures from anyone lock pairing for everyone for 5 min, repeatably | Pairing unavailable for legitimate users (existing sessions keep working); misleading logs; brute force still bounded by the global lock | Pass the proxy's own address (e.g. `127.0.0.1` for Tailscale Serve or a local reverse proxy; *proposed* `SE7ENX_TRUSTED_PROXIES`) instead of `"*"`, so that uvicorn picks the right-most untrusted entry; per-source lockout plus global exponential back-off | P12 → spoofed XFF no longer changes the client identity | A07, A02 · V6 Authentication, V2 (anti-automation) |
| **SE7-07** | **Medium** ⚡ (L:L × I:M→H) | Confirmed (P10; code) | Safety controls (bridge + web) | Emergency stop is client state only (`src/lib/commands/policy.ts:32`); no bridge-side kill switch or read-only mode; no per-GA minimum interval; one session toggled the load 6× in < 0.1 s (P10); limits 6/10 s per session, 20/10 s per bridge | A buggy or compromised client, or another device, keeps switching while the user presses the emergency stop on their own device | Relay wear, flicker (photosensitivity), nuisance; for non-lighting loads possible equipment harm | Bridge `POST /safety/stop` + `/safety/resume` (admin) blocking all writes; per-GA minimum interval (e.g. 1 s) and toggle budget; show bridge stop state in the UI | pytest: after stop every write is refused; rapid toggles → 429 per GA | A06 · V2, V15 Secure Coding and Architecture |
| **SE7-08** | **Medium** ⚡ (L:L × I:M→H) | Confirmed (code + HA source) | Web app, HA adapter | `src/lib/adapters/ha-adapter.ts:236` calls `knx.send` for whatever GA the wizard holds; HA lets any authenticated user call `knx.send` to any group address; SE7ENX's restriction is client-side only | A typo (`1/1/10` instead of `1/1/1`) or a tampered client writes to another actuator (blinds, heating, a KNX door opener) | Unintended actuation anywhere on the HA-connected bus | Short term: before the first test, show the HA entity bound to the GA and require confirmation; long term: HA-side agent with a GA allowlist | Wizard shows the resolved entity; agent rejects non-allowlisted GAs | A01 · V8 Authorization |
| **SE7-09** | **Medium** (L:L × I:H) | Confirmed (headers + config) | Web app headers | `next.config.ts:21` `script-src 'self' 'unsafe-inline'`; `:26` `connect-src` allows any http(s)/ws(s) host; the app emits no `Strict-Transport-Security` (Vercel documents automatic HSTS on `*.vercel.app` and custom domains, not verified on a live deployment; self-hosting needs it); no XSS sink exists today | Any future injection or compromised dependency runs inline script and exfiltrates tokens (SE7-01) to any host | Amplifies every future XSS | Nonce-based CSP with `'strict-dynamic'` (Next.js proxy/middleware); add HSTS in `next.config.ts`; document why `connect-src` must stay broad (user-defined bridge/HA hosts) or move connections into a narrower runtime-configured policy | `curl -sI` shows nonce CSP and HSTS; CSP evaluator passes | A02 · V3 Web Frontend Security |
| **SE7-10** | **Medium** (L:L × I:H) | Confirmed (code) | Web app config | `next.config.ts:54–62`: `SE7ENX_DEV_BRIDGE_REWRITE` adds `/demo-bridge/* → <bridge>` with no production guard | Operator copies a preview config to a public deployment, so the bridge becomes reachable from the internet through the app origin, which the bridge's Origin allowlist also trusts | Internet exposure of the bridge (pairing DoS; any future bridge bug remotely exploitable) | Refuse the rewrite when `VERCEL_ENV=production`/`NODE_ENV=production` unless an explicit, scary opt-in is set (*proposed*); keep documented as demo-only | Production build with the variable set fails or drops the rewrite | A02, A01 · V13 Configuration |
| **SE7-11** | **Low** (L:L × I:M) | Confirmed (P06) | Bridge sessions | `bridge/se7enx_bridge/security.py:156–159`: at `max_sessions` (10) a new pairing silently revokes the oldest session | Anyone with the current pairing code evicts legitimate clients | Unexpected "pair again"; no notification | Refuse pairing at cap (or evict idle sessions only) and log the eviction; admin session list (SE7-04) | P06 → pairing at cap returns 409 | A06 · V7 |
| **SE7-12** | **Low** (L:L × I:M) | Confirmed (P07) | Bridge audit log | `api.py:475, 510, 516, 595, 641, 679` log `clientName` with `%s`; `PairRequest.clientName` allows control characters (`api.py:81`) | A paired client named `x\nFORGED se7enx.audit: command … client=admin …` writes fake audit lines (captured in `bridge_probes.txt`) | Misleading forensic trail | Restrict `clientName` to printable characters (Pydantic pattern) and log with `%r`; structured JSON logs | P07 → one line per event | A09 · V16 Security Logging and Error Handling |
| **SE7-13** | **Low** (L:L × I:M) | Confirmed (P16) | Bridge config | `config.py:21` accepts any `^[A-Z0-9]{8,32}$` fixed code (e.g. `AAAAAAAA`); fixed codes never rotate; codes are printed to stdout/journald/docker logs | A guessable or leaked fixed code lets anyone on the LAN pair | Unauthorized pairing (still bounded by the GA allowlist) | Reject low-entropy fixed codes; warn when a fixed code is used; recommend rotating random codes | Config validation rejects `AAAAAAAA` | A07 · V6 |
| **SE7-14** | **Low** (L:L × I:L–M) | Confirmed (P15) | Bridge gateway override | Default `SE7ENX_CLIENT_GATEWAY_CIDRS` includes `169.254.0.0/16` (`config.py:20`); when the (default-off) override is enabled, an authenticated client chooses the gateway IP/port in those ranges | With override enabled: limited KNXnet/IP-only probing of private/link-local hosts | Low (auth required, protocol-restricted, off by default) | Drop link-local from defaults; pin the port to 3671 unless configured | P15 → `169.254.0.0/16` not in defaults | A01 (SSRF) · V13 |
| **SE7-15** | **Low** (L:M × I:L) | Confirmed (config) | Bridge container | `bridge/Dockerfile:8` sets `SE7ENX_HOST=0.0.0.0`; compose uses host networking, so the bridge listens on every host interface (contradicting "loopback by default", which holds for pip/systemd) | Bridge reachable from VPN/guest interfaces of the host | Larger attack surface (pairing + Origin still required) | Default the compose file to `127.0.0.1`; document deliberate LAN binding with firewall rules | `ss -ltnp` after `docker compose up` shows `127.0.0.1:8787` | A02 · V13 |
| **SE7-16** | **Low** (L:L × I:M) | Confirmed (config) | Bridge supply chain | `bridge/pyproject.toml`: `xknx>=4.0,<5`, `fastapi>=0.140,<1`, `uvicorn[standard]>=0.50`; no lock file or hashes; Docker build resolves the latest versions | A malicious or breaking upstream release enters a new image | Bridge integrity/availability | Commit a hashed lock (`pip-compile --generate-hashes` or `uv lock`) and install with `--require-hashes`; automated update PRs | Dockerfile installs from the lock with hashes | A03 · V15 |
| **SE7-17** | **Info**, accepted risk | Confirmed (`npm audit`) | Dev toolchain only | 5 "high" entries, all one advisory GHSA-vfj7-8cjw-p6xm (`braces` ≤ 3.0.3) via `eslint-config-next` → `fast-glob` → `micromatch`; no patched `braces` exists; npm's "fix" downgrades `eslint-config-next` to an old major. **Production tree: 0 vulnerabilities** | Needs attacker-controlled glob patterns in a developer's lint run | None for shipped artefacts | Accept and monitor; do not apply the suggested downgrade | `npm audit --omit=dev` → 0 | A03 · V15 |
| **SE7-18** | **Low**, Fixed (docs) | Confirmed (doc review) | Documentation | "100 % on-device" (`README.md:18`), "Gestures fully local" (`IMPLEMENTATION_REPORT.md:45`); `docs/SECURITY.md` claimed per-client pairing limits without the proxy caveat, loopback-by-default (Docker differs), "short-lived" HA tokens (refresh ≤ 90 days, sliding) | Operators and users rely on incorrect privacy/security statements | Wrong risk decisions | Corrected in this change set. UI strings ("frames … never uploaded") are true for frames but omit the telemetry, so a UI disclosure is still needed (*proposed*, app change) | `grep -rn "100 % on-device\|fully local"` returns nothing in docs | A06 · V14 |
| **SE7-19** | **Info** | Confirmed (headers + code) | Bridge `/api/v1/health` | Unauthenticated endpoint returns product, version, contract. The production entry point already disables uvicorn's `server` header (`__main__.py:64`); only the test/demo `tools/dev_stack.py` (`:60–61`) sends `server: uvicorn` | Version fingerprinting on the LAN | Minimal | Keep it minimal; optionally omit the version; set `server_header=False` in the dev stack too | `curl -sI <bridge>/api/v1/health` shows no `server` header | A02 · V13 |
| **SE7-20** | **Info** | Confirmed (code) | Web app model loading | `NEXT_PUBLIC_HAND_MODEL_URL` (`src/lib/gesture/hand-tracker.ts:10`) may point to another origin; the SHA-256 check runs only on the bundled file at build time (`scripts/prepare-assets.mjs`) | A swapped remote model loads without an integrity check | Low (model is data parsed by WASM) | Verify the hash at runtime when overridden, or drop the override | Unit test: hash mismatch blocks loading | A08 · V15 |
| **SE7-21** | **Low** ⚡ (L:L × I:L→M) | Suspected (logic review; not reproduced) | Web app, HA confirmation | `ha-adapter.ts:194` treats any outgoing `GroupValueWrite` to the same GA within 3.5 s (`:231`) as confirmation of SE7ENX's command | Another HA automation writes the same GA within the window while SE7ENX's own send failed, so SE7ENX shows "bus confirmed" | Rare false confirmation | Also compare the value and require successful `knx.send` completion; otherwise label as "observed" | Integration test with a concurrent foreign write | A10 · V2 |
| **SE7-22** | **Info**, Unverified | No evidence possible here | Whole system | No real KNX interface/actuator, real HA, Safari/Firefox, Vercel or real speech services were available | Real-world behaviour (tunnel-slot limits, TCP/Secure/routing, HA redirect validation, Local Network Access prompts) may differ from the simulations | Unknown | Execute the validation plan in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) | Signed checklist results | V15 |
| **SE7-23** | **Info** | Confirmed (storage probe) | Web app persistence | `localStorage['se7enx.settings.v1']` keeps bridge URL, HA URL and group addresses indefinitely (no secrets) | Anyone with the browser profile learns the home's network topology | Minimal | Document; *proposed* "Forget this home" control | Storage probe: key removed after "Forget" | V14 |
| **SE7-24** | **Low** (L:L × I:M; ⚡ not applied: requires a deliberate, documented-as-unsafe administrator choice) | Confirmed (code) | Bridge group-address policy | `bridge/se7enx_bridge/group_address.py:102–103` accepts `*`, segment wildcards and ranges; `:133–134` `*` matches every address; accepted by `config.py:179`; the only start-up warning is for an *empty* list (`api.py:308`) | An operator sets `SE7ENX_ALLOWED_GROUP_ADDRESSES=*` for convenience; any paired session or stolen token can then write to every group address on the bus | Unintended actuation of any KNX device (blinds, heating, door openers) | Warn loudly, or require an explicit second opt-in, for `*` and patterns covering more than a few addresses; log the effective allowlist size at start-up | A config with `*` logs a warning or refuses to start without the opt-in | A01, A02 · V8 Authorization, V13 Configuration |
| **SE7-25** | **Info** | Confirmed (config) | `bridge/.env.example` | `:33` allows `0/0/1,0/0/2` (placeholders that become live if copied unchanged); `:12` keeps the dev origin `http://localhost:3000`; `:18` recommends `SE7ENX_TRUST_PROXY=true` behind Cloudflare Tunnel / Tailscale Serve without the SE7-06 caveat | An installer copies the example as-is | Commands allowed for addresses that may belong to other devices; a dev origin stays trusted; spoofable rate-limit identities | Use empty or obviously invalid placeholders, drop the dev origin from the production example, add the SE7-06 caveat | Review of the example file | A02 · V13 Configuration |
| **SE7-26** | **Info** | Confirmed (code) | Bridge middleware | No `Host` header validation in `SecurityMiddleware` (`api.py:135–217`); requests without `Origin` are allowed (`:176`) | A DNS-rebinding page sends Origin-less GETs to the bridge; its POSTs carry the attacker's Origin (403) and all other routes need a token | Disclosure of service name, version and API paths only (`api.py:426–434, 751–753`) | Optional Host allowlist (e.g. Starlette `TrustedHostMiddleware` with the bridge's hostnames/IPs) | A request with a foreign `Host` → 400 | A02 · V4 API and Web Service |

---

## 4a. Status after release 1.1.0 (local-first hub, 2026-10-17)

Re-assessed against the 1.1.0 code (commit after `143e2ab`). "Hub path" = the new device API /
appliance; "legacy path" = the 1.0 per-session light API and the browser-side HA mode of the hosted app.

| ID | Status in 1.1.0 | Evidence |
| --- | --- | --- |
| SE7-01 | **Mitigated.** Hub path: HA token server-side only (`secrets.json` 0600, write-only API). Legacy browser path: tokens kept in memory only (no `sessionStorage`); full-rights token still exists in that tab's memory | `devices/adapters/homeassistant.py`, `api_devices.py` (`tokenStored`), `src/lib/ha/oauth.ts` |
| SE7-02 | **Open on the legacy path**; the hub path never reuses stale values (unanswered reads stay unknown; "confirmed" only on matching feedback) | `devices/adapters/knx.py` (`_initial_reads`, waiters) |
| SE7-03 | **Mitigated in the appliance** (`connect-src 'self'` blocks the telemetry); hosted build unchanged (disclosure) | `bridge/se7enx_bridge/ui.py` `UI_CSP`; appliance browser test asserts zero off-origin requests |
| SE7-04 | **Open and broader**: any paired browser can now also add devices, store device credentials and enable real control (with acknowledgement). Pairing (code from the console/log) remains the only gate; roles are the most important next step | `api_devices.py` (all routes `require_session`) |
| SE7-05 | **Open**: HTTP by default on the LAN; HTTPS options documented | `docs/LOCAL_DEPLOYMENT.md` §6 |
| SE7-07 | **Mostly addressed**: hub-wide emergency stop for device commands **and** the legacy light API (423), per-device minimum interval, one command in flight per device | `devices/registry.py`, `api.py` `_command`, `test_hub_emergency_stop_also_blocks_the_light_api` |
| SE7-08 | **Addressed on the hub path** (only entities added as devices can be controlled); legacy browser path unchanged | `devices/adapters/homeassistant.py` |
| SE7-09 | **Partly**: appliance CSP closes the exfiltration channel (`connect-src 'self'`) but still needs `'unsafe-inline'` for the static export | `ui.py` |
| SE7-15 | **By design in the appliance**: the container listens on all interfaces so LAN devices can reach the UI; `SE7ENX_BIND_ADDRESS` limits the published interface; Host allowlist + same-origin rules apply | `deploy/appliance/compose.yaml` |
| SE7-16 | **Mitigated**: the image installs exact tested versions from `bridge/constraints.txt` (no hashes yet) | `Dockerfile` |
| SE7-26 | **Addressed**: opt-in Host allowlist, on by default in the appliance (`auto`); same-origin trusted only for allowed hosts | `hosts.py`, `api.py` `SecurityMiddleware` |

New controls in 1.1.0: device hosts restricted to private/link-local addresses (no loopback, no
public IPs, no scanning); credentials never returned or logged (tested in responses, files, exports
and logs); real devices created read-only; KNX writes limited to each device's configured addresses
with the operator allowlist as a ceiling; schema-validated commands per capability.

## 5. Details for the high-severity findings

### SE7-01: Full-scope Home Assistant tokens in browser storage

**Facts.** After the HA OAuth redirect, `completeHaLogin()` builds an `Auth` object and
`saveTokens` persists it (access token, refresh token, expiry, HA URL) as JSON in
`sessionStorage['se7enx.ha.tokens']` (`src/lib/ha/oauth.ts:79–86`). From the HA source: access tokens
last 30 minutes. Normal-user refresh tokens get `expire_at = now + 90 days`, renewed on every use.
HA's permission model has three groups (`system-admin`, `system-users`, `system-read-only`) and **no
OAuth scopes**, so any token can do everything its user can. The wizard lists "Admin account
recommended for live feedback" (`connection-wizard.tsx:949`), because only admins may call
`knx.event_register`. `revokeAuth` (`oauth.ts:134–141`) is best-effort: if HA is unreachable at
Disconnect time, the refresh token stays valid server-side.

**Why it matters.** `sessionStorage` is readable by any JavaScript running in the origin.
`script-src 'unsafe-inline'` (SE7-09) and a large dependency tree increase the chance that such code
runs one day. The payoff is not "one light" but the whole HA instance.

**Assumption.** No XSS exists today (none found: no `dangerouslySetInnerHTML`, `innerHTML` or
`eval`). The rating rests on defence-in-depth and blast radius, not on a working exploit.

**Proposed fix (in order of effort).** (1) Stop persisting tokens: keep `Auth` in memory, accept
re-authentication after reload. (2) Replace the admin recommendation with "use a dedicated non-admin
HA user; live bus confirmation is then unavailable". (3) Revoke on `pagehide` as well as Disconnect.
(4) Long term, the HA-side agent in the target architecture keeps the credential inside the home and
enforces an allowlist.

### SE7-02: Stale state presented as confirmed

**Facts (P08, P09).** `GET /lights/{id}/state?refresh=1` sends a `GroupValueRead`. If no
response arrives in time, the handler falls back to `values[ga]` and returns it with
`via: status_address` and its old timestamp, but no indication that the read failed
(`api.py:620–627`). The value cache is never cleared when the KNX link is torn down
(`knx.py:372–379`). The web adapter stamps the report with the browser's current time
(`bridge-adapter.ts:101`), and `selectLampView` labels it **"Device confirmed"** (`selectors.ts:120`).
In P08 the fake actuator was OFF while the bridge answered `on`.

**Why it matters.** The product's core safety promise is to keep requested and confirmed state
separate and never overstate certainty. Missed telegrams are realistic: link outages, interface
reboots, and actuators whose status objects lack the read flag.

**Proposed fix.** The bridge returns `{"value": null, "stale": true, "lastKnown": {...}}` (or
`504 KNX_READ_TIMEOUT`) when a read times out, and clears `values` in `_teardown`. The adapter
uses the server's `observedAt` and maps stale data to `UNVERIFIED`.

---

## 6. Positive controls (verified)

| Control | Evidence | How verified |
| --- | --- | --- |
| Authentication on every sensitive bridge endpoint | `api.py:374–400`; tests `test_auth_required_for_everything_sensitive`, `test_event_stream_requires_auth` | P01: 401 on all sensitive endpoints without a token |
| Origin allowlist (CSRF / DNS-rebinding / LAN scanning from other sites) | `api.py:176`; wildcards refused at startup (`config.py:147`) | P02: foreign Origin → 403; test `test_foreign_origin_rejected_everywhere` |
| Pairing code strength and handling (random codes) | 32-symbol alphabet, 8 chars, single use, rotation (`security.py:27`), constant-time compare (`security.py:112`) | Unit tests `test_random_codes_are_single_use_and_rotate`, `test_codes_expire`, `test_lockout_after_repeated_failures` |
| Session tokens | 256-bit `token_urlsafe(32)` (`security.py:160`), stored as SHA-256 (`:141`), expiry (`:179`), cap | Storage probe: token works (200), Disconnect → **401** (server-side revocation) |
| Session isolation of light registrations | Light configs keyed per session | P03: session B → 404 on A's light |
| Default-deny group-address policy for writes **and** reads | `require_allowed` at `api.py:564, 588, 590, 623, 636` | P17 (empty allowlist by default) + `test_light_validation_and_default_deny_policy` |
| Strict input validation | Pydantic `extra="forbid"` (`api.py:76`), `requestId` pattern (`:106`), 16 KiB body cap (`:41`); GA grammar validated in browser **and** bridge with shared vectors | P11: 20 kB body → 413; contract tests |
| Truthful confirmation semantics | `ConfirmingCEMIHandler` (`knx.py:119–133`); negative → `KNX_NEGATIVE_CONFIRMATION` (`:460–463`); timeout → `KNX_CONFIRMATION_TIMEOUT` (`:439–441`); routing never "bus_confirmed" (`:457`) | `test_negative_and_missing_confirmation_are_errors`; integration "reports routing sends as accepted, never as bus-confirmed" |
| Idempotent retries | `requestId` cache, 120 s (`api.py:43, 633`) | `test_idempotent_request_ids_never_send_twice` |
| No automatic ON/OFF; acknowledged test command | Test buttons disabled until the risk checkbox is ticked (`connection-wizard.tsx:1040–1051`) | e2e `knx-bridge.spec.ts` |
| Emergency stop for hands-free sources | `policy.ts:32`; `Esc` handler (`app-shell.tsx:39`); listening stops when paused/hidden (`app-shell.tsx:33, 45`) | e2e voice/gesture specs (client-side scope, see SE7-07) |
| Gesture safety gates | Confidence gate (`gesture-engine.ts:183`, min 0.6), dwell 450 ms, cooldown 1.5 s, re-arm | Unit tests (gesture engine) |
| Voice allowlist only | `parseVoiceCommand` (`voice/commands.ts:155`), max 8 words, ambiguity rejection (`:188`) | Unit tests (EN/FR/AR vectors) |
| Camera/microphone only on explicit action | `startCamera` (`gesture-store.ts:61`), secure-context check (`:71`); mic permission probe stops tracks immediately (`voice-controller.ts:139–140`); 8 s push-to-talk / 60 s hands-free caps (`:15–16`) | e2e: camera requested only after "Enable camera"; storage probe: no media persisted |
| HA OAuth login-CSRF protection | Random `state` (`oauth.ts:30`), checked (`:101`), 10-min expiry (`:19`), code removed from URL (`:76`) | Integration test `builds an authorize URL with client_id, redirect_uri and a state nonce` |
| HA URL must be HTTPS (except loopback) | `endpoint.ts:112–123` | Unit tests (endpoint) |
| Web security headers | CSP, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera/mic self), COOP | `curl -sI` against `next start` |
| Bridge security headers | `default-src 'none'` CSP, `X-Frame-Options`, CORP `same-origin`, `Cache-Control: no-store`, ACAO only for allowed origins, Private Network Access preflight; `/docs` and `/openapi.json` → 404 | `curl -sI` against the bridge |
| No XSS sinks | No `dangerouslySetInnerHTML`, `innerHTML`, `eval`; 3 `console.warn/error` calls, none with sensitive data | grep over `src/` |
| Secrets hygiene | Only `.env.example` files were ever committed; no credentials in history; client bundle (2.4 MB) contains no secrets | `detect-secrets` (5 hits, all false positives), `git log -p` pattern search, bundle grep |
| Dependencies | Production npm tree 0 vulnerabilities; bridge 34 packages, 0 known vulnerabilities | `npm audit --omit=dev`, `pip-audit` |
| Vercel attack surface | Only `GET /api/health`; no middleware, no server actions, no proxy (unless SE7-10 is misconfigured) | Code + build route table |

---

## 7. Readiness decisions (Phase 3)

| Scenario | Decision |
| --- | --- |
| 1. Local developer demo | **Ready** |
| 2. Controlled test with your own hardware | **Ready with restrictions** |
| 3. Public Vercel frontend-only demo (simulation) | **Ready with restrictions** |
| 4. Real users create accounts and connect their own Home Assistant | **Not ready** |
| 5. Production use with physical devices | **Not ready** |

**1. Local developer demo: Ready.**
*Evidence:* all suites pass (§2.5); bridge defaults are safe (loopback bind, deny-all allowlist,
override off: P17); the fake KNXnet/IP interface exercises the real xknx client.
*Assumptions:* developer machine, no real hardware.
*Blocking risks:* none. *Note:* using the camera sends MediaPipe telemetry (SE7-03).

**2. Controlled test with your own hardware: Ready with restrictions.**
*Evidence:* auth, origin, allowlist and confirmation controls verified (§6).
*Required restrictions:*
- Run the bridge on a trusted LAN, bound to loopback or behind HTTPS (Tailscale Serve, mkcert),
  never plain HTTP across shared Wi-Fi (SE7-05).
- Allowlist only the test light's switching and status addresses, for a non-critical lighting load.
- Use random pairing codes (SE7-13), with a single operator present and watching the light.
- Use a status address the actuator actively sends (with the read flag if possible).
- Treat any "Device confirmed" shown right after a reconnect with caution (SE7-02).
- On the HA path, use a dedicated non-admin test user (SE7-01, SE7-08).
*Blocking risks to remove before calling it "Ready":* SE7-02.

**3. Public Vercel frontend-only demo: Ready with restrictions.**
*Evidence:* simulation needs no backend; no server-side data or secrets; headers present; 0
production vulnerabilities.
*Required restrictions:*
- Publish a privacy notice that discloses the MediaPipe telemetry, or block it, before promoting the
  camera feature (SE7-03).
- Never set `SE7ENX_DEV_BRIDGE_REWRITE` (SE7-10).
- Label the Home Assistant and bridge paths as experimental.
- Recommended: SE7-09 (nonce CSP + HSTS).

**4. Real users with accounts connecting HA: Not ready.**
*Evidence:* no account system exists (nothing to sign up for); the HA OAuth flow has only run
against a mock (SE7-22); full-scope tokens in browser storage (SE7-01); no server-side target
restriction (SE7-08); weak CSP (SE7-09).
*Also missing:* privacy policy and terms, incident response, third-party penetration test.
*Required changes:* the target architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#target-architecture-proposed--not-implemented)
(agent-held credentials with allowlists), plus SE7-01/08/09 fixed and a real-HA verification.

**5. Production with physical devices: Not ready.**
*Evidence:* no hardware validation (SE7-22); SE7-02 (stale state), SE7-04 (no roles or
administrative revocation), SE7-05 (plaintext default), SE7-07 (no bridge-side stop or per-address
limits), SE7-06 (pairing DoS).
*Also missing:* monitoring and alerting, an update path for bridges in the field, KNX Secure
validation, operational runbooks.

---

## 8. Remediation roadmap (all items proposed, not implemented)

| Priority | When | Items |
| --- | --- | --- |
| **P0** | Before any public promotion of the camera feature | SE7-03 disclose + block telemetry, add egress test · SE7-10 production guard on the dev rewrite · SE7-18 docs (**done in this change set**) |
| **P1** | Before handing the bridge to anyone else's installation | SE7-02 stale-state semantics · SE7-05 TLS-first + plaintext warning · SE7-06 explicit trusted proxies, per-source lockout · SE7-12 log sanitisation · SE7-13 fixed-code strength · SE7-15 Docker loopback default · SE7-14 drop link-local CIDR |
| **P2** | Before real users | SE7-01 memory-only HA tokens + non-admin guidance · SE7-08 GA confirmation/agent allowlist · SE7-09 nonce CSP + HSTS · SE7-04 roles + admin session revocation + throttled disconnect · SE7-07 bridge kill switch + per-GA interval · SE7-11 eviction policy · SE7-16 hashed lock file · SE7-21 confirmation correlation · regression tests for every confirmed finding |
| **P3** | Before production with physical devices | Hardware + real-HA validation (SE7-22) · target architecture (agent, optional accounts) · monitoring/alerting · signed bridge releases and an update path · external penetration test · privacy policy and data-processing review |

---

## 9. Evidence log (Phase 6)

### 9.1 Commands executed in this audit and their results

| Command | Result |
| --- | --- |
| `npm ci` | OK (clean install) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | 0 errors |
| `npx vitest run` | **185 passed / 185**, 10 files |
| `bridge/.venv/bin/pytest` | **98 passed** (6.41 s) |
| `ruff check` · `ruff format --check` | clean |
| `npx playwright test` (Chromium desktop + mobile emulation, fake camera, SwiftShader WebGL) | **24 passed, 1 skipped** (mobile keyboard test, skipped by design), 2.1 min |
| `npm run build` (default env) | OK |
| `bridge/.venv/bin/python audit/bridge_probes.py` | 6 PASS · 10 CONFIRMED · 1 INFO → [`bridge_probes.txt`](audit/results/bridge_probes.txt) |
| `node audit/storage-and-revocation.mjs` (bridge dev stack on 8799) | Token in `sessionStorage`, settings in `localStorage`, no cookies; revocation 200 → 401 → [`storage_and_revocation.txt`](audit/results/storage_and_revocation.txt) |
| `node audit/network-egress.mjs` (75 s camera) | 1 off-origin request: `POST odml.pa.googleapis.com/v1/log` → [`network_egress.txt`](audit/results/network_egress.txt) |
| `curl -sI` web app (3100) and bridge | Headers as listed in §6 |
| `npm audit` · `npm audit --omit=dev` | 5 high (one dev-only advisory, SE7-17) · **0** |
| `pip-audit` (34 frozen bridge packages) | No known vulnerabilities |
| `detect-secrets scan` (tracked files) | 5 hits, all false positives (test fixtures/placeholders) |
| `git log -p --all` credential-pattern search | No credentials; only demo pairing codes in docs |

### 9.2 Bridge probe catalogue

| Probe | Checks | Result |
| --- | --- | --- |
| P01 | Sensitive endpoints without token | PASS: 401 ×4 |
| P02 | Pairing from a foreign Origin | PASS: 403 `ORIGIN_NOT_ALLOWED` |
| P03 | Session B reads session A's light | PASS: 404 |
| P04 | Session B controls the same allowlisted GA | CONFIRMED gap (SE7-04) |
| P05 | Any session disconnects the shared KNX link | CONFIRMED gap (SE7-04) |
| P06 | Pairing at `max_sessions` evicts the oldest session | CONFIRMED (SE7-11) |
| P07 | Newline in `clientName` forges audit lines | CONFIRMED (SE7-12) |
| P08 | Refresh read without answer returns cached value as current | CONFIRMED (SE7-02) |
| P09 | Value cache survives disconnect/reconnect | CONFIRMED (SE7-02) |
| P10 | Rapid toggling by one session | INFO: 6 toggles in < 0.1 s, then 429 (SE7-07) |
| P11 | 20 kB request body | PASS: 413 |
| P12 | Spoofed `X-Forwarded-For` with trust_proxy on | CONFIRMED (SE7-06) |
| P13 | Global pairing lockout blocks the correct code | CONFIRMED (SE7-06) |
| P14 | Spoofed XFF with trust_proxy off (control) | PASS: ignored, per-client limit applies |
| P15 | Link-local in default gateway CIDRs | CONFIRMED (SE7-14) |
| P16 | Weak fixed pairing code accepted | CONFIRMED (SE7-13) |
| P17 | pip/systemd defaults | PASS: loopback, deny-all allowlist, override off |

### 9.3 What the automated test suites cover (and do not)

| Area | In the regular suites? | Where / gap |
| --- | --- | --- |
| Authentication (bridge) | ✅ | `bridge/tests/test_api.py` (auth required, pairing limits, SSE auth), `test_security.py` (7 tests) |
| Origin / cross-site protection | ✅ | `test_foreign_origin_rejected_everywhere`, `test_cors_preflight_and_private_network_access` |
| Group-address authorization | ✅ | `test_light_validation_and_default_deny_policy`, `test_gateway_override_disabled_by_default_and_restricted_when_enabled` |
| Cross-session isolation | ❌ | Only audit probes P03–P05 → add regression tests |
| Secret exposure | ❌ | Only manual audit scans → add CI secret scanning |
| Browser storage contents | ❌ | Only `audit/storage-and-revocation.mjs` → add e2e assertions |
| Network egress / privacy | ❌ | Only `audit/network-egress.mjs`; the e2e gesture test runs < 60 s and would not see the telemetry |
| Web security headers | ❌ | Only manual `curl` → add a test |
| Failure handling | ✅ | Negative/missing confirmation, unreachable interface, timeouts, revoked session, buffered SSE, reconnect, invalid HA tokens, HA send failures |
| Stale state after timeout/reconnect | ❌ | Gap demonstrated by P08/P09 |
| Command safety | ✅ | Idempotency, rate limit, test-never-writes, policy unit tests, e2e emergency stop |

**Mocks vs. real components.** All KNX tests use a *protocol-level fake* KNXnet/IP interface (the
real xknx client talks real KNXnet/IP over UDP to a fake server). HA tests use a mock WebSocket
server. Browser tests use Chromium's fake camera, a scripted `SpeechRecognition` stub and SwiftShader
WebGL. **Nothing was tested against real KNX hardware, a real HA instance, Safari/Firefox, a real
speech service or Vercel.**

### 9.4 Not examined

Formal threat-modelling workshop, automated SAST/DAST tooling beyond the probes above, fuzzing of
the bridge API and KNX decoding, licence compliance, performance/load testing, physical security of
installations.

---

## 10. References

* OWASP Risk Rating Methodology; OWASP Top 10:2025; OWASP ASVS 5.0 (chapters V1–V17).
* Home Assistant core source: `homeassistant/auth/__init__.py`, `homeassistant/auth/const.py`
  (token lifetimes, groups), KNX integration services/WebSocket API.
* Public reports of `@mediapipe/tasks-vision` usage telemetry to `odml.pa.googleapis.com`
  (task type, running mode, OS, SDK version, latencies; no frames or landmarks; no documented opt-out).
* Chrome Local Network Access (Chrome 142+) and mixed-content behaviour for private-network fetches.
