/**
 * Pure state machine for the SE7ENX light.
 *
 * Three kinds of state are tracked separately and never mixed:
 *   simulated  – the in-browser demo lamp (simulation mode only)
 *   requested  – `lastCommand`, what the user asked for and how far it got
 *   reported   – what the real installation reported (status GA / read response)
 *
 * The reducer is deterministic (time is passed in on every event) so it is easy
 * to unit-test.
 */
import type {
  BlockReason,
  CommandPhase,
  CommandRecord,
  CommandSource,
  HistoryEntry,
  HistoryKind,
  HistoryTone,
  LightState,
  LightTarget,
  LinkStatus,
  Mode,
  OnOff,
  ReportVia,
} from "./types";

export const HISTORY_LIMIT = 60;

export type LightEvent =
  | { type: "MODE_CHANGED"; mode: Mode; backendLabel?: string | null; at: number }
  | { type: "LINK_CHANGED"; status: LinkStatus; message?: string | null; at: number }
  | { type: "TARGET_SET"; target: LightTarget | null; feedbackAvailable: boolean; at: number }
  | { type: "COMMAND_REQUESTED"; id: string; value: OnOff; source: CommandSource; at: number }
  | {
      type: "COMMAND_SETTLED";
      id: string;
      phase: Exclude<CommandPhase, "pending">;
      detail?: string | null;
      errorCode?: string | null;
      at: number;
    }
  | { type: "COMMAND_BLOCKED"; value: OnOff; source: CommandSource; reason: BlockReason; at: number }
  | { type: "STATE_REPORTED"; value: OnOff | "unknown"; via: ReportVia; detail?: string; at: number }
  | { type: "DISPATCH_PAUSED"; paused: boolean; at: number }
  | { type: "NOTE"; title: string; detail?: string; tone?: HistoryTone; at: number }
  | { type: "HISTORY_CLEARED" };

export function createInitialState(at = 0): LightState {
  return {
    mode: "simulation",
    link: { status: "idle", message: null, since: at },
    simulated: "off",
    lastCommand: null,
    reported: { value: "unknown", via: "none", at: null },
    feedbackAvailable: false,
    target: null,
    dispatchPaused: false,
    backendLabel: null,
    history: [],
    seq: 0,
  };
}

export const MODE_LABEL: Record<Mode, string> = {
  simulation: "Simulation",
  bridge: "SE7ENX Bridge (KNX)",
  homeassistant: "Home Assistant (KNX)",
};

export const SOURCE_LABEL: Record<CommandSource, string> = {
  manual: "manual control",
  lamp: "lamp tap",
  keyboard: "keyboard",
  gesture: "hand gesture",
  voice: "voice command",
  test: "wizard test",
};

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  paused: "Gesture & voice control is paused (emergency stop).",
  not_connected: "Not connected to a KNX backend.",
  no_target: "No light group address configured.",
  busy: "Previous command still in progress.",
  rate_limited: "Too many commands — slow down.",
  duplicate: "Light is already in that state.",
};

const PHASE_TEXT: Record<Exclude<CommandPhase, "pending">, string> = {
  simulated: "applied to simulation",
  accepted: "accepted by backend (bus transmission not confirmed)",
  bus_confirmed: "confirmed by the KNX interface",
  failed: "failed",
};

function pushHistory(
  state: LightState,
  entry: Omit<HistoryEntry, "id" | "mode"> & { mode?: Mode },
): Pick<LightState, "history" | "seq"> {
  const seq = state.seq + 1;
  const full: HistoryEntry = { id: `h${seq}`, mode: entry.mode ?? state.mode, ...entry };
  const history = [full, ...state.history].slice(0, HISTORY_LIMIT);
  return { history, seq };
}

function entry(
  kind: HistoryKind,
  tone: HistoryTone,
  title: string,
  at: number,
  extra: Partial<HistoryEntry> = {},
): Omit<HistoryEntry, "id" | "mode"> {
  return { kind, tone, title, at, ...extra };
}

const upper = (v: OnOff | "unknown") => v.toUpperCase();

