import { describe, expect, it, vi } from "vitest";
import { AdapterError, type LightAdapter } from "@/lib/adapters/types";
import { SimulationAdapter } from "@/lib/adapters/simulation-adapter";
import { dispatchCommand } from "@/lib/commands/dispatcher";
import { evaluateCommand } from "@/lib/commands/policy";
import { createInitialState, lightReducer, type LightEvent } from "@/lib/state/light-machine";
import type { LightState } from "@/lib/state/types";

function harness(initial: LightState, adapter: LightAdapter | null) {
  let state = initial;
  let t = 1000;
  const events: LightEvent[] = [];
  const deps = {
    getState: () => state,
    dispatch: (e: LightEvent) => {
      events.push(e);
      state = lightReducer(state, e);
    },
    getAdapter: () => adapter,
    now: () => t,
    genId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
  };
  return {
    deps,
    events,
    get state() {
      return state;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

function bridgeState(): LightState {
  return [
    { type: "MODE_CHANGED", mode: "bridge", backendLabel: "B", at: 1 } as LightEvent,
    {
      type: "TARGET_SET",
      target: { groupAddress: "0/0/1", displayAddress: "0/0/1", statusAddress: null, displayStatusAddress: null, dpt: "1.001", onLevel: 100 },
      feedbackAvailable: false,
      at: 2,
    } as LightEvent,
    { type: "LINK_CHANGED", status: "connected", at: 3 } as LightEvent,
  ].reduce(lightReducer, createInitialState(0));
}

function fakeAdapter(impl: LightAdapter["send"]): LightAdapter {
  return {
    mode: "bridge",
    label: "fake",
    feedbackAvailable: false,
    send: vi.fn(impl),
    refreshState: async () => undefined,
    subscribe: () => () => undefined,
    dispose: async () => undefined,
  };
}

describe("command policy", () => {
  it("blocks gesture and voice while paused but allows manual control", () => {
    const s = lightReducer(createInitialState(0), { type: "DISPATCH_PAUSED", paused: true, at: 1 });
    expect(evaluateCommand(s, { value: "on", source: "gesture" }, 5000)).toEqual({ ok: false, reason: "paused" });
    expect(evaluateCommand(s, { value: "on", source: "voice" }, 5000)).toEqual({ ok: false, reason: "paused" });
    expect(evaluateCommand(s, { value: "on", source: "manual" }, 5000)).toEqual({ ok: true });
  });

  it("blocks real commands when not connected", () => {
    const s = lightReducer(bridgeState(), { type: "LINK_CHANGED", status: "reconnecting", at: 10 });
    expect(evaluateCommand(s, { value: "on", source: "manual" }, 5000)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("suppresses duplicate gestures but not manual commands", () => {
    const s = createInitialState(0); // simulated off
    expect(evaluateCommand(s, { value: "off", source: "gesture" }, 5000)).toEqual({ ok: false, reason: "duplicate" });
    expect(evaluateCommand(s, { value: "off", source: "manual" }, 5000)).toEqual({ ok: true });
  });
});

describe("dispatchCommand", () => {
  it("maps a simulation command to the simulated phase", async () => {
    const h = harness(createInitialState(0), new SimulationAdapter(1));
    const r = await dispatchCommand(h.deps, { value: "on", source: "manual" });
    expect(r).toMatchObject({ status: "done", phase: "simulated" });
    expect(h.state.simulated).toBe("on");
  });

  it("enforces one in-flight command at a time and the minimum interval", async () => {
    let release!: () => void;
    let calls = 0;
    const adapter = fakeAdapter(() => {
      calls++;
      if (calls > 1) return Promise.resolve({ phase: "bus_confirmed", detail: "ok" });
      return new Promise((res) => (release = () => res({ phase: "bus_confirmed", detail: "ok" })));
    });
    const h = harness(bridgeState(), adapter);
    const first = dispatchCommand(h.deps, { value: "on", source: "manual" });
    const second = await dispatchCommand(h.deps, { value: "off", source: "manual" });
    expect(second).toEqual({ status: "blocked", reason: "busy" });
    release();
    await first;
    const third = await dispatchCommand(h.deps, { value: "off", source: "manual" });
    expect(third).toEqual({ status: "blocked", reason: "rate_limited" });
    h.advance(600);
    const fourth = await dispatchCommand(h.deps, { value: "off", source: "manual" });
    expect(fourth.status).toBe("done");
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });

  it("records backend errors with code and hint and never reports success", async () => {
    const adapter = fakeAdapter(async () => {
      throw new AdapterError("KNX_CONFIRMATION_TIMEOUT", "No L_Data.con", { hint: "Check the interface" });
    });
    const h = harness(bridgeState(), adapter);
    const r = await dispatchCommand(h.deps, { value: "on", source: "voice" });
    expect(r).toMatchObject({ status: "failed", code: "KNX_CONFIRMATION_TIMEOUT" });
    expect(h.state.lastCommand?.phase).toBe("failed");
    expect(h.state.lastCommand?.detail).toContain("Check the interface");
  });

  it("times out hung backends", async () => {
    const adapter = fakeAdapter(() => new Promise(() => undefined));
    const h = harness(bridgeState(), adapter);
    const r = await dispatchCommand({ ...h.deps, timeoutMs: 30 }, { value: "on", source: "manual" });
    expect(r).toMatchObject({ status: "failed", code: "TIMEOUT" });
  });

  it("refuses to use an adapter that belongs to a different mode", async () => {
    const h = harness(bridgeState(), new SimulationAdapter(1));
    const r = await dispatchCommand(h.deps, { value: "on", source: "manual" });
    expect(r).toMatchObject({ status: "failed", code: "NO_ADAPTER" });
  });

  it("logs blocked commands in history (except silent gesture duplicates)", async () => {
    const paused = lightReducer(createInitialState(0), { type: "DISPATCH_PAUSED", paused: true, at: 1 });
    const h = harness(paused, new SimulationAdapter(1));
    await dispatchCommand(h.deps, { value: "on", source: "voice" });
    expect(h.state.history[0]!.kind).toBe("blocked");
    const h2 = harness(createInitialState(0), new SimulationAdapter(1));
    await dispatchCommand(h2.deps, { value: "off", source: "gesture" });
    expect(h2.events).toHaveLength(0);
  });
});
