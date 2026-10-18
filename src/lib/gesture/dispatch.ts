"use client";

/**
 * Gesture → action. A recognised gesture is only a *request*: it goes through the same
 * pipelines as a click (Experience pipeline for the selected light, the hub command API for
 * hub devices), so the emergency stop, roles/permissions and hub policy all apply. The result
 * reports what actually happened (confirmed / accepted / simulated / refused), never what we
 * hoped would happen.
 */
import { EXEC_KEY } from "@/lib/experience/labels";
import { useExperience } from "@/lib/experience/store";
import type { HubCommand, HubDevice } from "@/lib/hub/contract";
import { useHub } from "@/lib/hub/hub-store";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import { ACTION_COMMAND, type GestureAction, type GestureId, type GestureProfile, type GestureTarget } from "./profiles";

export type GestureOutcome = "confirmed" | "accepted" | "simulated" | "already" | "partial" | "blocked" | "failed";

export interface GestureDispatchResult {
  gesture: GestureId;
  action: GestureAction;
  ok: boolean;
  outcome: GestureOutcome;
  message: string;
  target: string;
  at: number;
}

export interface DispatchContext {
  /** gestures may be switched off independently of the camera */
  gesturesEnabled: boolean;
}

const OK: GestureOutcome[] = ["confirmed", "accepted", "simulated", "already"];

function result(gesture: GestureId, action: GestureAction, outcome: GestureOutcome, message: string, target: string): GestureDispatchResult {
  return { gesture, action, ok: OK.includes(outcome), outcome, message, target, at: Date.now() };
}

/** Devices a target refers to, filtered to those that can run the command. */
export function resolveTargetDevices(
  target: GestureTarget,
  devices: Record<string, HubDevice>,
  command: string,
  experienceDeviceId: string | null,
): { label: string; devices: HubDevice[]; missing: boolean } {
  if (target.type === "device" || (target.type === "experience" && experienceDeviceId)) {
    const id = target.type === "device" ? target.deviceId : experienceDeviceId!;
    const d = devices[id];
    if (!d) return { label: id, devices: [], missing: true };
    return { label: d.name, devices: d.commands.includes(command) ? [d] : [], missing: false };
  }
  if (target.type === "room") {
    const inRoom = Object.values(devices).filter((d) => d.metadata.roomId === target.roomId && !d.hidden);
    return { label: target.roomId, devices: inRoom.filter((d) => d.commands.includes(command)), missing: false };
  }
  return { label: "", devices: [], missing: true };
}

function hubOutcome(o: string | undefined): GestureOutcome {
  if (o === "confirmed") return "confirmed";
  if (o === "simulated") return "simulated";
  if (o === "already_satisfied") return "already";
  return "accepted";
}

export async function dispatchGesture(
  gesture: GestureId,
  profile: GestureProfile,
  ctx: DispatchContext,
  roomName?: (roomId: string) => string | undefined,
): Promise<GestureDispatchResult | null> {
  const action = profile.bindings[gesture];
  if (!action) return null;
  const app = useAppStore.getState();

  if (action === "pause_hands_free") {
    if (app.light.dispatchPaused) return result(gesture, action, "already", t("gesture.result.alreadyPaused"), "");
    app.setPaused(true);
    return result(gesture, action, "confirmed", t("gesture.result.handsFreePaused"), "");
  }
  if (!ctx.gesturesEnabled) return result(gesture, action, "blocked", t("gesture.result.disabled"), "");
  if (app.light.dispatchPaused) return result(gesture, action, "blocked", t("gesture.result.stopped"), "");

  const spec = ACTION_COMMAND[action];
  const xp = useExperience.getState();
  const target = profile.target;

  // Simulated light of the Experience: the Experience pipeline handles it (light actions only).
  if (target.type === "experience" && xp.target === "sim") {
    const kind =
      action === "turn_on" || action === "turn_off" || action === "toggle"
        ? { kind: action }
        : action === "brightness_up" || action === "brightness_down"
          ? { kind: "adjust_brightness" as const, delta: spec.params?.delta ?? 0 }
          : null;
    if (!kind) return result(gesture, action, "failed", t("gesture.result.unsupported", { name: t("gesture.result.simLight") }), "sim");
    const exec = await xp.execute(kind, "gesture");
    const outcome: GestureOutcome =
      exec.state === "simulated" ? "simulated" : exec.state === "already" ? "already" : exec.state === "confirmed" ? "confirmed" : exec.state === "blocked" ? "blocked" : "failed";
    const detail = exec.error && exec.state !== "already" ? ` — ${t(`errors.${exec.error}.message` as never)}` : "";
    return result(gesture, action, outcome, t(EXEC_KEY[exec.state]) + detail, t("gesture.result.simLight"));
  }
  if (target.type === "experience" && xp.target !== "hub") {
    return result(gesture, action, "failed", t("gesture.result.noTarget"), "");
  }

  const hub = useHub.getState();
  if (hub.status !== "ready") return result(gesture, action, "failed", t("gesture.result.noHub"), "");
  if (hub.safety.active) return result(gesture, action, "blocked", t("gesture.result.hubStopped"), "");
  const resolved = resolveTargetDevices(target, hub.devices, spec.command, xp.target === "hub" ? xp.deviceId : null);
  const label = target.type === "room" ? (roomName?.(target.roomId) ?? resolved.label) : resolved.label;
  if (resolved.missing) return result(gesture, action, "failed", t("gesture.result.deviceMissing"), label);
  if (resolved.devices.length === 0) {
    const key = target.type === "room" ? "gesture.result.roomEmpty" : "gesture.result.unsupported";
    return result(gesture, action, "failed", t(key, { name: label }), label);
  }

  const outcomes: GestureOutcome[] = [];
  const texts: string[] = [];
  for (const d of resolved.devices) {
    const r = await hub.command(d.id, spec.command as HubCommand, spec.params ?? {}, "gesture");
    if (!r) {
      outcomes.push("failed");
      texts.push(`${d.name}: ${t("gesture.result.busy")}`);
    } else if (r.ok) {
      outcomes.push(hubOutcome(r.outcome));
      texts.push(resolved.devices.length > 1 ? `${d.name}: ${r.text}` : r.text);
    } else {
      outcomes.push(r.status === 403 || r.code === "SAFETY_STOP" ? "blocked" : "failed");
      texts.push(resolved.devices.length > 1 ? `${d.name}: ${r.text}` : r.text);
    }
  }
  const okCount = outcomes.filter((o) => OK.includes(o)).length;
  const outcome: GestureOutcome =
    outcomes.length === 1 ? outcomes[0]! : okCount === outcomes.length ? (outcomes.every((o) => o === outcomes[0]) ? outcomes[0]! : "accepted") : okCount > 0 ? "partial" : outcomes.includes("blocked") ? "blocked" : "failed";
  const message = outcomes.length > 1 ? t("gesture.result.summary", { ok: okCount, total: outcomes.length, detail: texts.join(" · ") }) : texts[0]!;
  return result(gesture, action, outcome, message, label);
}
