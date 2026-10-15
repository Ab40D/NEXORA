# SE7ENX: Pre-Deployment Security & Privacy Review

| | |
| --- | --- |
| **Question answered** | Can this project be deployed on Vercel and shared publicly, and under which conditions? |
| **Code reviewed** | Commit `e0fc766`. Application code is identical to `f51c06c` (`git diff f51c06c HEAD` touches only docs and `audit/`) |
| **Date** | 2026-10-16 |
| **Method** | Line-by-line inspection of the web app, the bridge and the deployment configuration; runtime checks against a local production build; reuse of reproducible probes from [`audit/`](audit/README.md); vendor documentation where platform behaviour matters |
| **Finding IDs** | Shared with the detailed register in [SECURITY_AUDIT.md](SECURITY_AUDIT.md#4-findings-register) (SE7-01 to SE7-26) |

**Evidence labels:** **[code]** read in source at the cited line · **[runtime]** observed by running the
code (Chromium, real bridge code, fake KNX interface, mock HA) · **[vendor docs]** stated by a vendor,
not tested here · **[unverified]** not tested at all.

> **No real secrets were found** in the repository, its git history or the client bundle, so none
> are reproduced here. The fixed demo pairing codes in docs and tests belong to the dev/test stack,
> which is hard-wired to the fake KNX interface (`bridge/tools/dev_stack.py:41, 49–56`) [code]. They
> are not credentials for any real system.

---

## 0. Bottom line

| Scenario | Verdict |
| --- | --- |
| **A. Public simulation demo on Vercel** | **YES WITH CONDITIONS** (§11) |
| **B. Public website with your real Bridge connected** | **NO** for anything other people can use. A narrow exception for your own private use is described in §9 |
| **C. Real KNX hardware control in production** | **NO** |

**No Critical finding was identified.** In the default configuration, no path was found by which an
unauthenticated internet visitor can operate KNX hardware. The serious risks require one of these:
misconfiguration (exposing the bridge, the demo rewrite, a `*` allowlist), presence on your LAN, or
compromise of the deployed site or its supply chain. The two **High** findings (SE7-01, SE7-02)
concern real-hardware use, not the simulation demo.

---

## 1. Is it secure enough to deploy on Vercel and share publicly?

**For a simulation-only demo: yes, with conditions.** The Vercel deployment is a static UI plus one
read-only route.

| Property | Evidence |
| --- | --- |
| Only server route is `GET /api/health`, returning service name, version and time, with `no-store`; no input | `src/app/api/health/route.ts` [code]; response captured [runtime] |
| No middleware, no server actions. A forged `Next-Action` POST is rejected with **400** | [runtime] |
| No `vercel.json`; all platform behaviour comes from `next.config.ts` | [code] |
| No cookies, no server-side storage, no database, no analytics or error-reporting SDKs | no `Set-Cookie` [runtime]; dependency list [code] |
| No secrets needed or present; `.env*` git-ignored except the examples | `.gitignore:21–26` [code]; secret scans |
| Framework versions past the fix for the critical React Server Components RCE (CVE-2025-55182, "React2Shell"): fixed in React 19.2.1 / Next.js 16.0.7; installed React 19.3.1 / Next 16.4.1 | `npm audit --omit=dev` → **0** vulnerabilities in 167 packages (2026-10-16) [runtime]; fixed versions [vendor docs] |

The conditions exist because of **privacy disclosure** (SE7-03), one **misconfiguration trap**
(SE7-10, the demo rewrite) and **site-integrity** concerns (SE7-09). None of them lets a visitor
reach hardware in the default configuration.

**For anything connected to real hardware: no** (see §7, §9).

---

## 2. What user data is collected, stored, transmitted or logged?

### 2.1 Data inventory (verified from code)

| Data | Created when | Stored | Leaves the device? To whom | Logged | Evidence |
| --- | --- | --- | --- | --- | --- |
| Camera video frames | After **Enable camera** | Memory / GPU only | **No** | No | `gesture-store.ts:61–77`; egress capture shows no media upload [runtime] |
| Hand landmarks / gesture features | While tracking | Memory only | **No**. Only the resulting ON/OFF command goes to *your* backend | No | `camera-runtime.tsx:32` sends only `requestCommand(value, "gesture")` [code] |
| **MediaPipe usage telemetry** (SDK version, task type, latency counters) + IP, user agent, site origin | While tracking (first send about 60 s after start) | Not stored by the app | **Yes, to Google** `odml.pa.googleapis.com` | No | `audit/results/network_egress.txt` [runtime]; referrer limited to the origin by `next.config.ts:37` |
| Microphone audio | Only during **Listen** (≤ 8 s) or **Hands-free 60 s** | Not stored by the app | **Yes, by default to the browser vendor's speech service** (Chrome: Google, Safari: Apple), unless on-device recognition is enabled | No | `recognizer.ts:136–140` (`processLocally` only if opted in) [code]; vendor behaviour [vendor docs: MDN]; disclosed in `voice-panel.tsx:79–80` |
| Voice transcript (interim + final) | Returned by the browser's speech engine | Memory (`lastHeard`), overwritten each time; not persisted | **SE7ENX never sends it.** The vendor service that transcribed the audio necessarily has it | No | `voice-controller.ts:28, 63–64`; settings persist only preferences (`settings.ts:97`) [code] |
| Recognised command | After an allowlisted phrase | History in memory (`light-machine.ts:98–103`) | ON/OFF + `"voice"` to *your* bridge or HA | Bridge audit log (value, source) | `voice-controller.ts:71`; bridge schema allows only `requestId` + a fixed `source` list, extra fields refused (`api.py:75–76, 105–107`) [code] |
| Pairing code | Typed by the user | **Not stored** | Only to *your* bridge (`POST /pair` body `{code, clientName}`) | **Printed in the bridge log by design** | `client.ts:177–178`; `api.py:248–255` [code]; storage probe found no code stored [runtime] |
| Bridge session token (256-bit) | After pairing | Tab `sessionStorage` (`se7enx.bridge.session`) | Only to *your* bridge (`Authorization` header, `credentials: "omit"`) | No (session ID only, which is random and unrelated to the token) | `session.ts:21`; `client.ts:121, 132`; `security.py:160–163` [code]; storage probe [runtime] |
| Home Assistant access + refresh tokens | After HA sign-in | Tab `sessionStorage` (`se7enx.ha.tokens`) | Only to *your* HA (token endpoint + WebSocket) | No | `oauth.ts:81`; `ha-adapter.ts:75` [code] (SE7-01) |
| KNX configuration (bridge URL, HA URL, group addresses, DPT, ON level) | Wizard | **`localStorage`**, persistent (`se7enx.settings.v1`) | To *your* bridge (`PUT /lights/{id}`) or HA (`knx.send` `{address, payload}`) | Bridge audit log (addresses) | `settings.ts:32–35, 96–97`; `client.ts:214`; `ha-adapter.ts:236–239` [code] |
| Client name (e.g. "SE7ENX web · Chrome on Linux") | Pairing | Bridge memory | To *your* bridge | Bridge log | `api.py:454` [code]; captured in probe logs [runtime] |
| IP address | Every request | — | Vercel (hosting), your bridge, Google (telemetry, if the camera is used), speech vendor (if voice is used) | Bridge log on pairing; Vercel platform logs | `api.py:454` [code]; Vercel logging [vendor behaviour, not inspected] |
| Browser console output | Errors only | — | No | 3 calls, none with personal data or secrets | `hand-tracker.ts:34`, `adapters/types.ts:75`, `camera-runtime.tsx:140` [code] |

### 2.2 Direct answers

* **Camera footage:** does **not** leave the device. The only camera-related transmission is MediaPipe's usage telemetry, which contains no images [runtime].
* **Microphone audio:** **does** leave the device by default: the browser sends it to its vendor's speech service. SE7ENX itself never receives audio, and the UI says so accurately [code + vendor docs].
* **Voice transcripts:** SE7ENX does not transmit them anywhere. The vendor service produces them from the audio, so the vendor sees the content [code + vendor docs].
* **Gesture data:** does **not** leave the device; only ON/OFF commands go to your own bridge or HA [code + runtime].
* **Pairing code / access tokens:** sent **only** to the bridge or HA the user typed in. Never to Vercel or third parties [code; storage probe].
* **KNX configuration:** sent only to the user's own bridge or HA, and **persisted in `localStorage`** (visible to anyone with access to that browser profile) [code + runtime].
* **Vercel** receives ordinary page and asset requests only. The client never calls an SE7ENX API on Vercel [code: no client reference to `/api/health`].

---

## 3. Are camera and voice processed locally? Which APIs or services transmit data?

| Component | Local? | Third-party transmission | Evidence |
| --- | --- | --- | --- |
| Hand tracking (MediaPipe Tasks Vision 1.1.1, WASM + model self-hosted) | **Inference: yes** | **Usage telemetry to Google** (one 90-byte POST observed about 60 s into tracking; headers include `origin`, `referer`, `user-agent`, an API key header). Created only when the camera is enabled; **none observed during simulation-only use** | Egress capture: the only off-origin request in the whole run occurred during tracking [runtime] |
| Camera access (`getUserMedia`) | Yes | None by the app | Started only from the button (`gesture-store.ts:61`), secure context required (`:71`) [code] |
| Speech recognition (Web Speech API) | **Not by default** | Audio to the browser vendor's server-based engine; on-device only with `processLocally` (opt-in **Prefer on-device recognition (experimental)**) | `recognizer.ts:140` [code]; MDN: "by default … your audio is sent to a web service for recognition processing" [vendor docs]. **Not observed by us:** headless Chromium cannot run real recognition |
| Microphone permission check | Yes | None | Stream opened and its tracks stopped immediately (`voice-controller.ts:139–140`) [code] |
| Fonts, 3D assets | Yes (self-hosted `geist` fonts) | None | No off-origin font/asset requests in the capture [runtime] |
| Analytics / error reporting | n/a | None installed | `package.json` dependency list [code] |

**UI accuracy:** the voice panel's disclosure is accurate (`voice-panel.tsx:79–80`). The camera texts
("never uploaded", `gesture-panel.tsx:54–55`, `app-shell.tsx:104`, `layout.tsx:9`) are true for video
but **omit the telemetry** (SE7-03). Egress was measured in **Chromium only** [unverified for Safari/Firefox].

---

## 4. SE7ENX Bridge authentication and security

| Control | Implementation | Verified | Assessment |
| --- | --- | --- | --- |
| **Pairing code** | 8 chars from a 32-symbol alphabet via `secrets.choice` (40 bits) (`security.py:27–40`); single use, rotates every 15 min; constant-time compare (`:112`) | Unit tests; probes P01–P02 [runtime] | ✅ Strong for random codes. ⚠ Fixed codes are only format-checked (`config.py:164–171`): `AAAAAAAA` accepted (SE7-13). ⚠ The code is printed to the log (`api.py:248–255`), so log readers can pair |
| **Pairing brute force** | 5 attempts/min per source; 20 failures → **global** 5-min lock + rotation (`security.py:119–122`; limiter `api.py:232`) | P13, P14 [runtime] | ✅ Brute force infeasible. ⚠ Anyone who can reach the bridge can lock pairing for everyone; with `SE7ENX_TRUST_PROXY=true` the per-source limit is spoofable through the left-most `X-Forwarded-For` entry (`__main__.py:62–63`; uvicorn `proxy_headers.py:176–177`) (SE7-06) |
| **Token generation** | `secrets.token_urlsafe(32)` (256 bits) (`security.py:160`); stored only as SHA-256 (`:140–141, 164`) | Storage probe [runtime] | ✅ |
| **Token expiry and revocation** | Fixed expiry at creation, default 12 h, range 1–168 h (`security.py:167`; `config.py:173`); checked on every request (`:179`); **Disconnect** revokes (`api.py:472–476`) | Storage probe: 200 before, **401 after** Disconnect [runtime] | ✅ Server-side revocation works. ⚠ Only the token holder can revoke; no admin list/revoke; a bridge restart is the only way to evict others (SE7-04) |
| **Session cap** | Max 10; the oldest is silently evicted (`security.py:157–159`) | P06 [runtime] | ⚠ Anyone with a current code can evict legitimate clients (SE7-11) |
| **Origin validation** | Exact, case-insensitive allowlist; `*` and `null` refused at start-up (`config.py:145–147`); disallowed Origin → **403** before routing (`api.py:176–186`) | P02 + pytest [runtime] | ✅ Blocks drive-by websites (CSRF, LAN scanning). ⚠ Requests **without** `Origin` (non-browser clients) are allowed by design. ⚠ **The allowlist trusts every visitor of an allowed site** (see §7) |
| **CORS** | `Access-Control-Allow-Origin` reflected **only** for allowed origins, with `Vary: Origin` (`api.py:171–173, 211–214`); methods/headers fixed (`:140–141`); no credentials mode (token in header, `client.ts:132`); Private Network Access preflight answered (`:193–194`) | Header capture [runtime] | ✅ |
| **Host header / DNS rebinding** | No `Host` validation | Code review | ℹ A rebinding page can only issue Origin-less GETs, which reach `/api/v1/health` and `/` (name, version, API paths; `api.py:426–434, 751–753`). POSTs carry the attacker's Origin → 403; everything else needs a token (SE7-26, Informational) |
| **Group-address allowlist** | **Default deny** (`config.py:38`; `group_address.py:141–151`), enforced for writes, reads, status and test reads (`api.py:564, 588, 590, 623, 636`) | P17 + pytest [runtime] | ✅ ⚠ Accepts `*`, `x/y/*` and ranges with **no warning for broad patterns**; the only warning is for an empty list (`group_address.py:102–103, 133–134`; `api.py:308`) (SE7-24) |
| **Rate limiting** | Commands 6/10 s per session and 20/10 s per bridge; reads 10/10 s; discovery 2/10 s; connect 6/min (`api.py:232–237`) | P10 + pytest [runtime] | ⚠ `POST /knx/disconnect` is **not** limited (`api.py:514–517`) and any session may call it (SE7-04). No per-address minimum interval: 6 toggles in < 0.1 s observed (SE7-07) |
| **Command validation** | Pydantic `extra="forbid"` (`api.py:75–76`); `requestId` pattern and fixed `source` list (`:105–107`); DPT limited to 1.001/5.001, ON level 1–100 (`:98–102`); 16 KiB body cap, 411/413 (`:198–205`); idempotent retries (`:633`) | P11 + pytest [runtime] | ✅ |
| **Truthful confirmation** | Positive `L_Data.con` required; negative or missing → error (`knx.py:434–468`) | pytest + integration [runtime, fake interface only] | ✅ in code. ⚠ A stale cache can be shown as "Device confirmed" (`api.py:620–627`; `knx.py:372–379`) (SE7-02, **High**) |
| **Emergency stop** | **Stop hands-free** / `Esc` sets a client flag that blocks gesture and voice (`policy.ts:32`); manual control remains | e2e [runtime] | ⚠ **Client-side only**: other paired devices and a compromised client are unaffected; no bridge kill switch (SE7-07) |
| **Transport** | Plain HTTP unless `SE7ENX_TLS_CERT/KEY` or an HTTPS proxy (Tailscale Serve) is used; start-up warns for non-loopback binds but not about plaintext (`__main__.py:49–53`) | Config review | ⚠ Token and pairing code readable on the LAN over `http://` (SE7-05) |
| **Logging** | Pairing code (by design); client name (`%r`), IP, random session ID (`api.py:454`); audit lines with client name via `%s` (`:510, 516, 595, 641, 679`); rejected origins via `%r` (`:177`); **no tokens, no transcripts** | P07 [runtime] + code | ⚠ Client names can forge audit lines (SE7-12). Logs contain personal data (IP, device string) and the pairing code: restrict who can read them |
| **Process hardening** | systemd: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateDevices`, empty capability set (`se7enx-bridge.service:19–31`); compose: `read_only`, `cap_drop: ALL`, `no-new-privileges` (`docker-compose.yml:15–18`); container runs non-root (`Dockerfile:11, 17`) | Config review | ✅ ⚠ The Docker image binds `0.0.0.0` (`Dockerfile:8`) with host networking (SE7-15) |

---

## 5. Vercel deployment configuration

| Area | Finding | Evidence |
| --- | --- | --- |
| `vercel.json` | **Not present**; nothing hidden in platform config | [code] |
| API routes | Only `GET /api/health`; `/api`, `/api/v1/pair`, `/docs`, `/.env` and traversal attempts → 404 | [runtime] |
| Rewrites | `/demo-bridge/:path*` → `SE7ENX_DEV_BRIDGE_REWRITE` **whenever the variable is set at build time, in any environment** (`next.config.ts:54–62`); absent in a default build (404, not in the routes manifest) | [code + runtime] (SE7-10) |
| Security headers | CSP (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic self; geolocation, payment, usb, serial off), COOP `same-origin`; `poweredByHeader: false` | `next.config.ts:19–44, 58` [code]; captured [runtime] |
| CSP weaknesses | `script-src 'unsafe-inline'` (`:21`) and `connect-src https: wss: http: ws:` (`:26`). Any injected script could run and send data anywhere | SE7-09 |
| HTTPS / HSTS | The app sends no HSTS header [runtime]. **Vercel applies HSTS automatically** on `*.vercel.app` (`max-age=63072000; includeSubDomains; preload`) and on custom domains | [vendor docs]; not checked on a live deployment |
| Environment variables | Six optional, none secret: `NEXT_PUBLIC_DEFAULT_BRIDGE_URL`, `NEXT_PUBLIC_HAND_MODEL_URL`, `NEXT_PUBLIC_MEDIAPIPE_WASM_BASE` (inlined into the client bundle; must never hold secrets), `SE7ENX_FRAME_ANCESTORS`, `SE7ENX_ALLOWED_DEV_ORIGINS` (dev server only), `SE7ENX_DEV_BRIDGE_REWRITE` (demo only) | `grep process.env` over `next.config.ts`, `src`, `scripts` [code] |
| Image optimisation / source maps | No `images.remotePatterns` (no open image proxy); browser source maps not enabled | `next.config.ts` [code] |
| Preview deployments | Vercel's default "Standard Protection" puts **preview and generated deployment URLs** behind Vercel Authentication; the **production domain stays public** | [vendor docs]; check your project's *Settings → Deployment Protection* |

**Risks from exposing the local Bridge to the internet.** Port forwarding, Tailscale **Funnel**
(unlike Serve), a Cloudflare Tunnel without an access policy, or the demo rewrite pointed at a
reachable bridge all make the bridge internet-facing. The Origin allowlist does **not** protect you
here, because your public site's origin is allowed and anyone can load it. What remains is the
pairing code, the rate limits and the global lockout. Brute force stays infeasible, but anyone on the
internet could then block pairing at will. A weak or leaked fixed code would give control of every
allowlisted address. Any future bridge vulnerability would also be internet-exploitable. **Keep the
bridge LAN/tailnet-only** (docs: `bridge/README.md` "Reaching the bridge", `bridge/.env.example:6` "NEVER
port-forward it").

---

## 6. Secrets, logs, insecure defaults, dependencies, environment differences

**Secrets.** `detect-secrets` over tracked files found only false positives. A git-history pattern
search and a client-bundle scan (2.4 MB) found no credentials. Only `.env.example` files were ever
committed [runtime, 2026-10-15; code unchanged since]. KNX Secure secrets are `repr=False` and masked
as `***` in `check-config` (`config.py:49–53, 73–92`) [code].

**Sensitive data in logs.** See §4 "Logging". Web app: nothing sensitive. Bridge: pairing code, IP
addresses, client names, group addresses and commands. Vercel: platform request logs (IP, user agent,
path).

**Defaults**

| Default | Safe? | Evidence |
| --- | --- | --- |
| Bridge binds `127.0.0.1` (pip/systemd) | ✅ | `config.py` defaults; P17 |
| Docker image binds `0.0.0.0` with host networking | ⚠ SE7-15 | `Dockerfile:8`; `docker-compose.yml:10` |
| GA allowlist empty = deny all | ✅ | `config.py:38`; `api.py:308` warns |
| `.env.example` ships `0/0/1,0/0/2` as allowed addresses and keeps `http://localhost:3000` as an allowed origin | ⚠ SE7-25 | `bridge/.env.example:12, 33` |
| Random rotating pairing codes | ✅ | `bridge/.env.example:25` (commented out) |
| Gateway override off; default CIDRs include `169.254.0.0/16` | ✅ / ⚠ SE7-14 | `config.py:20` |
| Interface discovery on for paired clients | ℹ reveals LAN KNX interfaces to any paired session | `bridge/.env.example:64` |
| API docs off; `server` header off | ✅ | `__main__.py:64` |
| Web: frame embedding denied, camera/mic only on click | ✅ | `next.config.ts:17, 43`; `gesture-store.ts:61` |

**Dependencies (2026-10-16).** npm production tree: **0** vulnerabilities (167 packages). Full tree:
5 "high" entries, all GHSA-vfj7-8cjw-p6xm (`braces`, dev-only lint tooling, no patched version;
accepted, SE7-17). Bridge: `pip-audit` reports **no known vulnerabilities**, but versions are
unpinned and the Docker base image is referenced by tag, not digest (SE7-16).

**Development vs preview vs production**

| Aspect | Development | Vercel preview | Vercel production |
| --- | --- | --- | --- |
| CSP | Adds `'unsafe-eval'` (`next.config.ts:16, 21`) | Production CSP | Production CSP |
| `allowedDevOrigins` | From `SE7ENX_ALLOWED_DEV_ORIGINS` | Ignored | Ignored |
| Demo rewrite | If the variable is set | **If the variable is set for Preview** | **If the variable is set for Production** (SE7-10) |
| Access | Local | Behind Vercel Authentication by default [vendor docs] | Public |
| HSTS | None | Vercel platform [vendor docs] | Vercel platform [vendor docs] |
| Bridge | `dev_stack.py`: fake KNX only, fixed demo code, uvicorn `server` header (`:36, 41, 60–61`) | Your bridge config | Your bridge config |
| `NEXT_PUBLIC_*` | Inlined at build | Inlined per environment | Inlined per environment |

---

## 7. Can a visitor of your public website control your real KNX devices?

**Key design fact:** the bridge's Origin allowlist is *not* user authentication. If your public site
is in `SE7ENX_ALLOWED_ORIGINS`, **every visitor's browser counts as an allowed origin**. What
actually protects your devices is (1) the bridge being unreachable from outside your LAN/tailnet,
(2) the pairing code and tokens, and (3) the group-address allowlist.

| # | Scenario | Possible today? | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| S1 | Random visitor uses the public simulation site | **No.** The site holds no credentials, does not proxy to your LAN and has no server state | None | — |
| S2 | Visitor tries to reach your bridge from the internet | **No**, unless you exposed it (port forward, Funnel, open tunnel, demo rewrite) | — | Keep it LAN/tailnet-only; never set the rewrite on Vercel |
| S3 | Bridge exposed + attacker guesses the pairing code | Random code: **infeasible** (40 bits, 20 failures → lock). Weak/leaked fixed code: **yes** | Pairing DoS; with a known code, control of allowlisted addresses | Random codes; do not expose the bridge (SE7-06, SE7-13) |
| S4 | Malicious website opened in your browser (CSRF, LAN scanning, DNS rebinding) | **No.** Foreign Origin → 403 (P02); rebinding reaches only `/health` | Version disclosure | Already mitigated (SE7-26: optional Host check) |
| S5 | Someone on your Wi-Fi (guest, compromised IoT device) | **Partly.** Over `http://` they can sniff the token or pairing code and replay it; they can lock pairing | Control of allowlisted addresses up to 12 h | HTTPS to the bridge (Tailscale Serve/mkcert), separate guest network (SE7-05) |
| S6 | Your Vercel/GitHub account or an npm dependency is compromised | **Yes, in principle.** Attacker code runs on your allowed origin and can read tokens from connected browsers, including yours | Control of your allowlisted lights; with HA, the whole HA instance (SE7-01) | 2FA on Vercel and GitHub, protected branches, `npm ci` from the lockfile, nonce-based CSP (SE7-09), a **separate private origin** for real control |
| S7 | Someone who once paired (guest, ex-housemate) | **Yes**, until the token expires (≤ 12 h) or the bridge restarts; they can also cut the KNX link for everyone | Control of allowlisted addresses; disruption | Short session TTL, restart to evict, roles (SE7-04) |
| S8 | Allowlist set to `*` or a wide range | **Yes**, for any paired session or stolen token | Every KNX address on the bus (blinds, heating, door openers) | Allowlist only the light's two addresses (SE7-24) |
| S9 | Demo rewrite set on a public or preview deployment that can reach your bridge | **Yes**: the bridge becomes reachable through your site by anyone (previews are behind Vercel Authentication by default; production is public) | As S3 | Never set `SE7ENX_DEV_BRIDGE_REWRITE` on Vercel (SE7-10) |

---

## 8. What has actually been tested, and what remains unverified?

Passing tests prove the code does what the tests assert. **They do not prove security, and the fake
KNX interface does not prove real-hardware behaviour.**

| Area | How it was checked | Status |
| --- | --- | --- |
| Lint, types, unit/integration (Vitest 185/185), bridge (pytest 98/98), browser e2e (Playwright 24 passed, 1 intentional skip) | Automated suites on this code (2026-10-15; app code unchanged since) | Passed: functional evidence only |
| Bridge auth, origin, isolation, abuse cases | 17 probes against the real bridge code + fake interface (`audit/bridge_probes.py`) | 6 controls pass; 10 weaknesses confirmed; 1 measurement |
| Browser storage and token revocation | Real Chromium + real bridge (`audit/storage-and-revocation.mjs`) | Verified |
| Network egress / telemetry | Real Chromium with a fake camera (`audit/network-egress.mjs`) | Verified **for Chromium only** |
| Security headers, routes, rewrite absence | `next start` locally (2026-10-16) | Verified locally; **not on Vercel** |
| Dependencies | `npm audit`, `pip-audit` (2026-10-16) | Verified against advisory databases |
| HSTS and Deployment Protection on Vercel | Vercel documentation | **[vendor docs]**, not verified on your project |
| Speech audio sent to Google/Apple | MDN documentation | **[vendor docs]**, not observed (headless Chromium cannot run real recognition) |
| Real KNX interface, actuators, KNX Secure, TCP, routing | — | **Unverified** |
| Real Home Assistant OAuth and token revocation | Mock HA server only | **Unverified** |
| Safari, Firefox, iOS, Android hardware | — | **Unverified** |
| Real camera with a real hand; real speech services | Fake camera / scripted recogniser | **Unverified** |
| Penetration test, fuzzing | — | **Not performed** |

---

## 9. Is it safe to share the public link?

**Simulation-only demo (scenario A): yes, with the conditions in §11.** Friends, recruiters and
potential users can open the site, play with the 3D lamp, and try gestures and voice on the simulated
lamp. Nothing they do can reach your home. Tell them in one sentence that the camera feature sends
anonymous usage statistics to Google (no video), and that voice uses their browser's speech service.

**Website connected to real hardware (scenario B): do not share.** Sharing gives others nothing they
can legitimately use: they cannot reach your bridge, and they should not. What sharing *does* create
is risk from the scenarios in §7.

*Narrow exception for your own private use:* run real control from a **separate origin** that is not
the public demo. Options are `localhost`, a second Vercel project, or a branch deployment URL kept
behind Vercel Authentication. List **only** that origin in `SE7ENX_ALLOWED_ORIGINS`, keep the bridge
on LAN/tailnet with HTTPS, use random pairing codes, and allowlist only your light's two addresses.
Even then, treat SE7-02 (stale "Device confirmed") with caution and watch the light.

**Production real-hardware control (scenario C): not until the P1/P2 items in §11 are done** and the
hardware and HA validation plans in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) have been executed.

