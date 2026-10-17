/**
 * Pure reply logic for "Talk to SE7ENX": turns intents and pipeline outcomes into localized,
 * truthful replies. A reply never claims more than the outcome proves:
 *   confirmed → "The light is on." · accepted → "sent, not confirmed yet" · already → "already on"
 *   unknown/stale → "I don't know, I won't guess" · offline → explains why.
 */
import type { MessageKey, Vars } from "@/lib/i18n/core";
import type { ErrorCategory } from "@/lib/experience/errors";
import type { Execution, ExperienceCommand, TargetSnapshot } from "@/lib/experience/store";
import type { Intent } from "./intent";

export interface Reply {
  key: MessageKey;
  vars?: Vars;
}

const RATE_LIMIT_CODES = new Set(["DEVICE_RATE_LIMITED", "RATE_LIMITED", "SHELLY_THROTTLED"]);

export function commandForIntent(intent: Intent): ExperienceCommand | null {
  switch (intent.kind) {
    case "turn_on":
      return { kind: "turn_on" };
    case "turn_off":
      return { kind: "turn_off" };
    case "toggle":
      return { kind: "toggle" };
    case "set_brightness":
      return { kind: "set_brightness", value: intent.value ?? 0 };
    case "adjust_brightness":
      return { kind: "adjust_brightness", delta: intent.value ?? 0 };
    default:
      return null;
  }
}

/** Replies that need no device (greetings, clarifications…). Null when the intent is an action/query. */
export function conversationalReply(intent: Intent, pct: (n: number) => string): Reply | null {
  switch (intent.kind) {
    case "greeting":
      return { key: "assistant.reply.greeting" };
    case "help":
      return { key: "assistant.reply.help" };
    case "thanks":
      return { key: "assistant.reply.thanks" };
    case "ambiguous":
      return { key: "assistant.reply.ambiguous" };
    case "clarify_value":
      return { key: "assistant.reply.clarifyValue" };
    case "clarify_number":
      return { key: "assistant.reply.clarifyNumber", vars: { value: pct(intent.value ?? 0) } };
    case "unknown":
      return { key: "assistant.reply.notUnderstood" };
    default:
      return null;
  }
}

/** Answer to "is the light on?" — only from reliable state. */
export function stateReply(target: TargetSnapshot | null, pct: (n: number) => string): Reply {
  if (!target) return { key: "assistant.reply.noTarget" };
  if (!target.simulated && target.connection === "offline") return { key: "assistant.reply.offline", vars: { name: target.name } };
  const st = target.state;
  if (!st) return { key: "assistant.reply.stateUnknown" };
  if (!st.on) return { key: "assistant.reply.stateOff" };
  if (target.dimmable && st.brightness !== null) return { key: "assistant.reply.stateOnLevel", vars: { value: pct(st.brightness) } };
  return { key: "assistant.reply.stateOn" };
}

export function executionReply(
  cmd: ExperienceCommand,
  exec: Execution,
  target: TargetSnapshot,
  pct: (n: number) => string,
  errorText: (category: ErrorCategory) => string,
): Reply {
  const r = exec.result ?? null;
  const brightnessCmd = cmd.kind === "set_brightness" || cmd.kind === "adjust_brightness";
  switch (exec.state) {
    case "simulated":
      if (r && !r.on) return { key: "assistant.reply.turnedOffSim" };
      if (brightnessCmd && r && r.brightness !== null) return { key: "assistant.reply.brightnessSim", vars: { value: pct(r.brightness) } };
      return { key: "assistant.reply.turnedOnSim" };
    case "confirmed":
      if (!r) return { key: "assistant.reply.sentUnconfirmed" };
      if (!r.on) return { key: "assistant.reply.turnedOff" };
      if (brightnessCmd && r.brightness !== null) return { key: "assistant.reply.brightnessSet", vars: { value: pct(r.brightness) } };
      return { key: "assistant.reply.turnedOn" };
    case "accepted":
      return { key: "assistant.reply.sentUnconfirmed" };
    case "already":
      if (cmd.kind === "turn_on") return { key: "assistant.reply.alreadyOn" };
      if (cmd.kind === "turn_off") return { key: "assistant.reply.alreadyOff" };
      if (r && !r.on) return { key: "assistant.reply.alreadyOff" };
      if (r && r.brightness !== null) return { key: "assistant.reply.alreadyLevel", vars: { value: pct(r.brightness) } };
      return { key: "assistant.reply.alreadyOn" };
    case "unknown":
      return { key: cmd.kind === "adjust_brightness" ? "assistant.reply.relativeUnknown" : "assistant.reply.stateUnknown" };
    case "offline":
      return { key: "assistant.reply.offline", vars: { name: target.name } };
    case "timeout":
      return { key: "assistant.reply.timeout" };
    case "blocked":
      return { key: exec.error === "needsTest" ? "assistant.reply.needsTest" : "assistant.reply.blocked" };
    default:
      if (exec.code && RATE_LIMIT_CODES.has(exec.code)) return { key: "assistant.reply.rateLimited" };
      if (exec.error === "busy") return { key: "assistant.reply.busy" };
      if (exec.error === "unsupported" && brightnessCmd) return { key: "assistant.reply.notDimmable" };
      return { key: "assistant.reply.failed", vars: { reason: errorText(exec.error ?? "unexpected") } };
  }
}
