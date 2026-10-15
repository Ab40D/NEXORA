import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeAdapter } from "@/lib/adapters/bridge-adapter";
import { AdapterError, type AdapterEvent } from "@/lib/adapters/types";
import { BridgeClient } from "@/lib/bridge/client";
import { dispatchCommand } from "@/lib/commands/dispatcher";
import { createInitialState, lightReducer, type LightEvent } from "@/lib/state/light-machine";
import { selectLampView } from "@/lib/state/selectors";
import type { LightState } from "@/lib/state/types";
import { startMockBridge, type MockBridge } from "../mocks/mock-bridge";

let bridge: MockBridge;

beforeEach(async () => {
  bridge = await startMockBridge();
});
afterEach(async () => {
  await bridge.close();
});

async function paired(): Promise<BridgeClient> {
  const client = new BridgeClient({ baseUrl: bridge.url, appOrigin: "https://se7enx.example" });
  await client.pair("abcd-2345", "vitest");
  return client;
}

function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("timeout waiting for condition"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe("BridgeClient", () => {
  it("validates health and pairs only with the right code", async () => {
    const client = new BridgeClient({ baseUrl: bridge.url });
    const h = await client.health();
    expect(h.service).toBe("se7enx-bridge");
    await expect(client.pair("WRONG000", "t")).rejects.toMatchObject({ code: "PAIRING_FAILED", hint: expect.stringContaining("code") });
    expect(client.hasToken).toBe(false);
    await client.pair("ABCD-2345", "t");
    expect(client.hasToken).toBe(true);
    const s = await client.session();
    expect(s.policy.allowedGroupAddresses).toEqual(["0/0/*"]);
  });

  it("refuses authenticated calls before pairing", async () => {
    const client = new BridgeClient({ baseUrl: bridge.url });
    await expect(client.session()).rejects.toMatchObject({ code: "NOT_PAIRED" });
  });

  it("rejects responses that violate the contract", async () => {
    const client = await paired();
    bridge.state.malformedSession = true;
    await expect(client.session()).rejects.toMatchObject({ code: "CONTRACT_MISMATCH" });
  });

  it("maps an unreachable bridge to an actionable error mentioning the allowed origin", async () => {
    const dead = new BridgeClient({ baseUrl: "http://127.0.0.1:9", appOrigin: "https://se7enx.example", timeoutMs: 2000 });
    const e = await dead.health().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe("BRIDGE_UNREACHABLE");
    expect((e as AdapterError).hint).toContain("https://se7enx.example");
  });

  it("surfaces bridge error codes and hints", async () => {
    const client = await paired();
    await expect(client.putLight("primary", { switchAddress: "1/2/3", statusAddress: null, dpt: "1.001", onLevel: 100 })).rejects.toMatchObject({
      code: "GA_NOT_ALLOWED",
      status: 403,
    });
  });
});

describe("BridgeAdapter", () => {
  async function adapter() {
    const client = await paired();
    const res = await client.putLight("primary", { switchAddress: "0/0/1", statusAddress: "0/0/2", dpt: "1.001", onLevel: 100 });
    const knx = await client.knxStatus();
    const a = new BridgeAdapter(client, res.light, knx);
    const events: AdapterEvent[] = [];
    a.subscribe((e) => events.push(e));
    return { a, events, client };
  }

  it("streams link and state events and maps outcomes truthfully", async () => {
    const { a, events } = await adapter();
    a.start();
    await waitFor(() => events.some((e) => e.type === "link" && e.status === "connected"));
    const out = await a.send("on", { requestId: "r1", source: "manual" });
    expect(out.phase).toBe("bus_confirmed");
    await waitFor(() => events.some((e) => e.type === "state" && e.value === "on" && e.via === "status_address"));
    expect(bridge.state.writes).toEqual([{ ga: "0/0/1", payload: 1 }]);
    await a.dispose();
  });

  it("reports routing sends as accepted, never as bus-confirmed", async () => {
    bridge.state.routing = true;
    const { a } = await adapter();
    const out = await a.send("off", { requestId: "r2", source: "voice" });
    expect(out.phase).toBe("accepted");
    await a.dispose();
  });

  it("propagates negative confirmations and timeouts as errors", async () => {
    const { a } = await adapter();
    bridge.state.confirm = "negative";
    await expect(a.send("on", { requestId: "n", source: "manual" })).rejects.toMatchObject({ code: "KNX_NEGATIVE_CONFIRMATION" });
    bridge.state.confirm = "none";
    await expect(a.send("on", { requestId: "t", source: "manual" })).rejects.toMatchObject({ code: "KNX_CONFIRMATION_TIMEOUT" });
    await a.dispose();
  });

  it("reconnects after the stream drops and reflects KNX link changes", async () => {
    const { a, events } = await adapter();
    a.start();
    await waitFor(() => bridge.streamCount() === 1);
    bridge.dropStreams();
    await waitFor(() => events.some((e) => e.type === "link" && e.status === "reconnecting"));
    await waitFor(() => bridge.streamCount() === 1, 4000);
    bridge.emitKnx("connecting");
    await waitFor(() => events.some((e) => e.type === "link" && e.status === "reconnecting" && /KNX interface/.test(e.message ?? "")));
    bridge.emitKnx("connected");
    await waitFor(() => events.filter((e) => e.type === "link" && e.status === "connected").length >= 2);
    await a.dispose();
  });

  it("explains a buffered event stream instead of waiting silently", async () => {
    bridge.state.bufferStream = true;
    const client = new BridgeClient({ baseUrl: bridge.url, streamTimeouts: { firstByteMs: 300 } });
    await client.pair("ABCD2345", "t");
    const res = await client.putLight("primary", { switchAddress: "0/0/1", statusAddress: "0/0/2", dpt: "1.001", onLevel: 100 });
    const a = new BridgeAdapter(client, res.light, await client.knxStatus());
    const events: AdapterEvent[] = [];
    a.subscribe((e) => events.push(e));
    a.start();
    await waitFor(() => events.some((e) => e.type === "link" && e.status === "reconnecting" && /buffering/.test(e.message ?? "")), 3000);
    await a.dispose();
  });

  it("stops and reports an error when the session is revoked (e.g. bridge restart)", async () => {
    const { a, events } = await adapter();
    a.start();
    await waitFor(() => bridge.streamCount() === 1);
    bridge.revokeAll();
    await waitFor(() => events.some((e) => e.type === "link" && e.status === "error" && /pair again/i.test(e.message ?? "")), 5000);
    await a.dispose();
  });
});

describe("dispatcher + state machine with the bridge adapter", () => {
  it("keeps requested and confirmed state separate through a full command cycle", async () => {
    const client = await paired();
    const res = await client.putLight("primary", { switchAddress: "0/0/1", statusAddress: "0/0/2", dpt: "1.001", onLevel: 100 });
    const adapter = new BridgeAdapter(client, res.light, await client.knxStatus());
    let state: LightState = [
      { type: "MODE_CHANGED", mode: "bridge", backendLabel: adapter.label, at: Date.now() } as LightEvent,
      {
        type: "TARGET_SET",
        target: { groupAddress: "0/0/1", displayAddress: "0/0/1", statusAddress: "0/0/2", displayStatusAddress: "0/0/2", dpt: "1.001", onLevel: 100 },
        feedbackAvailable: true,
        at: Date.now(),
      } as LightEvent,
    ].reduce(lightReducer, createInitialState(0));
    const dispatch = (e: LightEvent) => (state = lightReducer(state, e));
    adapter.subscribe((e) => {
      if (e.type === "link") dispatch({ type: "LINK_CHANGED", status: e.status, message: e.message, at: Date.now() });
      if (e.type === "state") dispatch({ type: "STATE_REPORTED", value: e.value, via: e.via, at: e.at });
    });
    adapter.start();
    await waitFor(() => state.link.status === "connected");

    const result = await dispatchCommand({ getState: () => state, dispatch, getAdapter: () => adapter }, { value: "on", source: "gesture" });
    expect(result).toMatchObject({ status: "done", phase: "bus_confirmed" });
    expect(state.lastCommand?.phase).toBe("bus_confirmed");
    await waitFor(() => state.reported.value === "on");
    const view = selectLampView(state, Date.now());
    expect(view).toMatchObject({ lit: true, certainty: "confirmed", label: "ON" });
    await adapter.dispose();
  });
});