---

## 10. Findings relevant to this review

Severity uses OWASP likelihood × impact, with impact raised one level when a flaw can cause
unintended physical actuation or a false belief about a device's state (⚡). Full details and
proposed fixes: [SECURITY_AUDIT.md](SECURITY_AUDIT.md#4-findings-register).

| ID | Severity | Finding | Practical impact | Affects |
| --- | --- | --- | --- | --- |
| SE7-01 | **High** | Full-rights HA access + refresh tokens (≤ 90 days) in `sessionStorage` (`oauth.ts:81`); the wizard recommends an HA admin | Any script on the site, or a person at a shared browser, can take over the user's Home Assistant | B, C (HA path) |
| SE7-02 | **High** ⚡ | Cached state returned as current after a read timeout or reconnect (`api.py:620–627`; `knx.py:372–379`) | UI can say "Device confirmed" when it is not true | B, C |
| SE7-03 | Medium | MediaPipe usage telemetry to Google; camera texts omit it | Undisclosed third-party transfer (IP, user agent, origin) | **A**, B, C |
| SE7-04 | Medium | No roles or admin revocation; unthrottled shared `disconnect` (`api.py:514–517`) | Ex-guests keep control ≤ 12 h; anyone paired can cut the link | B, C |
| SE7-05 | Medium | Plain HTTP to the bridge by default | Token and pairing code readable on the LAN | B, C |
| SE7-06 | Medium | Global pairing lockout; spoofable source with `SE7ENX_TRUST_PROXY=true` | Pairing DoS; misleading logs | B, C |
| SE7-07 | Medium ⚡ | Emergency stop is client-only; no per-address interval | Stop does not affect other devices or a compromised client | B, C |
| SE7-08 | Medium ⚡ | No group-address allowlist on the HA path | A typo can switch another device | B, C (HA path) |
| SE7-09 | Medium | CSP allows inline scripts and connections to any host | Amplifies any future XSS or supply-chain compromise (S6) | **A**, B, C |
| SE7-10 | Medium | Demo rewrite works in any environment, with no production guard | Can expose your bridge through your public site | **A**, B |
| SE7-11 | Low | Silent eviction at the 10-session cap | Legitimate clients kicked out | B, C |
| SE7-12 | Low | Audit-log injection via client name | Forged log lines | B, C |
| SE7-13 | Low | Weak fixed pairing codes accepted; codes in logs | Guessable or leaked code | B, C |
| SE7-14 | Low | Link-local range in default gateway-override CIDRs (override off by default) | Limited probing if enabled | B, C |
| SE7-15 | Low | Docker binds `0.0.0.0` | Bridge listens on every host interface | B, C |
| SE7-16 | Low | Bridge dependencies and base image unpinned | Supply-chain drift | B, C |
| SE7-17 | Info | Dev-only `braces` advisory | None in shipped code | — |
| SE7-19 | Info | Bridge version disclosed by `/health` | Fingerprinting | B, C |
| SE7-20 | Info | `NEXT_PUBLIC_HAND_MODEL_URL` override not integrity-checked at runtime | Only if you set it | A |
| SE7-21 | Low (suspected) | HA confirmation may match a foreign write | Rare false confirmation | B, C |
| SE7-22 | Info | No real hardware, HA, Safari/Firefox or Vercel validation | Unknown real-world behaviour | B, C |
| SE7-23 | Info | Home network topology persisted in `localStorage` | Visible to anyone with the browser profile | A, B |
| **SE7-24** | **Low** (new) | Allowlist accepts `*` and wide patterns without warning (`group_address.py:102–103, 133–134`; warning only for empty lists, `api.py:308`) | One config line exposes the whole KNX bus to any paired session or stolen token | B, C |
| **SE7-25** | **Info** (new) | `bridge/.env.example` ships live-looking values: allowlist `0/0/1,0/0/2` (`:33`), dev origin `http://localhost:3000` (`:12`); suggests `TRUST_PROXY` for Cloudflare Tunnel without the SE7-06 caveat (`:18`) | Copy-paste can allow the wrong addresses or keep a dev origin | B, C |
| **SE7-26** | **Info** (new) | No `Host` header validation | DNS rebinding reaches only unauthenticated `/health` and `/` (name, version, paths) | B, C |

SE7-18 (inaccurate docs) was fixed in the previous change set, except one remaining line:
`docs/API.md:69` still says "5/min per client" without the proxy and global-lockout caveats.

---

## 11. Prioritised remediation checklist

**Before sharing the simulation demo (A)**
- [ ] Do **not** set `SE7ENX_DEV_BRIDGE_REWRITE` in any Vercel environment (Production, Preview, Development). *(SE7-10, config, 1 min)*
- [ ] Add a short privacy note (README and/or site footer) disclosing the MediaPipe telemetry to Google (no images) and the browser speech services, **or** block the telemetry before promoting the camera feature. *(SE7-03, S–M)*
- [ ] Enable 2FA on your Vercel and GitHub accounts; protect the `main` branch; keep Vercel's preview Deployment Protection on. *(S6, config)*
- [ ] Do **not** list the public demo's origin in any real bridge's `SE7ENX_ALLOWED_ORIGINS`. *(§7, config)*
- [ ] Label the Home Assistant and bridge paths "experimental" wherever you share the link. *(S)*
- [ ] Recommended: nonce-based CSP without `'unsafe-inline'`. *(SE7-09, M)*

**Before connecting real hardware, even privately (B)**
- [ ] Separate private origin for real control (localhost, a second project, or a protected branch URL). *(§9, config)*
- [ ] Bridge reachable only over HTTPS on LAN/tailnet (Tailscale **Serve**, never Funnel; mkcert); no port forwarding; Docker `SE7ENX_HOST=127.0.0.1`. *(SE7-05, SE7-15, config)*
- [ ] `SE7ENX_ALLOWED_GROUP_ADDRESSES` = exactly the light's switching + status addresses (never `*`). *(SE7-24, config)*
- [ ] Leave `SE7ENX_PAIRING_CODE` unset; restrict log access; keep `SE7ENX_TRUST_PROXY=false`; remove `http://localhost:3000` from production origins. *(SE7-13, SE7-06, SE7-25, config)*
- [ ] HA path only with a dedicated **non-admin** HA user, and double-check the group address. *(SE7-01, SE7-08, config)*
- [ ] Fix the stale-state behaviour, or physically verify the light after any reconnect. *(SE7-02, M)*

**Before production use with physical devices (C)**
- [ ] Code fixes: SE7-02 stale state · SE7-04 roles + admin revocation + throttled disconnect · SE7-07 bridge kill switch + per-address interval · SE7-05 TLS by default · SE7-01 memory-only HA tokens (or agent-held credentials) · SE7-08 HA address confirmation · SE7-12 log sanitisation · SE7-13 code strength · SE7-24 warning or refusal for broad patterns · SE7-16 hashed lock file + pinned base image. *(M–L)*
- [ ] Execute the hardware (H1–H18) and Home Assistant (A1–A8) validation plans in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md); test Safari, Firefox and mobile.
- [ ] Add regression tests for every confirmed finding, plus egress and header tests in CI.
- [ ] Monitoring, an update path for installed bridges, an incident-response contact, and an external penetration test.