export function lightReducer(state: LightState, event: LightEvent): LightState {
  switch (event.type) {
    case "MODE_CHANGED": {
      if (event.mode === state.mode && event.backendLabel === state.backendLabel) return state;
      const next: LightState = {
        ...state,
        mode: event.mode,
        backendLabel: event.backendLabel ?? null,
        link: {
          status: event.mode === "simulation" ? "idle" : "connecting",
          message: null,
          since: event.at,
        },
        lastCommand: null,
        reported: { value: "unknown", via: "none", at: null },
        feedbackAvailable: false,
        target: null,
      };
      return {
        ...next,
        ...pushHistory(next, entry("mode", "info", `Mode: ${MODE_LABEL[event.mode]}`, event.at, {
          detail: event.mode === "simulation" ? "No hardware is controlled in simulation mode." : event.backendLabel ?? undefined,
        })),
      };
    }

    case "LINK_CHANGED": {
      if (state.mode === "simulation") return state; // simulation has no link
      if (state.link.status === event.status && state.link.message === (event.message ?? null)) return state;
      const next: LightState = {
        ...state,
        link: { status: event.status, message: event.message ?? null, since: event.at },
      };
      if (state.link.status === event.status) return next; // message-only update, no history spam
      const tone: HistoryTone =
        event.status === "connected" ? "success" : event.status === "error" ? "danger" : event.status === "idle" ? "neutral" : "warning";
      return {
        ...next,
        ...pushHistory(next, entry("link", tone, `Link ${event.status}`, event.at, { detail: event.message ?? undefined })),
      };
    }

    case "TARGET_SET": {
      const next: LightState = { ...state, target: event.target, feedbackAvailable: event.feedbackAvailable };
      if (!event.target) return next;
      const t = event.target;
      return {
        ...next,
        ...pushHistory(next, entry("info", "info", `Target ${t.displayAddress} (DPT ${t.dpt})`, event.at, {
          detail: t.displayStatusAddress
            ? `Status/feedback address ${t.displayStatusAddress}`
            : event.feedbackAvailable
              ? "State is read back from the switching address."
              : "No status address: device state cannot be confirmed.",
        })),
      };
    }

    case "COMMAND_REQUESTED": {
      const command: CommandRecord = {
        id: event.id,
        value: event.value,
        source: event.source,
        mode: state.mode,
        phase: "pending",
        createdAt: event.at,
        settledAt: null,
        detail: null,
        errorCode: null,
      };
      const next: LightState = { ...state, lastCommand: command };
      return {
        ...next,
        ...pushHistory(next, entry("command", "neutral", `${upper(event.value)} requested`, event.at, {
          source: event.source,
          detail: `via ${SOURCE_LABEL[event.source]}`,
        })),
      };
    }

    case "COMMAND_SETTLED": {
      const cmd = state.lastCommand;
      const matches = cmd !== null && cmd.id === event.id && cmd.phase === "pending";
      let next: LightState = state;
      if (matches) {
        const settled: CommandRecord = {
          ...cmd,
          phase: event.phase,
          settledAt: event.at,
          detail: event.detail ?? null,
          errorCode: event.errorCode ?? null,
        };
        next = { ...state, lastCommand: settled };
        if (event.phase === "simulated" && state.mode === "simulation" && cmd.mode === "simulation") {
          next = { ...next, simulated: cmd.value };
        }
      }
      const value = matches ? upper(cmd.value) : "Command";
      const tone: HistoryTone =
        event.phase === "failed" ? "danger" : event.phase === "accepted" ? "warning" : event.phase === "simulated" ? "info" : "success";
      return {
        ...next,
        ...pushHistory(next, entry("command", tone, `${value} ${PHASE_TEXT[event.phase]}`, event.at, {
          detail: event.detail ?? undefined,
          source: matches ? cmd.source : undefined,
        })),
      };
    }

    case "COMMAND_BLOCKED": {
      return {
        ...state,
        ...pushHistory(state, entry("blocked", "warning", `${upper(event.value)} blocked`, event.at, {
          source: event.source,
          detail: BLOCK_REASON_TEXT[event.reason],
        })),
      };
    }

    case "STATE_REPORTED": {
      if (state.mode === "simulation") return state; // never let a stale real report touch the simulation
      const changed = state.reported.value !== event.value || state.reported.via !== event.via;
      const next: LightState = { ...state, reported: { value: event.value, via: event.via, at: event.at } };
      if (!changed) return next;
      const viaText: Record<ReportVia, string> = {
        status_address: "status/feedback address",
        read_response: "read response",
        switch_address: "telegram on switching address",
        none: "backend",
      };
      return {
        ...next,
        ...pushHistory(next, entry(
          "state",
          event.value === "unknown" ? "neutral" : "success",
          event.value === "unknown" ? "Device state unknown" : `Device reported ${upper(event.value)}`,
          event.at,
          { detail: event.detail ?? `via ${viaText[event.via]}` },
        )),
      };
    }

    case "DISPATCH_PAUSED": {
      if (state.dispatchPaused === event.paused) return state;
      const next: LightState = { ...state, dispatchPaused: event.paused };
      return {
        ...next,
        ...pushHistory(next, entry(
          "safety",
          event.paused ? "danger" : "info",
          event.paused ? "Emergency stop: gesture & voice paused" : "Gesture & voice control resumed",
          event.at,
        )),
      };
    }

    case "NOTE":
      return { ...state, ...pushHistory(state, entry("info", event.tone ?? "neutral", event.title, event.at, { detail: event.detail })) };

    case "HISTORY_CLEARED":
      return { ...state, history: [] };

    default:
      return state;
  }
}
