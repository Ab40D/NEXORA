# SE7ENX Smart Light Experience — Implementation report

Date: 2026-10-15 · Web app 1.0.0 · Bridge 1.0.0 · API contract v1

## 1. What was delivered

| Deliverable | Location |
| --- | --- |
| Responsive web app (Next.js 16.4, React 19.3, TypeScript 5.9, Tailwind 4, Radix UI, R3F/Three/Drei, MediaPipe Tasks Vision, Web Speech API, zod, zustand) | `src/` |
| Simulation, 3D lamp (+ SVG fallback), gestures, voice, manual control, emergency stop, history | `src/components`, `src/lib` |
| 7-step connection wizard (Simulation / Home Assistant / Local KNX Bridge) | `src/components/wizard/connection-wizard.tsx` |
| Home Assistant adapter (OAuth with state nonce, WebSocket, `knx.send`/`knx.read`/`knx_event`) | `src/lib/ha`, `src/lib/adapters/ha-adapter.ts` |
| **SE7ENX Bridge** — FastAPI + **xknx 4.0** (tunnelling UDP/TCP/Secure, routing, discovery) | `bridge/` |
| Protocol-level fake KNXnet/IP interface + one-process demo stack (testing only) | `bridge/tools/` |
| Integration contract, architecture, security docs | `docs/` |
| `.env.example` (web, no secrets) · `bridge/.env.example` · Dockerfile · docker-compose · systemd unit | repo |
| Tests: Vitest (unit + integration + contract), pytest, Playwright | `tests/`, `bridge/tests/` |

The repository was empty at the start; everything here is new (7 commits on `main`).

## 2. Key decisions

1. **Split architecture.** Vercel serves only the UI and `GET /api/health`. Real KNX goes
   browser → bridge on the LAN (or → Home Assistant) → KNX. Serverless functions cannot
   reach private networks, send KNXnet/IP UDP or keep tunnels; browsers cannot send raw UDP.
   The brief's example `/api/knx/*` routes are therefore served **by the bridge** (mapping in
   `docs/API.md`), not by Vercel.
2. **xknx 4.0** for the bridge (maintained, powers Home Assistant's KNX integration, supports
   every KNXnet/IP connection type incl. KNX Secure). Confirmation tracking hooks the CEMI layer:
   xknx waits for `L_Data.con` but does not check its confirm bit, so a `ConfirmingCEMIHandler`
   subclass records it — negative confirmations become errors, never successes.
3. **Truthful state model.** Simulated / requested / reported state are separate reducer fields.
   "bus_confirmed" (interface confirmed transmission) is distinct from device state (status
   address or read response). Without feedback the lamp shows `UNVERIFIED`.
4. **Bridge auth = pairing code from the bridge console → short-lived Bearer session.** Header
   tokens (no cookies → no CSRF), exact origin allowlist, default-deny group-address policy,
   rate limits, idempotent request ids, audit log. Bridge binds to loopback by default.
5. **Home Assistant via HA's own OAuth** (no long-lived token typed into the app). The library's
   OAuth `state` is not a nonce, so SE7ENX generates and verifies its own. Verified against the
   current HA source: `/auth/token` allows CORS from any origin; `knx.event_register` is
   admin-only; `knx.read` can return the response payload (2 s timeout).
6. **Events over fetch-based SSE**, not WebSocket/EventSource: allows the `Authorization`
   header and Chrome's Local Network Access mixed-content exemption (`targetAddressSpace`) for
   `http://` LAN/loopback bridges; WebSockets get no such exemption.
7. **Gesture inference on the device**: self-hosted MediaPipe WASM + checksum-verified model; debounced
   engine (hysteresis, EMA, dwell, cooldown, re-arm, confidence gating, frame-gap reset). Frames and
   landmarks never leave the browser. *Correction (audit 2026-10-15):* this was originally called
   "fully local", but the MediaPipe Tasks Vision library sends usage telemetry (no images) to Google.
   See [SECURITY_AUDIT.md](SECURITY_AUDIT.md), finding SE7-03.
8. **Voice = exact allowlist** (EN/FR/AR incl. Algerian Darija) after normalization; negations
   and long utterances rejected; push-to-talk or explicit 60 s session; never continuous by default.

## 3. Requirement coverage (summary)

