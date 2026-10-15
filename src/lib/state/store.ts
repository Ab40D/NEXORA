"use client";

import { create } from "zustand";
import { SimulationAdapter } from "@/lib/adapters/simulation-adapter";
import type { AdapterEvent, LightAdapter } from "@/lib/adapters/types";
import { dispatchCommand, type DispatchResult } from "@/lib/commands/dispatcher";
import { createInitialState, lightReducer, type LightEvent } from "./light-machine";
import { effectiveValue } from "./selectors";
import type { CommandSource, LightState, LightTarget, OnOff } from "./types";

interface AppStore {
  light: LightState;
  adapter: LightAdapter;
  dispatch: (event: LightEvent) => void;
  requestCommand: (value: OnOff, source: CommandSource) => Promise<DispatchResult>;
  toggle: (source: CommandSource) => Promise<DispatchResult>;
  setPaused: (paused: boolean) => void;
  activateAdapter: (adapter: LightAdapter, opts: { target: LightTarget | null }) => Promise<void>;
  switchToSimulation: () => Promise<void>;
  refreshState: () => Promise<void>;
  note: (title: string, detail?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger") => void;
}

let adapterUnsub: (() => void) | null = null;

export const useAppStore = create<AppStore>((set, get) => {
  const simulation = new SimulationAdapter();

  const dispatch = (event: LightEvent) => set((s) => ({ light: lightReducer(s.light, event) }));

  const onAdapterEvent = (adapter: LightAdapter) => (ev: AdapterEvent) => {
    if (get().adapter !== adapter) return; // stale adapter
    const at = Date.now();
    if (ev.type === "link") dispatch({ type: "LINK_CHANGED", status: ev.status, message: ev.message ?? null, at });
    else if (ev.type === "state") dispatch({ type: "STATE_REPORTED", value: ev.value, via: ev.via, detail: ev.detail, at });
    else dispatch({ type: "NOTE", title: ev.title, detail: ev.detail, tone: ev.tone, at });
  };

  return {
    light: createInitialState(0),
    adapter: simulation,
    dispatch,

    requestCommand: (value, source) =>
      dispatchCommand(
        {
          getState: () => get().light,
          dispatch,
          getAdapter: () => get().adapter,
        },
        { value, source },
      ),

    toggle: (source) => {
      const current = effectiveValue(get().light);
      return get().requestCommand(current === "on" ? "off" : "on", source);
    },

    setPaused: (paused) => dispatch({ type: "DISPATCH_PAUSED", paused, at: Date.now() }),

    activateAdapter: async (adapter, opts) => {
      const previous = get().adapter;
      adapterUnsub?.();
      adapterUnsub = null;
      if (previous !== adapter && previous !== simulation) await previous.dispose().catch(() => undefined);
      set({ adapter });
      dispatch({ type: "MODE_CHANGED", mode: adapter.mode, backendLabel: adapter.mode === "simulation" ? null : adapter.label, at: Date.now() });
      dispatch({ type: "TARGET_SET", target: opts.target, feedbackAvailable: adapter.feedbackAvailable, at: Date.now() });
      adapterUnsub = adapter.subscribe(onAdapterEvent(adapter));
      await adapter.start?.();
    },

    switchToSimulation: async () => {
      if (get().adapter === simulation) return;
      await get().activateAdapter(simulation, { target: null });
    },

    refreshState: async () => {
      await get().adapter.refreshState();
    },

    note: (title, detail, tone = "neutral") => dispatch({ type: "NOTE", title, detail, tone, at: Date.now() }),
  };
});
