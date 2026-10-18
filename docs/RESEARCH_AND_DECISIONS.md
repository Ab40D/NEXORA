# SE7ENX — Research and Engineering Decisions

Living document. Each entry records **what was checked, where, when, what we concluded and what we
decided**. Sources were accessed on **2026-10-18** unless stated otherwise. Products and projects
were studied as references only: no code, assets or proprietary material were copied.

Status legend: **Adopted** (implemented or being implemented) · **Planned** (on the roadmap) ·
**Rejected** (with reason) · **Open** (needs more evidence).

---

## 1. Starting point (repository inspection, 2026-10-18)

| Area | Found in the repository | Assessment |
| --- | --- | --- |
| Web app | Next.js 16 + React 19 + TypeScript, Tailwind 4, Radix primitives, zustand, Zod, R3F/Three (Digital Twin lamp + room), MediaPipe hand tracking, Web Speech, i18n (EN/FR/AR/Algerian Darija, RTL) — ~16k lines | Solid, tested. Single-page "tabs" shell centred on one light; no building model, no accounts |
| Hub ("SE7ENX Bridge") | Python 3.11+, FastAPI, xknx 4, Shelly Gen1/Gen2+, Home Assistant (server-side WebSocket), KNX device mapping, simulated devices, safety stop, per-device first-test gate, assistant intent validation, optional OpenAI-compatible LLM — ~6.2k lines | Good protocol core and safety model. Auth = console pairing code → **in-memory** bearer sessions (lost on restart), no users/roles |
| Persistence | `config.json` (devices, integrations; no secrets) + `secrets.json` (0600), atomic writes, `.bak` | Fine for configuration; unsuitable for users, sessions, audit/history |
| Tests | vitest 238, Playwright 33+2 new, appliance e2e 2, pytest 138, ruff/eslint/tsc clean | Strong base; must stay green |
| Deployment | Vercel (public demo, no LAN access) + Docker appliance (hub serves the static UI, same origin, non-root, read-only FS) | Keep both. The hub is the local-first **Core** |

**Decision D-01 (Adopted): evolve, don't rewrite.** The hub becomes the SE7ENX Core (modular
monolith); the web app becomes the multi-workspace client. Existing features (Smart Light
Experience, Talk to SE7ENX, gestures, Digital Twin, 4 languages, safety model) are preserved.

---

## 2. Competitive and prior-art landscape

