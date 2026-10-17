import type { MessageKey } from "@/lib/i18n/core";
import type { ExecState } from "./store";

/** Dictionary key for every execution state (UI-independent; icons/tones live in the components). */
export const EXEC_KEY: Record<ExecState, MessageKey> = {
  pending: "exec.pending",
  executing: "exec.executing",
  accepted: "exec.accepted",
  confirmed: "exec.confirmed",
  simulated: "exec.simulated",
  already: "exec.already",
  failed: "exec.failed",
  timeout: "exec.timeout",
  unknown: "exec.unknown",
  offline: "exec.offline",
  blocked: "exec.blocked",
};
