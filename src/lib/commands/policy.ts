import { effectiveValue } from "@/lib/state/selectors";
import type { BlockReason, CommandSource, LightState, OnOff } from "@/lib/state/types";

export interface CommandRequest {
  value: OnOff;
  source: CommandSource;
}

export interface PolicyConfig {
  /** minimum time between two dispatched commands (all sources) */
  minIntervalMs: number;
}

export const DEFAULT_POLICY: PolicyConfig = { minIntervalMs: 500 };

export type PolicyResult = { ok: true } | { ok: false; reason: BlockReason };

/** Sources that are subject to the emergency stop. */
export const HANDS_FREE_SOURCES: ReadonlySet<CommandSource> = new Set(["gesture", "voice"]);

/**
 * Decide whether a command may be dispatched. Pure function.
 *
 * Order matters: safety (pause) first, then connectivity, then flow control.
 */
export function evaluateCommand(
  state: LightState,
  req: CommandRequest,
  now: number,
  cfg: PolicyConfig = DEFAULT_POLICY,
): PolicyResult {
  if (state.dispatchPaused && HANDS_FREE_SOURCES.has(req.source)) return { ok: false, reason: "paused" };

  if (state.mode !== "simulation") {
    if (state.link.status !== "connected") return { ok: false, reason: "not_connected" };
    if (!state.target) return { ok: false, reason: "no_target" };
  }

  const last = state.lastCommand;
  if (last && last.phase === "pending") return { ok: false, reason: "busy" };
  if (last && now - last.createdAt < cfg.minIntervalMs) return { ok: false, reason: "rate_limited" };

  // A held gesture must not re-send the state the light is already in.
  // Manual and voice commands are always sent: KNX writes are idempotent and
  // the user explicitly asked.
  if (req.source === "gesture" && effectiveValue(state) === req.value) return { ok: false, reason: "duplicate" };

  return { ok: true };
}
