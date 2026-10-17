import { describe, expect, it } from "vitest";
import { createInitialState, HISTORY_LIMIT, lightReducer, type LightEvent } from "@/lib/state/light-machine";
import { effectiveValue, FEEDBACK_GRACE_MS, selectLampView } from "@/lib/state/selectors";
import type { LightState, LightTarget } from "@/lib/state/types";

const target: LightTarget = {
  groupAddress: "0/0/1",
  displayAddress: "0/0/1",
  statusAddress: "0/0/2",
  displayStatusAddress: "0/0/2",
  dpt: "1.001",
  onLevel: 100,
};

function apply(state: LightState, ...events: LightEvent[]): LightState {
  return events.reduce(lightReducer, state);
}

function realConnected(feedback = true): LightState {
  return apply(
    createInitialState(0),
    { type: "MODE_CHANGED", mode: "bridge", backendLabel: "Bridge", at: 1 },
    { type: "TARGET_SET", target: feedback ? target : { ...target, statusAddress: null, displayStatusAddress: null }, feedbackAvailable: feedback, at: 2 },
    { type: "LINK_CHANGED", status: "connected", at: 3 },
  );
}

describe("simulation transitions", () => {
  it("starts in simulation with the lamp off and a SIMULATION label", () => {
    const s = createInitialState(0);
    const v = selectLampView(s, 0);
    expect(s.mode).toBe("simulation");
    expect(v.label).toBe("SIMULATION · OFF");
    expect(v.certainty).toBe("simulated");
  });

  it("applies a simulated command only after it settles", () => {
    let s = apply(createInitialState(0), { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "manual", at: 10 });
    expect(s.simulated).toBe("off");
    expect(selectLampView(s, 10).pending).toBe("on");
    s = lightReducer(s, { type: "COMMAND_SETTLED", id: "c1", phase: "simulated", at: 20 });
    expect(s.simulated).toBe("on");
    expect(selectLampView(s, 20).label).toBe("SIMULATION · ON");
  });

  it("ignores reported states while in simulation (never mixes real and simulated)", () => {
    const s = apply(createInitialState(0), { type: "STATE_REPORTED", value: "on", via: "status_address", at: 5 });
    expect(s.reported.value).toBe("unknown");
    expect(s.simulated).toBe("off");
  });
});