---

## 12. Final verdicts

* **A. Public simulation demo on Vercel: YES WITH CONDITIONS.** No credentials, no server-side
  data, no path to anyone's hardware; current framework versions; solid headers. Conditions: no demo
  rewrite, telemetry disclosed or blocked, accounts secured, public origin never trusted by a real bridge.
* **B. Public website with the real Bridge connected: NO.** The bridge has no user roles, a
  client-only emergency stop, plain HTTP by default, and stale-state confirmation. The allowlist
  trusts every visitor of an allowed site, and a site or supply-chain compromise would reach
  connected users' tokens. Private, single-owner use is acceptable only under the §9 exception.
* **C. Real KNX hardware control in production: NO.** Two High findings are open (SE7-01, SE7-02),
  safety controls are client-side, and nothing has been validated on real KNX hardware or a real
  Home Assistant.

### Would I recommend deploying and sharing this project today?

**YES WITH CONDITIONS, as a simulation-only demo.** The verified facts support it: the public
deployment exposes nothing that can reach hardware, holds no secrets or user data, runs patched
framework versions, and sends strong security headers. The conditions are not optional. Disclose
(or block) the Google telemetry before people use the camera. Never set the demo rewrite on Vercel.
Secure your Vercel and GitHub accounts. Keep any real bridge from trusting the public demo's origin.

**For anything that controls real hardware, my answer is NO today.** The weaknesses that matter
there (stale "confirmed" state, full-rights HA tokens in the browser, no roles, a client-only stop,
plaintext transport) are confirmed in code and by runtime probes. None of the real-world paths has
been verified on actual KNX hardware or a real Home Assistant.
