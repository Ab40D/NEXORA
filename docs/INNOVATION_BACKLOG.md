# SE7ENX — Innovation Backlog

Ideas that go beyond the baseline feature list, ranked for implementation. Each idea had a
prior-art check (see [RESEARCH_AND_DECISIONS.md](RESEARCH_AND_DECISIONS.md)). **None is claimed to
be unprecedented.** Where a well-known product already does something similar, the table names it.
The value is in the combination with SE7ENX's principles: evidence before claims, local-first,
multilingual (incl. Algerian Darija) and protocol-agnostic.

## Scoring

Each criterion is scored 1–5. The weighted score is:
**0.35·Value + 0.25·Feasibility + 0.15·Originality + 0.15·Differentiation + 0.10·(6 − Cost)**.
*Cost* counts against the score; the others count for it.

| Rank | # | Idea | Value | Feas. | Orig. | Diff. | Cost | Score | Prior art (checked) | Milestone / status |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | I-01 | **Evidence ledger**: every action records requested → accepted → confirmed (device / bus / HA state) with actor, source (UI, voice, gesture, assistant, automation) and outcome; UI and assistant may only claim what the ledger proves | 5 | 4 | 3 | 4 | 2 | **4.20** | HA context + logbook; KNX confirmations. Explicit evidence grades shown to end users are uncommon | **M1: audit ledger implemented**; graded outcomes already exist for commands |
| 2 | I-07 | **Dialect-aware, code-switching local intents** (EN/FR/MSA/Algerian Darija in one sentence, offline) | 4 | 4 | 4 | 5 | 2 | **4.15** | HA Assist (hassil) supports many languages but not Darija; research NLU exists | Exists for lights (Phase E); extend to rooms/scenes in M5 |
| 3 | I-02 | **"Why?" explainer**: "why is the kitchen light on?" is answered from the ledger + automation traces ("turned on at 18:02 by automation *Evening*, trigger sunset, confirmed by the device"), filtered by the user's permissions | 5 | 4 | 3 | 4 | 3 | **4.10** | HA traces show "Triggered by" ([docs](https://www.home-assistant.io/docs/automation/troubleshooting/)), not conversational/multilingual | M3 (needs automation traces); M1 ledger provides the data |
| 4 | I-03 | **Automation compiler + sandbox**: rules are type-checked against the capability registry (missing capability, unit/range errors, conflicting actions on the same trigger, event loops) and dry-run against the simulated twin with time-travel scenarios before deployment | 5 | 3 | 4 | 5 | 4 | **4.05** | HA config check + traces after the fact; Node-RED debug; commissioning tools in commercial BAS | M3 |
| 5 | I-06 | **Guide that teaches with your own building**: tours and exercises generated from the real building model ("your Living room has 2 lights — try 'dim the living room to 30 %'"), demonstrated in simulation first | 4 | 4 | 4 | 4 | 3 | **3.90** | Generic product tours; HA onboarding is static | M6 |
| 6 | I-15 | **Room-scoped, time-boxed access** (e.g. a technician for the plant room until Friday, a guest for one room) | 4 | 4 | 3 | 4 | 2 | **3.85** | Long-standing HA feature request; common in commercial access systems | M2 (scopes on top of the M1 permission matrix) |
| 7 | I-05 | **Capability contract + conformance kit**: adapters declare properties/actions/events (WoT TD-shaped) and must pass a simulator-driven conformance suite (feedback semantics, error mapping, timeouts) | 4 | 4 | 3 | 4 | 3 | **3.75** | W3C WoT TD; HA integration quality scale; Matter certification | M4 |
| 8 | I-12 | **Evidence-based maintenance report**: one-click Markdown/PDF with device health, failed commands, offline periods, latency statistics, open safety events | 4 | 4 | 3 | 3 | 2 | **3.70** | HA diagnostics JSON downloads; BAS reports | M5 |
| 9 | I-11 | **Capability-grounded AI tools with graceful degradation**: the LLM proposes only schema-validated tool calls against the capability registry; the Core executes under policy; local engine takes over when AI is down | 4 | 4 | 2 | 3 | 2 | **3.55** | HA Assist API for LLMs (prior art, so not novel) | Partially exists (Phase E); generalise in M5 |
| 10 | I-04 | **Expected-vs-observed twin**: flags "commanded ON, feedback OFF", "light on in an empty room for 3 h", "sensor value frozen" with the evidence behind each flag | 4 | 3 | 3 | 4 | 3 | **3.50** | Fault detection & diagnostics in BAS (SkySpark/Haystack, VOLTTRON diagnostics agents) | M7 |
| 11 | I-13 | **Semantic import**: ETS group addresses / HA entities → suggested rooms, equipment and capabilities with confidence scores and human confirmation | 4 | 3 | 3 | 4 | 3 | **3.50** | HA KNX panel and ComfortClick import ETS projects; semantic inference is rarer | M7 |
| 12 | I-08 | **Gesture safety envelope**: profiles with scope, arming gesture, neutral pose, preview/confirm modes, per-gesture sensitivity and cooldown; preview never dispatches | 3 | 4 | 3 | 4 | 3 | **3.40** | MediaPipe demos; research prototypes | M6 |
| 13 | I-10 | **Change sets with risk scoring and two-person approval** for consequential configuration changes | 3 | 3 | 4 | 4 | 3 | **3.30** | GitOps; industrial management-of-change | M7 |
| 14 | I-09 | **Engineering-to-operation continuity**: one model from design → simulation → deployment → operation → maintenance | 4 | 2 | 3 | 4 | 5 | **3.05** | ETS + visualisation suites, Niagara Workbench, ComfortClick configurator (proprietary) | M7 (incremental, via I-03/I-10/I-13) |
| 15 | I-14 | **Energy what-if estimator** for automations | 3 | 2 | 2 | 3 | 4 | **2.50** | Energy dashboards (HA), BEMS | Backlog (needs meters) |

## Selection for implementation

1. **Now (M1):** I-01 evidence ledger (audit log with actor, source, permission decision and
   outcome), plus the permission matrix that I-15 builds on.
2. **Next:** I-15 scopes (M2), I-03 + I-02 (M3), I-05 (M4), I-11 + I-12 (M5), I-06 + I-08 (M6).
3. Ideas are re-scored after each milestone using real usage and test evidence.