| Area | Status |
| --- | --- |
| Opens in simulation with interactive 3D lamp; mode always visible; simulation never presented as real | ✅ (badges, stripes, labels; e2e-tested) |
| Wizard: mode → backend/auth → connectivity test → GA + DPT → optional status GA → warned test command → control | ✅ (no irrelevant fields; e2e-tested with the real bridge) |
| GA validation (3-level/2-level/free, ranges, broadcast refused), DPT 1.001 & 5.001 | ✅ browser + bridge, shared test vectors |
| Real GroupValueWrite / GroupValueRead, status feedback, timeouts, errors, disconnect/reconnect | ✅ bridge + HA adapters |
| Never reports success without backend confirmation | ✅ (outcome mapping tested at unit, integration, contract and e2e level) |
| Camera only after "Enable camera", local processing, preview with landmarks, pause, calibration, low-confidence → no inference | ✅ |
| Voice explicit enable, recognized text + status, unsupported/denied handling, allowlist, manual fallback | ✅ |
| Emergency stop blocking gesture & voice dispatch | ✅ header button + `Esc`; also stops listening |
| Security: HTTPS (Vercel), auth on all state changes, origin restriction, rate limits, validation, no secrets in frontend, no open proxy, default deny | ✅ see `docs/SECURITY.md` |
| Responsive, keyboard, visible focus, reduced motion, WebGL fallback, loading/denied/disconnected/error/reconnecting states | ✅ |

## 4. Verification results (all run in this environment)

| Check | Command | Result |
| --- | --- | --- |
| ESLint (Next core-web-vitals, TS, React Compiler rules) | `npm run lint` | **0 problems** |
| Type check | `npm run typecheck` | **0 errors** |
| Vitest unit + integration | `npm test` | **185 passed** (10 files) |
| ↳ unit | group address 43 · voice 41 · network/DPT/SSE 29 · gesture engine 18 · state machine 13 · dispatcher 9 · allowlist 8 | 161 |
| ↳ integration | bridge client/adapter vs mock bridge 12 · HA adapter vs mock HA WebSocket 11 · **contract: TS client ↔ real Python bridge ↔ fake KNXnet/IP over UDP** 1 | 24 |
| Production build | `npm run build` | **success** (`/` static, `/api/health` dynamic) |
| Bridge tests | `cd bridge && python -m pytest` | **98 passed** (API 20 · GA vectors + config 71 · security 7) |
| Bridge lint/format | `ruff check . && ruff format --check .` | **clean** |
| Browser tests (Chromium desktop + Pixel 7 emulation) | `npm run test:e2e` | **24 passed, 1 skipped** (keyboard test intentionally desktop-only) |
| Packaging | `pip install .` in a fresh venv; `se7enx-bridge --version / check-config / scan` | works; invalid config exits 2 |

Notable end-to-end facts observed: real xknx UDP tunnel to the fake interface; positive
`L_Data.con` → `bus_confirmed`; negative → `KNX_NEGATIVE_CONFIRMATION`; missing → 
`KNX_CONFIRMATION_TIMEOUT` after 3.0 s; status telegram pushed over SSE → lamp `ON · Device
confirmed`; idempotent retries send one telegram; foreign origins get 403; MediaPipe hand
tracking ran headless on Chromium's fake camera and correctly reported "No hand detected".

## 5. Not tested / hardware-dependent (honest list)

* **No physical KNX hardware** (interface, router, actuator) was available. The KNX path was
  verified with real xknx over real KNXnet/IP UDP tunnelling against a protocol-level fake
  interface. **Not verified on hardware:** TCP tunnelling, KNX Secure (tunnelling/routing),
  routing multicast, gateway discovery, tunnel-slot exhaustion, real actuator feedback timing.
* **No real Home Assistant instance.** The adapter was tested against a mock reproducing HA's
  WebSocket messages; behaviour was cross-checked against the current HA source. The full OAuth
  redirect round trip against a real HA login page was not executed.
* **Gestures with a real hand/camera** were not testable here (no camera/hand footage); the
  engine is unit-tested with synthetic landmark sequences and the MediaPipe pipeline was verified
  with Chromium's fake camera.
* **Real speech recognition services** were not used; voice e2e tests inject a deterministic
  fake `SpeechRecognition`. Chrome 156's experimental `SpeechRecognition.available()` crashed the
  headless renderer in this sandbox, so the on-device probe now runs only after the user opts in.
