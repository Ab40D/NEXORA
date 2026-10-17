"use client";
/**
 * Smart Light Experience — the selected light ("target") and the single command pipeline used
 * by the experience UI, the Digital Twin, voice, gestures and "Talk to SE7ENX".
 *
 * Targets:
 *  - "sim": a dimmable light simulated in the browser. It never touches the network.
 *  - "hub": a device of the SE7ENX hub. Commands go through the hub's own pipeline
 *    (capability → emergency stop → control enabled → connection → rate limit → busy → timeout),
 *    so there is exactly one command path per device.
 *
 * Honesty rules: "already on" for real devices only comes from the hub (`already_satisfied`,
 * based on reliable reported state); "accepted" is never shown as confirmed; hands-free sources
 * are refused while the emergency stop is active; nothing is queued or retried automatically.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { HubCommand, HubDevice } from "@/lib/hub/contract";
import { useHub } from "@/lib/hub/hub-store";
import { useAppStore } from "@/lib/state/store";
import type { CommandSource } from "@/lib/state/types";
import { errorCategory, type ErrorCategory } from "./errors";

export type ExperienceCommand =
  { kind: "turn_on" } | { kind: "turn_off" } | { kind: "toggle" } | { kind: "set_brightness"; value: number } | { kind: "adjust_brightness"; delta: number };

export type ExecState = "pending" | "executing" | "accepted" | "confirmed" | "simulated" | "already" | "failed" | "timeout" | "unknown" | "offline" | "blocked";

export interface LightLevel {
  on: boolean;
  /** 0-100, or null when unknown / not reported */
  brightness: number | null;
}

export interface Execution {
  id: number;
  command: ExperienceCommand;
  source: CommandSource;
  state: ExecState;
  error?: ErrorCategory;
  /** machine-readable error code from the hub (e.g. DEVICE_RATE_LIMITED) */
  code?: string;
  /** original (English) detail from the hub, shown under "Technical details" */
  detail?: string;
  /** what was asked for, while the command is in flight */
  requested?: LightLevel;
  /** state reported after the command finished (null = unknown) */
  result?: LightLevel | null;
  at: number;
}

export type Provider = "simulation" | "hubSimulated" | "homeassistant" | "knx" | "shelly";

export interface TargetSnapshot {
  kind: "sim" | "hub";
  id: string;
  name: string;
  provider: Provider;
  simulated: boolean;
  dimmable: boolean;
  connection: "online" | "offline" | "unknown";
  /** reliable current state; null when unknown, stale or not reported */
  state: LightLevel | null;
  /** last reported state even when it cannot be trusted right now (for display only) */
  lastKnown: LightLevel | null;
  pending: boolean;
  controlEnabled: boolean;
  controlAllowed: boolean;
  /** the device reports its state at all (otherwise results can never be confirmed) */
  hasFeedback: boolean;
}

export const SIM_ID = "browser-sim";
const SIM_DELAY_MS = 220;
const HANDS_FREE: readonly CommandSource[] = ["gesture", "voice", "assistant"];
const UNRELIABLE_SOURCES = new Set(["bus_observed"]);

interface ExperienceStore {
  target: "none" | "sim" | "hub";
  deviceId: string | null;
  sim: { on: boolean; brightness: number };
  exec: Execution | null;
  history: Execution[];
  busy: boolean;
  selectSim: () => void;
  selectDevice: (id: string) => void;
  clearTarget: () => void;
  execute: (command: ExperienceCommand, source: CommandSource) => Promise<Execution>;
}

let seq = 0;

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function isBrightnessCommand(c: ExperienceCommand): boolean {
  return c.kind === "set_brightness" || c.kind === "adjust_brightness";
}