describe("real-mode transitions", () => {
  it("switching mode resets requested and reported state and shows CONNECTING", () => {
    const s = apply(createInitialState(0), { type: "MODE_CHANGED", mode: "bridge", backendLabel: "B", at: 1 });
    expect(s.link.status).toBe("connecting");
    expect(selectLampView(s, 1).label).toBe("CONNECTING");
    expect(s.lastCommand).toBeNull();
  });

  it("a bus-confirmed command does not light the lamp until the device reports", () => {
    let s = apply(
      realConnected(true),
      { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "gesture", at: 100 },
      { type: "COMMAND_SETTLED", id: "c1", phase: "bus_confirmed", at: 150 },
    );
    let v = selectLampView(s, 200);
    expect(v.lit).toBe(false);
    expect(v.pending).toBe("on");
    s = lightReducer(s, { type: "STATE_REPORTED", value: "on", via: "status_address", at: 300 });
    v = selectLampView(s, 300);
    expect(v.lit).toBe(true);
    expect(v.certainty).toBe("confirmed");
    expect(v.label).toBe("ON");
  });

  it("flags missing feedback after the grace period", () => {
    const s = apply(
      realConnected(true),
      { type: "STATE_REPORTED", value: "off", via: "read_response", at: 50 },
      { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "manual", at: 100 },
      { type: "COMMAND_SETTLED", id: "c1", phase: "bus_confirmed", at: 120 },
    );
    expect(selectLampView(s, 500).feedbackMissing).toBe(false);
    const late = selectLampView(s, 120 + FEEDBACK_GRACE_MS + 1);
    expect(late.feedbackMissing).toBe(true);
    expect(late.lit).toBe(false); // still shows last REPORTED state
  });

  it("accepts status feedback that arrives before the command response settles (fast actuators)", () => {
    // The actuator's status telegram can reach the browser over the event stream before the HTTP
    // response of the command does. That feedback is valid: it was reported after the command was issued.
    const s = apply(
      realConnected(true),
      { type: "STATE_REPORTED", value: "off", via: "status_address", at: 50 },
      { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "test", at: 100 },
      { type: "STATE_REPORTED", value: "on", via: "status_address", at: 130 },
      { type: "COMMAND_SETTLED", id: "c1", phase: "bus_confirmed", at: 160 },
    );
    const v = selectLampView(s, 160 + FEEDBACK_GRACE_MS + 1000);
    expect(v.feedbackMissing).toBe(false);
    expect(v.certainty).toBe("confirmed");
    expect(v.label).toBe("ON");
    expect(v.detail).toBe("Confirmed by actuator status feedback.");
  });

  it("without feedback, shows the commanded state as UNVERIFIED", () => {
    const s = apply(
      realConnected(false),
      { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "voice", at: 100 },
      { type: "COMMAND_SETTLED", id: "c1", phase: "bus_confirmed", at: 130 },
    );
    const v = selectLampView(s, 200);
    expect(v.certainty).toBe("assumed");
    expect(v.label).toBe("ON · UNVERIFIED");
    expect(v.intensity).toBeLessThan(1);
  });

  it("failed commands never change displayed state", () => {
    const s = apply(
      realConnected(true),
      { type: "STATE_REPORTED", value: "off", via: "status_address", at: 10 },
      { type: "COMMAND_REQUESTED", id: "c1", value: "on", source: "manual", at: 100 },
      { type: "COMMAND_SETTLED", id: "c1", phase: "failed", errorCode: "KNX_CONFIRMATION_TIMEOUT", at: 3100 },
    );
    const v = selectLampView(s, 3200);
    expect(v.lit).toBe(false);
    expect(s.lastCommand?.errorCode).toBe("KNX_CONFIRMATION_TIMEOUT");
  });

  it("shows RECONNECTING with stale last-known state and ERROR on errors", () => {
    let s = apply(realConnected(true), { type: "STATE_REPORTED", value: "on", via: "status_address", at: 10 });
    s = lightReducer(s, { type: "LINK_CHANGED", status: "reconnecting", message: "lost", at: 20 });
    let v = selectLampView(s, 20);
    expect(v.label).toBe("RECONNECTING");
    expect(v.certainty).toBe("stale");
    s = lightReducer(s, { type: "LINK_CHANGED", status: "error", message: "boom", at: 30 });
    v = selectLampView(s, 30);
    expect(v.label).toBe("ERROR");
    expect(v.lit).toBe(false);
  });

  it("settlement of a stale command id does not overwrite the latest command", () => {
    const s = apply(
      realConnected(true),
      { type: "COMMAND_REQUESTED", id: "new", value: "off", source: "manual", at: 100 },
      { type: "COMMAND_SETTLED", id: "old", phase: "bus_confirmed", at: 110 },
    );
    expect(s.lastCommand?.id).toBe("new");
    expect(s.lastCommand?.phase).toBe("pending");
  });

  it("observed switch-address telegrams are marked as observed, not confirmed", () => {
    const s = apply(realConnected(false), { type: "STATE_REPORTED", value: "on", via: "switch_address", at: 10 });
    const v = selectLampView(s, 10);
    expect(v.certainty).toBe("observed");
    expect(v.intensity).toBeLessThan(1);
  });
});

describe("effective value & history", () => {
  it("uses the newest of reported state and successful command", () => {
    let s = apply(realConnected(true), { type: "STATE_REPORTED", value: "off", via: "status_address", at: 10 });
    expect(effectiveValue(s)).toBe("off");
    s = apply(s, { type: "COMMAND_REQUESTED", id: "c", value: "on", source: "manual", at: 20 }, { type: "COMMAND_SETTLED", id: "c", phase: "bus_confirmed", at: 25 });
    expect(effectiveValue(s)).toBe("on");
    s = lightReducer(s, { type: "STATE_REPORTED", value: "off", via: "status_address", at: 30 });
    expect(effectiveValue(s)).toBe("off");
  });

  it("records the emergency stop and caps history length", () => {
    let s = lightReducer(createInitialState(0), { type: "DISPATCH_PAUSED", paused: true, at: 1 });
    expect(s.dispatchPaused).toBe(true);
    expect(s.history[0]!.kind).toBe("safety");
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s = lightReducer(s, { type: "NOTE", title: `n${i}`, at: i });
    expect(s.history.length).toBe(HISTORY_LIMIT);
  });
});
