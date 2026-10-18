# SE7ENX — Roadmap

From a single-light experience to a **human-native, protocol-agnostic Building Operating System**.
Milestones are ordered by real dependencies. The application stays runnable and tested after every
milestone. Status reflects **verified** work only (see [ENGINEERING_LOG.md](ENGINEERING_LOG.md)).

Legend: ✅ done & tested · 🟡 in progress · ⬜ planned · 🧪 simulator-tested only.

## M0 — Smart Light Experience (done: phases A–E)

✅ Next.js app, 3D Digital Twin lamp/room, gestures (MediaPipe), voice, Talk to SE7ENX (local
intents + optional LLM), EN/FR/AR/Darija with RTL · ✅ hub with KNX/IP (xknx), Shelly Gen1/Gen2+, Home
Assistant (server-side), simulated devices, safety stop, first-test gate, Docker appliance ·
🧪 all real-hardware paths verified against protocol-level fakes only.

## M1 — Foundation: identity, building model, ledger (current)

| Deliverable | Acceptance test | Status |
| --- | --- | --- |
| Research & decision record, innovation backlog, roadmap, engineering log | Docs exist with sources and dates | ✅ |
| SQLite core store (migrations, WAL) | pytest: migrations idempotent, persistence across restart | 🟡 |
| Users, Argon2id, NIST password rules, first-run owner setup with console code | pytest + e2e: owner setup, login, logout, wrong password generic error, lockout | 🟡 |
| Persistent sessions: HttpOnly SameSite cookie (same-origin) / bearer (cross-origin), idle + absolute timeout, revoke, list | pytest: cookie flags, CSRF origin check, expiry, revoke | 🟡 |
| Roles + server-enforced permission matrix (configurable, owner fixed) on **every** hub route | pytest: each role × route; unauthorized command blocked (403) and audited | 🟡 |
| Invites/registration, admin user management, one-time reset codes, CLI recovery | pytest + e2e | 🟡 |
| Building model (sites, buildings, floors, rooms, zones) + device placement | pytest + e2e: create building, add rooms, assign device | 🟡 |
| Audit ledger (I-01) with retention | pytest: commands/config/auth events recorded without secrets | 🟡 |
| UI: onboarding, sign-in, account, users, building & rooms views, guest mode banner | Playwright appliance suite | 🟡 |

## M2 — Building operations UX

⬜ Workspace navigation (Home, Rooms, Devices, Experience, Talk, Automations, Studio, Activity,
Settings) · ⬜ monochrome design system + light/dark themes · ⬜ capability-driven tiles (lights,
covers, HVAC/thermostats, sensors, energy) · ⬜ search/filter/saved views · ⬜ notifications & alarms ·
⬜ room-scoped, time-boxed access (I-15) · ⬜ health page.

## M3 — Automation engine

⬜ Scenes, schedules (incl. sun events), rules (triggers/conditions/actions) · ⬜ compiler/validator
against the capability registry (I-03) · ⬜ dry-run sandbox on the simulated twin · ⬜ execution
traces, partial-failure reporting · ⬜ "Why?" explainer (I-02).

## M4 — Integration SDK and new protocols

⬜ Capability contract v2 (properties/actions/events) + adapter SDK docs · ⬜ conformance kit (I-05) ·
⬜ MQTT (aiomqtt) + simulator · ⬜ Modbus TCP (pymodbus) + simulator · ⬜ BACnet/IP (BACpypes3) 🧪 ·
⬜ ESPHome native API · Matter via Home Assistant (today), matterjs-server adapter later.

## M5 — Intelligence

⬜ Assistant over the building model (rooms, zones, scenes, "all lights on the first floor") with
clarification · ⬜ evidence-graded explanations · ⬜ maintenance report (I-12) · ⬜ LLM tool calls
validated against capabilities (I-11), local engine fallback.

## M6 — Gestures, Guide Character, companion chatbot

⬜ Gesture profiles with safety envelope (I-08) · ⬜ original SE7ENX Guide Character with contextual
tours on the real building (I-06) · ⬜ Professional / Friendly / Playful personalities, respectful login
encouragement, multilingual tutorials.

## M7 — Engineering Studio

⬜ 2D floor plans + device placement (3D twin where useful) · ⬜ address/point mapping inspector ·
⬜ ETS/HA semantic import (I-13) · ⬜ change sets + approvals (I-10) · ⬜ expected-vs-observed (I-04) ·
⬜ templates · ⬜ Brick/Haystack export.

## M8 — Validation and delivery

⬜ Benchmarks (CPU/RAM/startup on x86-64 and ARM64) → hardware recommendations · ⬜ real-hardware test
campaign (KNX, Shelly, HA) · ⬜ documentation set · ⬜ security review update · ⬜ delivery report.