/** Next simulated state for a command (pure). */
export function resolveSim(s: { on: boolean; brightness: number }, c: ExperienceCommand): { on: boolean; brightness: number } {
  switch (c.kind) {
    case "turn_on":
      return { on: true, brightness: s.brightness > 0 ? s.brightness : 100 };
    case "turn_off":
      return { on: false, brightness: s.brightness };
    case "toggle":
      return s.on ? { on: false, brightness: s.brightness } : { on: true, brightness: s.brightness > 0 ? s.brightness : 100 };
    case "set_brightness": {
      const v = clamp(c.value);
      return v === 0 ? { on: false, brightness: s.brightness } : { on: true, brightness: v };
    }
    case "adjust_brightness": {
      const v = clamp((s.on ? s.brightness : 0) + c.delta);
      return v === 0 ? { on: false, brightness: s.brightness } : { on: true, brightness: v };
    }
  }
}

function providerOf(d: HubDevice): Provider {
  if (d.simulated) return "hubSimulated";
  return d.integration === "homeassistant" || d.integration === "knx" || d.integration === "shelly" ? d.integration : "hubSimulated";
}

function levelOf(reported: Record<string, unknown>): LightLevel | null {
  if (typeof reported.on !== "boolean") return null;
  const b = reported.brightness;
  return { on: reported.on, brightness: typeof b === "number" ? clamp(b) : null };
}

export function snapshotOfDevice(d: HubDevice, safetyActive: boolean): TargetSnapshot {
  const connection = d.connection.status === "online" ? "online" : d.connection.status === "unknown" ? "unknown" : "offline";
  const lastKnown = levelOf(d.state.reported);
  const reliable = lastKnown !== null && (d.simulated || (connection === "online" && !d.state.pending && !UNRELIABLE_SOURCES.has(d.state.source ?? "")));
  return {
    kind: "hub",
    id: d.id,
    name: d.name,
    provider: providerOf(d),
    simulated: d.simulated,
    dimmable: d.capabilities.includes("brightness"),
    connection,
    state: reliable ? lastKnown : null,
    lastKnown,
    pending: d.state.pending,
    controlEnabled: d.controlEnabled,
    controlAllowed: d.controlEnabled && (d.simulated || !safetyActive),
    hasFeedback: d.simulated || d.state.reportedAt !== null || Object.keys(d.state.reported).length > 0,
  };
}

/** The currently selected light, or null. */
export function selectTarget(
  s: Pick<ExperienceStore, "target" | "deviceId" | "sim">,
  hub: { devices: Record<string, HubDevice>; safety: { active: boolean } | null },
  simName = "SE7ENX",
): TargetSnapshot | null {
  if (s.target === "sim") {
    const level = { on: s.sim.on, brightness: s.sim.brightness };
    return {
      kind: "sim",
      id: SIM_ID,
      name: simName,
      provider: "simulation",
      simulated: true,
      dimmable: true,
      connection: "online",
      state: level,
      lastKnown: level,
      pending: false,
      controlEnabled: true,
      controlAllowed: true,
      hasFeedback: true,
    };
  }
  if (s.target === "hub" && s.deviceId) {
    const d = hub.devices[s.deviceId];
    return d ? snapshotOfDevice(d, hub.safety?.active ?? false) : null;
  }
  return null;
}

function toHub(c: ExperienceCommand): [HubCommand, Record<string, unknown>] {
  switch (c.kind) {
    case "set_brightness":
      return ["set_brightness", { brightness: clamp(c.value) }];
    case "adjust_brightness":
      return ["adjust_brightness", { delta: Math.max(-100, Math.min(100, Math.round(c.delta))) }];
    default:
      return [c.kind, {}];
  }
}

