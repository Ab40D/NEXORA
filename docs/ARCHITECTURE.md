# Architecture

## Why this shape

A browser cannot speak KNXnet/IP (raw UDP) and a Vercel function cannot reach a
customer's private LAN, broadcast/multicast UDP, or hold a persistent tunnel.
So the system is split:

| Part | Runs on | Responsibility |
| --- | --- | --- |
| **Web app** (Next.js 16, React 19, TypeScript) | Vercel / any static host | UI, 3D lamp, simulation, gesture recognition (MediaPipe WASM, local), voice (Web Speech API), state machine, wizard. Only server route: `GET /api/health`. |
| **SE7ENX Bridge** (Python 3.11+, FastAPI, xknx 4) | PC / Raspberry Pi / NAS on the customer LAN | Pairing & sessions, origin + group-address policy, KNXnet/IP tunnelling (UDP/TCP, KNX Secure) or routing via xknx, confirmation tracking, status feedback, SSE events. |
| **Home Assistant** (alternative) | Customer's HA | Existing KNX integration; SE7ENX uses HA's OAuth + WebSocket API (`knx.send`, `knx.read`, `knx_event`). |

The browser connects **directly** to the bridge or HA. Nothing KNX-related passes through Vercel.

```
┌──────────────────────── Browser ─────────────────────────┐
│  LampStage (R3F)  StateStrip  Panels  ConnectionWizard   │
│        ▲               ▲                    │            │
│        └──── zustand store (lightReducer) ◄─┘            │
│                    ▲         │ dispatchCommand()         │
│   GestureEngine ───┤         ▼  policy: pause/link/busy/ │
│   VoiceAllowlist ──┘    LightAdapter   rate/duplicate    │
│                   ┌─────────┼──────────────┐             │
│          Simulation   BridgeAdapter   HomeAssistantAdapter
└───────────────────────────────┼──────────────┼───────────┘
                     fetch + SSE│              │ WebSocket (OAuth)
                    ┌───────────▼───┐    ┌─────▼──────────┐
                    │ SE7ENX Bridge │    │ Home Assistant │
                    │  xknx 4       │    │  KNX integration│
                    └───────┬───────┘    └─────┬──────────┘
                KNXnet/IP UDP/TCP (+Secure)    │
                    ┌───────▼──────────────────▼─┐
                    │ KNX IP interface / router  │── KNX TP bus ── actuator ── light
                    └────────────────────────────┘
```

## State model — never mix the three kinds of state

`src/lib/state/light-machine.ts` (pure reducer) tracks:

* **simulated** — the in-browser lamp; only changed by a `simulated` command outcome in simulation mode.
* **requested** — `lastCommand`: value, source, and phase
  `pending → simulated | accepted | bus_confirmed | failed`.
* **reported** — what the installation reported: `value` + `via`
  (`status_address`, `read_response`, `switch_address`), ignored in simulation.

`src/lib/state/selectors.ts#selectLampView` turns this into what the lamp shows:

| Situation | Lamp |
| --- | --- |
| Simulation | `SIMULATION · ON/OFF`, violet "Simulated" badge |
| Connecting / reconnecting / error | `CONNECTING` / `RECONNECTING` (last known, stale) / `ERROR` |
| Status feedback received | `ON`/`OFF`, "Device confirmed" |
| Command confirmed but feedback expected | last reported state + "requested" ring; warning after 4 s without feedback |
| No feedback possible (no status address) | `ON · UNVERIFIED`, dimmed glow |
| Another device wrote the switching address | "Observed on bus" (not actuator feedback) |

## Command path

Every source (manual, lamp tap, keyboard, gesture, voice, wizard test) goes through
`dispatchCommand()` (`src/lib/commands/dispatcher.ts`):

1. **Policy** (`policy.ts`): emergency stop blocks gesture/voice; real modes need a
   connected link and a target; one command in flight; ≥ 500 ms between commands;
   gestures that would not change the state are dropped silently.
2. **Adapter** `send()` with a 10 s timeout.
3. Outcome → `COMMAND_SETTLED` with the truthful phase, or `failed` with code + hint.

## Confirmation semantics

| Backend | `bus_confirmed` means | Device state from |
| --- | --- | --- |
| Bridge, tunnelling | Interface returned a **positive** `L_Data.con` (xknx waits ≤ 3 s; the bridge's `ConfirmingCEMIHandler` additionally checks the confirm bit) | Status address telegrams, GroupValueRead responses |
| Bridge, routing | never — reported as `accepted` (multicast has no confirmation) | same |
| Home Assistant (admin) | outgoing `knx_event` observed (HA fires it only after its interface confirmed) | `knx_event` on the status address, `knx.read` responses |
| Home Assistant (non-admin) | never — reported as `accepted` | `knx.read` with `return_response` (recent HA) |

## Gesture pipeline

`getUserMedia` (explicit click) → MediaPipe Hand Landmarker (WASM, GPU→CPU fallback,
self-hosted model) → `computeHandFeatures` (open palm = ≥4 extended fingers, palm
height) → `GestureEngine`:

* confidence gate (score, hand size, in-frame ratio) — otherwise `low-confidence`, no inference;
* EMA smoothing; separate ON/OFF thresholds with a neutral band;
* dwell (default 450 ms) → trigger; cooldown (1.5 s); re-arm only after leaving the zone or losing the hand;
* frame gaps (> 300 ms) reset dwell; calibration sets thresholds at 30 %/70 % of the user's range.

Triggers go to the dispatcher (never per frame). The preview canvas draws thresholds,
landmarks and dwell progress at frame rate; React state updates at ~10 Hz.

## Voice pipeline

Explicit opt-in (`getUserMedia` permission check, nothing recorded) → push-to-talk
(single utterance, 8 s cap) or 60 s hands-free session → up to 3 alternatives →
normalization (case, accents, Arabic diacritics/letter variants, filler words) →
**exact allowlist** match (EN/FR/AR incl. Algerian Darija) → ambiguity / confidence
checks → dispatcher. Voice can only produce `on`/`off` for the configured light.

## Real-time updates & resilience

* Bridge events via `fetch` streaming (SSE format) so the `Authorization` header and
  Chrome's Local Network Access exemptions apply; reconnect with back-off; 10 s
  first-byte and 45 s idle watchdogs; 401 ends the stream with "pair again".
* Home Assistant reconnects via `home-assistant-js-websocket`; the adapter maps
  `ready` / `disconnected` / `reconnect-error` to link states and re-reads state.

## Key files

| Path | Purpose |
| --- | --- |
| `src/lib/knx/group-address.ts`, `dpt.ts` | GA parsing (3-level/2-level/free), DPT encode/decode |
| `src/lib/state/*` | reducer, selectors, zustand stores, persisted non-secret settings |
| `src/lib/commands/*` | policy + dispatcher |
| `src/lib/adapters/*` | simulation, bridge, Home Assistant adapters |
| `src/lib/bridge/*` | zod contract, typed client, SSE parser |
| `src/lib/ha/oauth.ts` | HA OAuth with state nonce |
| `src/lib/gesture/*` | features, engine, calibration, tracker, overlay drawing |
| `src/lib/voice/*` | allowlist parser, recognizer wrapper, controller |
| `src/lib/net/*` | URL / address-space validation, fetch with timeouts + LNA hint |
| `src/components/*` | UI (lamp, panels, wizard, primitives) |
| `bridge/se7enx_bridge/*` | config, security, group addresses, KNX service, API, CLI |
| `bridge/tools/fake_knx_interface.py` | protocol-level fake KNXnet/IP interface (tests/demos only) |
