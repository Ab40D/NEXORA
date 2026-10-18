# SE7ENX — Engineering Log

Short, factual entries: what was done, what was decided, what was verified, and what is still open.
Test numbers are only recorded when the suite was actually run.

## 2026-10-18

### Closed: dev-stack bridge URL (commit `2b935f0`)
- Cause of "Cannot reach the SE7ENX Bridge at http://127.0.0.1:57096": the dev stack printed only
  the fake KNX interface's random UDP port. It now prints the real **Bridge URL** banner.
- Verified: vitest 238 ✓, pytest 138 ✓, ruff/eslint/tsc ✓, `next build` ✓, Playwright
  `knx-bridge.spec.ts` 5/5 ✓.

### Phase 1: discovery and foundation decisions
- Inspected repository: web ~16.4k lines TS/TSX, hub ~6.2k lines Python, tests ~5.5k lines,
  docs ~3.6k lines. Working features and debt listed in
  [RESEARCH_AND_DECISIONS.md §1](RESEARCH_AND_DECISIONS.md#1-starting-point-repository-inspection-2026-10-18).
- Online research covered:
  - products: Home Assistant, openHAB, Node-RED, OpenRemote, ThingsBoard, VOLTTRON, ComfortClick;
  - building models: Brick, Haystack, WoT TD, Matter;
  - protocol libraries: aiomqtt, pymodbus, BACpypes3, asyncua;
  - security guidance: OWASP password storage and session management, NIST 800-63B-4;
  - AI and gestures: Ollama, MediaPipe gestures.
- Decisions D-01…D-10 recorded. Notable findings:
  - ThingsBoard ≥ 4.4 is BUSL-1.1;
  - python-matter-server is archived in favour of matter.js;
  - local-first intents with an LLM fallback is prior art (Home Assistant);
  - OWASP advises against storing tokens in Web Storage, so the appliance moves to HttpOnly
    cookies.
- Innovation backlog: 15 ideas scored; I-01 (evidence ledger) selected for M1.
- Roadmap M1–M8 written.

### M1 — in progress
- Next: SQLite core store → identity/RBAC → building model → audit ledger → API → UI → tests.

### M1 — done (2026-10-18)
- Backend (commit `599509a`):
  - Core modules `db`, `passwords`, `identity`, `rbac`, `audit`, `building_model`, `building`;
  - HTTP modules `auth.py`, `api_auth.py`, `api_building.py`;
  - permissions on every existing route; CLI recovery.
- Web:
  - typed contracts (`src/lib/core/contract.ts`); `BridgeClient` cookie mode plus the Core methods;
  - stores `useAuth` and the hub store in cookie mode;
  - components: auth gate, forms, account menu, guest banner; Building, Activity and Settings (users, invitations,
    roles) workspaces;
  - 265 new dictionary strings in each of EN/FR/AR/DZ (counted from the diff).
- Decisions during implementation:
  - The per-IP sign-in limit counts **failures only**. Counting successes would lock out whole offices behind a
    reverse proxy; the issue surfaced while re-running the appliance suite.
  - The account language preference is applied on sign-in.
  - The `no-cors` reachability probe was rejected: the hub's CORP header blocks it.
- Visual review (Playwright screenshots, EN/AR/DZ) found and fixed two bugs:
  - the tab bar squeezed its labels with 10 tabs; it now scrolls without shrinking;
  - the room-placement select overflowed room cards.
- Test stability: `test_shelly_unreachable_device_goes_offline` had a pre-existing poll race that shows up under CPU
  load. It now accepts both truthful 503 codes; the HTTP-error mapping stays covered by the identify test.
- Verified on the final code:
  - pytest **181 passed**; ruff clean; vitest **238 passed**; tsc and eslint clean;
  - Playwright **34 passed / 1 skipped** (known mobile keyboard skip);
  - appliance suite against a real hub serving the static UI: **4/4**, twice in a row.
- Not verified: real hardware (KNX/Shelly/HA, unchanged since Phase E); Docker image rebuild with `argon2-cffi`
  (pinned in `constraints.txt`, wheels exist for x86-64/arm64, but not built in this session); TOTP MFA (planned).