* **Browsers:** automated tests ran on Chromium only (WebGL via SwiftShader). Safari/iOS, Firefox,
  real Android devices and Chrome's Local Network Access permission prompt were not tested.
* **Vercel deployment** itself was not performed (no account access); production build and
  `next start` were verified locally. **Docker image build and the systemd unit** were not
  executed (no Docker/systemd in the sandbox).

## 6. Problems found and fixed during the build

* SSE through a compressing proxy (`next start` gzip) was buffered → bridge sends
  `Cache-Control: no-store, no-transform`; client detects a silent stream within 10 s and explains it.
* Starlette's `TestClient` buffers streaming responses → SSE tests run against a live uvicorn server.
* Event subscriptions were unhashable dataclasses → identity semantics.
* xknx does not distinguish negative `L_Data.con` → confirm-bit-aware CEMI handler.
* `home-assistant-js-websocket` OAuth `state` is not a nonce → own nonce handling.
* Chrome exposes unprefixed `SpeechRecognition`; experimental availability probe crashed headless
  Chrome → user-initiated only; test fakes replace both constructors.
* React Compiler lint errors on R3F mutations → mutations via refs / `useFrame` state.
* KNXnet/IP device-name field is 30 bytes → fake interface name shortened.
* Small-label contrast raised to WCAG AA (≥ 4.5:1); threshold sliders made proportional.

## 7. Limitations and next steps

* One light per wizard run; DPT 1.001/5.001 only; no dimming slider or scenes.
* Bridge sessions are in memory (re-pair after a bridge restart).
* Recommended next steps: hardware validation (checklist below), Safari/iOS + Firefox manual QA,
  optional HA entity-based control (`light.turn_on`) for non-admin installs, multi-light UI, PWA install.

### Hardware validation checklist (for the installer)

An extended plan with expected results (18 hardware tests, 8 Home Assistant tests, browser matrix)
is in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) §3–§5.

1. `se7enx-bridge scan` finds the interface; `check-config` shows the intended settings.
2. Bridge log shows `KNX connected` with the interface name and tunnel address.
3. Wizard connectivity test: all checks green; "Read current state" returns the actuator state.
4. Test ON/OFF: the light switches; the UI shows `bus_confirmed` and **Device confirmed** within ~1 s.
5. Unplug the interface's bus connection → command shows `KNX_CONFIRMATION_TIMEOUT` or
   `KNX_NEGATIVE_CONFIRMATION`, never success.
6. Operate the wall switch → the lamp follows via the status address.
7. Stop the bridge → UI shows `RECONNECTING`; restart → UI asks to pair again.
8. Gestures and voice on the target devices/browsers; emergency stop blocks both.

## 8. Demo previews

Temporary previews of this project used the **demo-only** same-origin rewrite
`SE7ENX_DEV_BRIDGE_REWRITE` (`/demo-bridge` → a bridge dev stack talking to the **fake** interface
`SE7ENX FAKE KNX (TEST ONLY)`, no real hardware). Previews are not part of the deliverable, and their
demo pairing codes are not valid anywhere. Never set this variable for a production deployment
(audit finding SE7-10).

## 9. Audit addendum (2026-10-15)

A separate evidence-based technical and security audit was performed after delivery:
[SECURITY_AUDIT.md](SECURITY_AUDIT.md). Application code was **not** changed by the audit; it
added documentation ([TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md),
[USER_GUIDE.md](USER_GUIDE.md), [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md), extended
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), corrected inaccurate privacy and security statements
in this report, the README and [docs/SECURITY.md](docs/SECURITY.md), and added reproducible
probes under [`audit/`](audit/README.md).

* **Re-verification:** lint 0 errors, typecheck 0 errors, Vitest 185/185, pytest 98/98, ruff
  clean, Playwright 24 passed / 1 skipped (intentional), production build OK.
* **Top findings:** HA tokens with full account rights in `sessionStorage` (SE7-01, High); stale
  cached state shown as "Device confirmed" (SE7-02, High); MediaPipe telemetry to Google (SE7-03);
  no bridge roles or admin revocation (SE7-04); plain-HTTP bridge default (SE7-05); client-only
  emergency stop (SE7-07).
* **Readiness:** local demo ready; controlled hardware test and public simulation demo ready
  with restrictions; real users with Home Assistant and production use **not ready**.