| Product / project | License (verified) | Model & strengths | Gaps relevant to SE7ENX | What we take / avoid |
| --- | --- | --- | --- | --- |
| Home Assistant | Apache-2.0 | Device registry + entity registry; areas grouped into **floors**; **labels** across areas/devices/entities; automation targets can be entity, device, area, floor or label ([device registry](https://developers.home-assistant.io/docs/device_registry_index/), [area registry](https://developers.home-assistant.io/docs/area_registry_index/), [targets](https://www.home-assistant.io/docs/automation/targets/)). Automation **traces** show "Triggered by" and the path taken ([troubleshooting](https://www.home-assistant.io/docs/automation/troubleshooting/)). Assist matches local sentence templates first, LLM agents optional; "prefer handling commands locally" ([LLM API](https://developers.home-assistant.io/docs/core/llm/), [Voice ch. 11](https://www.home-assistant.io/blog/2025/10/22/voice-chapter-11/)) | Huge surface, YAML/Jinja learning curve; explanations are traces, not conversational; no Algerian Darija; engineering (ETS-style) workflows are thin | Adopt floor→area(room) model and multi-target thinking; local-first intents before LLM is **prior art** (so SE7ENX does not claim it as novel); integrate HA rather than compete with its 2,000+ integrations |
| openHAB | EPL-2.0 | Semantic model: **Location / Equipment / Point / Property** tags; a Point belongs to one Equipment or Location ([semantic model](https://www.openhab.org/docs/tutorial/model.html), [semantic tags](https://www.openhab.org/docs/developer/bindings/semantic-tags.html)) | Model is item/group-centric; steep setup | Adopt the Location/Equipment/Point separation in SE7ENX's capability model |
| Node-RED | Apache-2.0 (OpenJS) | Flow-based low-code automation ([license](https://nodered.org/about/license/)) | Flows are powerful but unvalidated against device capabilities; no building model | Inspiration for a later visual editor; SE7ENX rules stay declarative and validated |
| OpenRemote | **AGPL-3.0** ([license](https://openremote.io/open-source/)) | Asset model, When-Then/Flow/Groovy rules, users/roles, realms, edge gateway | AGPL network clause; Java/Keycloak stack is heavy for a Pi | Do not reuse code; note "When-Then" as a familiar rule shape |
| ThingsBoard | CE ≤ 4.3 Apache-2.0; **4.4+ (29 Sep 2026) BUSL-1.1**, free commercial use limited to 100 devices ([analysis](https://wz-it.com/en/blog/thingsboard-community-vs-professional-edition-comparison/), [grant FAQ](https://thingsboard.io/community-grant-program/)) | Rule chains, dashboards, multi-tenancy | Telemetry/cloud orientation; license change | Licensing risk noted; no dependency |
| Eclipse VOLTTRON | Apache-2.0 ([Eclipse](https://projects.eclipse.org/projects/iot.volttron)) | Agent platform for buildings/grid, BACnet/Modbus drivers, diagnostics agents | Research/energy focus, not end-user UX | FDD idea ("expected vs observed") has prior art here |
| ComfortClick bOS | Proprietary | Server + Windows Configurator + clients; KNX (ETS import), Modbus, BACnet, MQTT, Z-Wave, 50+ systems; scenes, schedules, presence simulation, user privileges ([site](https://www.comfortclick.com/), [FAQ](https://www.comfortclick.com/Support/FAQ), [bOS](https://www.comfortclick.com/Products/Details/bOS)) | Closed, Windows configurator, licence per server | Benchmark for "engineering → operation" continuity and ETS import; SE7ENX differentiates on open, local-first, explainable, multilingual, web-only engineering |

## 3. Semantic / capability models

| Standard | License | Key idea | Decision |
| --- | --- | --- | --- |
| Brick Schema | BSD-3-Clause ([GitHub](https://github.com/BrickSchema/Brick)) | RDF class hierarchy + relationships: Floor *hasPart* Room, Equipment *hasLocation* Room, Equipment *hasPoint* Sensor ([relationships](https://docs.brickschema.org/brick/relationships.html)) | **Adopted (concepts)**: SE7ENX building model uses the same relations; an RDF/Brick **export** is planned, an RDF runtime is rejected (complexity on a Pi) |
| Project Haystack | AFL-3.0 ([about](https://www.project-haystack.org/about)); Haystack 5 adds the **Xeto** typed schema language ([press](https://marketing.project-haystack.org/project-haystack-media/press-releases/project-haystack-unveils-haystack-5-with-xeto-schema-language-and-rdf-integration-at-haystack-connect-2025)) | Tags + typed specs | **Planned**: tag export compatible with Haystack markers |
| W3C WoT Thing Description 1.1 | W3C Recommendation (Dec 2023) ([TD 1.1](https://www.w3.org/TR/wot-thing-description11/)) | A Thing exposes **Properties, Actions, Events** with data schemas and protocol bindings | **Adopted (shape)**: the SE7ENX capability contract describes each capability as properties (state + unit + range), actions (commands + parameter schema) and events, so adapters stay protocol-independent |
| Matter | CSA spec; HA's Matter server moved from python-matter-server (archived at 8.1.2) to **matter.js** server 1.0 / app 9.0 GA on 2026-06-23 ([python-matter-server](https://github.com/matter-js/python-matter-server), [HA blog](https://www.home-assistant.io/blog/2026/06/23/the-matter-upgrade-youve-been-waiting-for/)) | Device types/clusters | **Decision**: Matter devices reach SE7ENX **through Home Assistant** today (already integrated). A direct matterjs-server adapter is **Planned**, not claimed |

## 4. Protocol libraries for the Core (Python)

| Protocol | Candidate | License | Notes | Decision |
| --- | --- | --- | --- | --- |
| KNX/IP | xknx 4 | MIT | Already used, tested against a fake interface | Keep |
| MQTT | aiomqtt | BSD-3-Clause; v3 is pure asyncio (sans-io `mqtt5`), v2 wraps paho (EPL-2.0/EDL-1.0) ([PyPI](https://pypi.org/project/aiomqtt/), [GitHub](https://github.com/empicano/aiomqtt)) | Idiomatic asyncio | **Planned (M4)**: MQTT adapter + simulator |
| Modbus TCP/RTU | pymodbus 3.x | BSD-3-Clause ([PyPI](https://pypi.org/project/pymodbus/)) | asyncio client/server, built-in simulator | **Planned (M4)** |
| BACnet/IP | BACpypes3 | MIT ([PyPI](https://pypi.org/project/bacpypes3/)) — note BAC0 on top is **LGPL-3.0** | asyncio, pre-alpha classifier | **Planned (M4)**, BACpypes3 directly |
| OPC UA | asyncua (opcua-asyncio) | **LGPL-3.0+** ([PyPI](https://pypi.org/project/asyncua/)) | Actively maintained | **Open**: LGPL is usable as an unmodified dependency but needs a licensing note; postponed |
| ESPHome | aioesphomeapi | MIT | Native API | Planned; ESPHome via HA works today |

## 5. Identity, sessions and passwords

| Topic | Evidence | Decision |
| --- | --- | --- |
| Password hashing | OWASP: **Argon2id, m=19 MiB, t=2, p=1** minimum (alternative m=46 MiB, t=1); scrypt only if Argon2id is unavailable ([OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). argon2-cffi (MIT) defaults to RFC 9106 "low memory" (64 MiB, t=3, p=4) ([argon2-cffi](https://argon2-cffi.readthedocs.io/en/stable/api.html), [RFC 9106](https://www.ietf.org/rfc/rfc9106.html)) | **Adopted**: argon2-cffi, Argon2id **m=19 MiB, t=2, p=1** (OWASP minimum, suits a Raspberry Pi); `check_needs_rehash` upgrades hashes on login; hashing runs off the event loop behind a concurrency limit |
| Password policy | NIST SP 800-63B-4 (final, July 2025): single-factor passwords **≥ 15 characters**, allow ≥ 64, accept Unicode, **no composition rules, no periodic change**, blocklist check required ([NIST 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), [CSRC](https://csrc.nist.gov/pubs/sp/800/63/b/4/final)) | **Adopted**: min 15 (configurable down to 8 with a logged warning), max 256, Unicode counted per code point, built-in blocklist + context words (username, e-mail, "se7enx"), no composition rules, no expiry, no hints |
| Session tokens | OWASP: ≥ 64 bits entropy; **HttpOnly; Secure; SameSite=Strict** cookies preferred; **do not store tokens in localStorage/sessionStorage**; idle + absolute timeouts ([OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)) | **Adopted**: 256-bit random tokens, SHA-256 at rest, persisted in SQLite (survive restarts), idle + absolute timeouts, revocation. Same-origin UI (appliance) uses an **HttpOnly SameSite=Strict cookie** (Secure + `__Host-` prefix under TLS); cookie-authenticated unsafe requests must carry a same-origin `Origin`. Cross-origin clients (Vercel demo → hub) keep **bearer** tokens in tab memory/sessionStorage as a documented exception |
| Login abuse | OWASP authentication guidance; existing hub limiter | **Adopted**: per-IP sliding window + per-account progressive lockout, generic "username or password is incorrect", dummy hash on unknown users (timing), audit events |
| Recovery | "Do not invent recovery that cannot be implemented securely" (brief) | **Adopted**: (1) admin-issued one-time reset codes (hashed, 30 min); (2) host-level CLI `se7enx-bridge reset-password <user>` (physical/SSH access = owner). **Planned**: e-mail reset only when SMTP is configured. Security questions/hints: **Rejected** (NIST SHALL NOT) |
| Bootstrap | Existing console pairing code | **Adopted**: first-run **owner setup requires the console setup code**; once an owner exists, legacy pairing is disabled |
| MFA | Optional per brief | **Planned**: TOTP for owner/admin (RFC 6238, stdlib HMAC) |

## 6. Storage

| Option | Assessment | Decision |
| --- | --- | --- |
| Keep JSON for everything | Not suitable for sessions, audit, history (append-heavy, concurrent) | Rejected |
| PostgreSQL | Extra service on a Pi, backup complexity | Rejected for the appliance (possible later for multi-site) |
| **SQLite (stdlib, WAL)** | Zero dependency, transactional, single file, easy backup | **Adopted** for identity, sessions, audit, history. Configuration (devices, building, roles, automations) stays in `config.json` — one owner per domain, no duplicate source of truth |

## 7. AI and voice

| Topic | Evidence | Decision |
| --- | --- | --- |
| Local LLM | Ollama (MIT) exposes an OpenAI-compatible `/v1/chat/completions`, incl. tools ([docs](https://docs.ollama.com/api/openai-compatibility), [tools](https://ollama.com/blog/tool-support)) | **Adopted (existing)**: `SE7ENX_LLM_URL` speaks the OpenAI-compatible API, so Ollama/llama.cpp work locally; the LLM returns **validated intents only**; core control works without it |
| Local-first intents | HA Assist "prefer local" pattern (prior art) | **Adopted**: SE7ENX local multilingual intent engine first, LLM as fallback |

## 8. Gestures

MediaPipe Gesture Recognizer (Apache-2.0) ships 7 canned gestures: Closed_Fist, Open_Palm,
Pointing_Up, Thumb_Down, Thumb_Up, Victory, ILoveYou, plus a custom-gesture classifier option
([web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer/web_js),
[task guide](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer)).
**Decision (Planned, M6)**: gesture **profiles** map recognized gestures (existing landmark-based
recognizer + canned set) to validated intents with scope, arming, confirmation mode, sensitivity and
cooldown; preview mode never dispatches. Custom-trained gestures: Open (needs a training pipeline).

## 9. Safety position

SE7ENX is **not** a safety controller. It never replaces certified life-safety, fire, emergency or
machine-safety systems. Commands to real devices remain gated (explicit enablement, emergency stop,
rate limits, no unsafe retries) and evidence-graded (requested ≠ confirmed).

---

## Decision log (chronological)

| ID | Date | Decision | Status |
| --- | --- | --- | --- |
| D-01 | 2026-10-18 | Evolve the existing repo; hub = Core (modular monolith), web = client | Adopted |
| D-02 | 2026-10-18 | Identity in the Core: users, roles (owner/admin/engineer/technician/user), server-enforced permission matrix (configurable, owner fixed) | Adopted |
| D-03 | 2026-10-18 | Argon2id (argon2-cffi) m=19 MiB t=2 p=1; NIST 800-63B-4 password rules | Adopted |
| D-04 | 2026-10-18 | HttpOnly SameSite=Strict cookie sessions for the same-origin UI; bearer only for allowed cross-origin clients | Adopted |
| D-05 | 2026-10-18 | SQLite for identity/audit/history; config.json stays the configuration source of truth | Adopted |
| D-06 | 2026-10-18 | Building model Site → Building → Floor → Room, Zones group rooms; devices reference a room (Brick-style relations) | Adopted |
| D-07 | 2026-10-18 | Capability contract shaped after WoT TD (properties / actions / events) | Adopted (incremental) |
| D-08 | 2026-10-18 | Matter via Home Assistant; direct matterjs-server adapter later | Adopted / Planned |
| D-09 | 2026-10-18 | Guest = in-browser simulation, never a server session; the Core rejects unauthenticated access | Adopted |
| D-10 | 2026-10-18 | Monochrome design system (grayscale + semantic state colours only); logo untouched | Planned (M2) |