/** What the command asks for, given a reliable state (for the pending display only). */
function requestedFor(c: ExperienceCommand, state: LightLevel | null): LightLevel | undefined {
  switch (c.kind) {
    case "turn_on":
      return { on: true, brightness: state?.brightness ?? null };
    case "turn_off":
      return { on: false, brightness: state?.brightness ?? null };
    case "toggle":
      return state ? { on: !state.on, brightness: state.brightness } : undefined;
    case "set_brightness":
      return c.value <= 0 ? { on: false, brightness: null } : { on: true, brightness: clamp(c.value) };
    case "adjust_brightness": {
      if (!state || (state.on && state.brightness === null)) return undefined;
      const v = clamp((state.on ? (state.brightness ?? 0) : 0) + c.delta);
      return v === 0 ? { on: false, brightness: null } : { on: true, brightness: v };
    }
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useExperience = create<ExperienceStore>()(
  persist(
    (set, get) => ({
      target: "none",
      deviceId: null,
      sim: { on: false, brightness: 70 },
      exec: null,
      history: [],
      busy: false,

      selectSim: () => set({ target: "sim", deviceId: null, exec: null }),
      selectDevice: (id) => set({ target: "hub", deviceId: id, exec: null }),
      clearTarget: () => set({ target: "none", deviceId: null, exec: null }),

      execute: async (command, source) => {
        const id = ++seq;
        let current: Execution = { id, command, source, state: "pending", at: Date.now() };
        const update = (patch: Partial<Execution>): Execution => {
          current = { ...current, ...patch };
          const snapshot = current;
          set((s) => ({ exec: snapshot, history: [snapshot, ...s.history.filter((h) => h.id !== id)].slice(0, 12) }));
          return snapshot;
        };
        update({});

        if (HANDS_FREE.includes(source) && useAppStore.getState().light.dispatchPaused) {
          return update({ state: "blocked", error: "blocked" });
        }
        if (get().busy) return update({ state: "failed", error: "busy" });
        const hub = useHub.getState();
        const target = selectTarget(get(), hub);
        if (!target) return update({ state: "failed", error: "unexpected" });
        if (isBrightnessCommand(command) && !target.dimmable) return update({ state: "failed", error: "unsupported" });

        if (target.kind === "sim") {
          const before = get().sim;
          const next = resolveSim(before, command);
          if (next.on === before.on && (!next.on || next.brightness === before.brightness)) {
            return update({ state: "already", result: { on: before.on, brightness: before.brightness } });
          }
          update({ state: "executing", requested: next });
          set({ busy: true });
          await delay(SIM_DELAY_MS);
          set({ sim: next, busy: false });
          return update({ state: "simulated", result: next });
        }

        const [cmd, params] = toHub(command);
        update({ state: "executing", requested: requestedFor(command, target.state) });
        set({ busy: true });
        let res;
        try {
          res = await hub.command(target.id, cmd, params, source);
        } finally {
          set({ busy: false });
        }
        if (!res) return update({ state: "failed", error: "busy" });
        const device = useHub.getState().devices[target.id];
        const after = device ? levelOf(device.state.reported) : null;
        if (res.ok) {
          const state: ExecState =
            res.outcome === "confirmed"
              ? "confirmed"
              : res.outcome === "simulated"
                ? "simulated"
                : res.outcome === "already_satisfied"
                  ? "already"
                  : "accepted";
          return update({ state, result: after, detail: res.text });
        }
        const category = errorCategory(res.code, res.status);
        const state: ExecState =
          category === "offline"
            ? "offline"
            : category === "timeout"
              ? "timeout"
              : category === "stateUnknown"
                ? "unknown"
                : category === "blocked" || category === "needsTest"
                  ? "blocked"
                  : "failed";
        return update({ state, error: category, code: res.code, detail: res.hint ? `${res.text} — ${res.hint}` : res.text });
      },
    }),
    {
      name: "se7enx.experience.v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ target: s.target, deviceId: s.deviceId }),
    },
  ),
);

/** Hook: the selected light, kept in sync with hub device updates. */
export function useTarget(): TargetSnapshot | null {
  const target = useExperience((s) => s.target);
  const deviceId = useExperience((s) => s.deviceId);
  const sim = useExperience((s) => s.sim);
  const devices = useHub((s) => s.devices);
  const safety = useHub((s) => s.safety);
  return selectTarget({ target, deviceId, sim }, { devices, safety });
}
