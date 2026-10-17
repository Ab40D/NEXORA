import type { Certainty, CommandRecord, LightState, OnOff } from "./types";

/** How long to wait for status feedback after a confirmed command before warning. */
export const FEEDBACK_GRACE_MS = 4000;

export type LampTone = "sim" | "live" | "warn" | "error" | "muted";

export interface LampView {
  /** whether the bulb is drawn lit */
  lit: boolean;
  /** 0..1 — confirmed = 1, unverified ≈ 0.5 */
  intensity: number;
  certainty: Certainty;
  /** primary state label: SIMULATION · ON, CONNECTING, CONNECTED, ON, OFF, ERROR … */
  label: string;
  /** one-line explanation of where the displayed state comes from */
  detail: string;
  tone: LampTone;
  /** value of a command still awaiting an outcome / feedback (drives the "requested" ring) */
  pending: OnOff | null;
  /** feedback expected but not received in time */
  feedbackMissing: boolean;
}

function isSuccess(cmd: CommandRecord | null): cmd is CommandRecord {
  return !!cmd && (cmd.phase === "bus_confirmed" || cmd.phase === "accepted");
}

/**
 * The value the installation is most plausibly in, used for gesture de-duplication.
 * Simulation → simulated value. Real → newest of (reported state, successful command).
 */
export function effectiveValue(state: LightState): OnOff | "unknown" {
  if (state.mode === "simulation") return state.simulated;
  const cmd = state.lastCommand;
  const rep = state.reported;
  const repKnown = rep.value !== "unknown" && rep.at !== null;
  if (isSuccess(cmd) && cmd.mode === state.mode) {
    const cmdAt = cmd.settledAt ?? cmd.createdAt;
    if (!repKnown || (rep.at as number) < cmdAt) return cmd.value;
  }
  return repKnown ? rep.value : "unknown";
}

export function selectLampView(state: LightState, now: number): LampView {
  const cmd = state.lastCommand;
  const pendingCmd = cmd && cmd.phase === "pending" ? cmd.value : null;

  if (state.mode === "simulation") {
    const on = state.simulated === "on";
    return {
      lit: on,
      intensity: on ? 1 : 0,
      certainty: "simulated",
      label: `SIMULATION · ${on ? "ON" : "OFF"}`,
      detail: "Simulated lamp — no real hardware is being controlled.",
      tone: "sim",
      pending: pendingCmd,
      feedbackMissing: false,
    };
  }

  const link = state.link.status;
  const rep = state.reported;
  const repKnown = rep.value !== "unknown" && rep.at !== null;

  if (link === "connecting" || link === "idle") {
    return {
      lit: false,
      intensity: 0,
      certainty: "unknown",
      label: "CONNECTING",
      detail: state.link.message ?? "Establishing connection to the KNX backend…",
      tone: "muted",
      pending: null,
      feedbackMissing: false,
    };
  }

  if (link === "error" || link === "disconnected") {
    return {
      lit: false,
      intensity: 0,
      certainty: "unknown",
      label: link === "error" ? "ERROR" : "DISCONNECTED",
      detail: state.link.message ?? (link === "error" ? "Connection error." : "Not connected."),
      tone: link === "error" ? "error" : "muted",
      pending: null,
      feedbackMissing: false,
    };
  }

  if (link === "reconnecting") {
    const on = repKnown && rep.value === "on";
    return {
      lit: on,
      intensity: on ? 0.35 : 0,
      certainty: "stale",
      label: "RECONNECTING",
      detail: state.link.message ?? "Connection lost — reconnecting. Last known state shown, may be outdated.",
      tone: "warn",
      pending: null,
      feedbackMissing: false,
    };
  }

  // connected
  const cmdOk = isSuccess(cmd) && cmd.mode === state.mode ? cmd : null;
  // A report counts as feedback for the command if it arrived after the command was ISSUED: fast
  // actuators can report back over the event stream before the command's HTTP response settles it.
  const issuedAt = cmdOk ? cmdOk.createdAt : 0;
  // The missing-feedback grace period still runs from the moment the command was confirmed.
  const cmdAt = cmdOk ? cmdOk.settledAt ?? cmdOk.createdAt : 0;
  const reportIsNewer = repKnown && (!cmdOk || (rep.at as number) >= issuedAt);

  if (repKnown && (reportIsNewer || state.feedbackAvailable)) {
    const on = rep.value === "on";
    const observed = rep.via === "switch_address";
    const awaiting = !!cmdOk && !reportIsNewer && state.feedbackAvailable;
    const feedbackMissing = awaiting && now - cmdAt > FEEDBACK_GRACE_MS;
    return {
      lit: on,
      intensity: on ? (observed ? 0.6 : 1) : 0,
      certainty: observed ? "observed" : "confirmed",
      label: on ? "ON" : "OFF",
      detail: feedbackMissing
        ? `No status feedback after the last ${cmdOk!.value.toUpperCase()} command — showing last reported state. Check the status address.`
        : awaiting
          ? `Waiting for status feedback for ${cmdOk!.value.toUpperCase()}…`
          : observed
            ? "Observed on the switching address (not actuator feedback)."
            : rep.via === "status_address"
              ? "Confirmed by actuator status feedback."
              : "Confirmed by a read response from the installation.",
      tone: "live",
      pending: pendingCmd ?? (awaiting && !feedbackMissing ? cmdOk!.value : null),
      feedbackMissing,
    };
  }

  if (cmdOk && !state.feedbackAvailable) {
    const on = cmdOk.value === "on";
    return {
      lit: on,
      intensity: on ? 0.5 : 0,
      certainty: "assumed",
      label: `${on ? "ON" : "OFF"} · UNVERIFIED`,
      detail:
        cmdOk.phase === "bus_confirmed"
          ? "Command confirmed by the KNX interface, but the device does not report its state (no status address)."
          : "Command accepted by the backend; neither bus transmission nor device state could be confirmed.",
      tone: "warn",
      pending: pendingCmd,
      feedbackMissing: false,
    };
  }

  if (cmdOk && state.feedbackAvailable) {
    const waiting = now - cmdAt <= FEEDBACK_GRACE_MS;
    return {
      lit: false,
      intensity: 0,
      certainty: "unknown",
      label: "CONNECTED",
      detail: waiting
        ? `Waiting for status feedback for ${cmdOk.value.toUpperCase()}…`
        : "No status feedback received — device state unknown. Check the status address.",
      tone: "live",
      pending: pendingCmd ?? (waiting ? cmdOk.value : null),
      feedbackMissing: !waiting,
    };
  }

  return {
    lit: false,
    intensity: 0,
    certainty: "unknown",
    label: "CONNECTED",
    detail: state.feedbackAvailable
      ? "Device state unknown — use Read state or send a command."
      : "Device state unknown — this light has no status feedback configured.",
    tone: "live",
    pending: pendingCmd,
    feedbackMissing: false,
  };
}

export function isRealMode(state: LightState): boolean {
  return state.mode !== "simulation";
}

export function canDispatch(state: LightState): boolean {
  if (state.mode === "simulation") return true;
  return state.link.status === "connected" && state.target !== null;
}
