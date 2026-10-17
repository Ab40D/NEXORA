import { CheckCheck, CircleCheck, CircleHelp, Clock, FlaskConical, Loader2, OctagonX, TimerOff, WifiOff, XCircle, type LucideIcon } from "lucide-react";
import type { ExecState } from "@/lib/experience/store";
import { EXEC_KEY } from "@/lib/experience/labels";
import type { MessageKey } from "@/lib/i18n";

/** Label, tone and icon for every execution state (shared by the experience panel and the chat). */
export const EXEC_VIEW: Record<
  ExecState,
  { key: MessageKey; tone: "accent" | "ok" | "warn" | "danger" | "sim" | "neutral"; icon: LucideIcon; spin?: boolean }
> = {
  pending: { key: EXEC_KEY.pending, tone: "accent", icon: Loader2, spin: true },
  executing: { key: EXEC_KEY.executing, tone: "accent", icon: Loader2, spin: true },
  accepted: { key: EXEC_KEY.accepted, tone: "warn", icon: Clock },
  confirmed: { key: EXEC_KEY.confirmed, tone: "ok", icon: CircleCheck },
  simulated: { key: EXEC_KEY.simulated, tone: "sim", icon: FlaskConical },
  already: { key: EXEC_KEY.already, tone: "ok", icon: CheckCheck },
  failed: { key: EXEC_KEY.failed, tone: "danger", icon: XCircle },
  timeout: { key: EXEC_KEY.timeout, tone: "danger", icon: TimerOff },
  unknown: { key: EXEC_KEY.unknown, tone: "warn", icon: CircleHelp },
  offline: { key: EXEC_KEY.offline, tone: "danger", icon: WifiOff },
  blocked: { key: EXEC_KEY.blocked, tone: "danger", icon: OctagonX },
};
