import type { DptId } from "@/lib/knx/dpt";

/** Which backend drives the lamp. Simulation never touches real hardware. */
export type Mode = "simulation" | "bridge" | "homeassistant";

export type LinkStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export type OnOff = "on" | "off";

export type CommandSource = "manual" | "lamp" | "keyboard" | "gesture" | "voice" | "test" | "assistant";

/**
 * Lifecycle of a requested command.
 *  - pending        sent to the adapter, awaiting an answer
 *  - simulated      applied to the in-browser simulation (no hardware involved)
 *  - accepted       the backend accepted the command, but could not confirm bus transmission
 *  - bus_confirmed  the KNX interface confirmed transmission (L_Data.con) — NOT device state
 *  - failed         rejected or failed; see errorCode/detail
 */
export type CommandPhase = "pending" | "simulated" | "accepted" | "bus_confirmed" | "failed";

/** How a reported (real) device state was obtained. */
export type ReportVia =
  | "status_address" // actuator feedback telegram on the status/feedback group address
  | "read_response" // answer to a GroupValueRead
  | "switch_address" // another bus device wrote the switching address (observed, not actuator feedback)
  | "none";

export type Certainty = "simulated" | "confirmed" | "observed" | "assumed" | "unknown" | "stale";

export type BlockReason = "paused" | "not_connected" | "no_target" | "busy" | "rate_limited" | "duplicate";

export interface CommandRecord {
  id: string;
  value: OnOff;
  source: CommandSource;
  mode: Mode;
  phase: CommandPhase;
  createdAt: number;
  settledAt: number | null;
  detail: string | null;
  errorCode: string | null;
}

export interface ReportedState {
  value: OnOff | "unknown";
  via: ReportVia;
  at: number | null;
}

export interface LightTarget {
  /** canonical three-level group address used on the wire */
  groupAddress: string;
  /** address as the user typed it (normalized) */
  displayAddress: string;
  statusAddress: string | null;
  displayStatusAddress: string | null;
  dpt: DptId;
  onLevel: number;
}

export type HistoryTone = "neutral" | "info" | "success" | "warning" | "danger";
export type HistoryKind = "command" | "blocked" | "state" | "link" | "mode" | "safety" | "info";

export interface HistoryEntry {
  id: string;
  at: number;
  kind: HistoryKind;
  mode: Mode;
  tone: HistoryTone;
  title: string;
  detail?: string;
  source?: CommandSource;
}

export interface LightState {
  mode: Mode;
  link: { status: LinkStatus; message: string | null; since: number };
  /** in-browser simulated lamp — only meaningful in simulation mode */
  simulated: OnOff;
  /** most recent requested command (any mode) */
  lastCommand: CommandRecord | null;
  /** last state REPORTED by the real installation (never set by simulation) */
  reported: ReportedState;
  /** whether the active backend can report device state (status GA / read responses) */
  feedbackAvailable: boolean;
  target: LightTarget | null;
  /** emergency stop: gesture & voice commands are not dispatched while true */
  dispatchPaused: boolean;
  backendLabel: string | null;
  history: HistoryEntry[];
  seq: number;
}
