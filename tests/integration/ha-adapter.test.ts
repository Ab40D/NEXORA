import { Auth } from "home-assistant-js-websocket";
import { WebSocket as NodeWebSocket } from "ws";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectHomeAssistant, HomeAssistantAdapter } from "@/lib/adapters/ha-adapter";
import type { AdapterEvent } from "@/lib/adapters/types";
import { buildAuthorizeUrl } from "@/lib/ha/oauth";
import type { LightTarget } from "@/lib/state/types";
import { startMockHomeAssistant, type MockHa, type MockHaOptions } from "../mocks/mock-home-assistant";

beforeAll(() => {
  // Node 20 has no global WebSocket; home-assistant-js-websocket expects one.
  if (!(globalThis as { WebSocket?: unknown }).WebSocket) (globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket;
});

const target: LightTarget = {
  groupAddress: "0/0/1",
  displayAddress: "0/0/1",
  statusAddress: "0/0/2",
  displayStatusAddress: "0/0/2",
  dpt: "1.001",
  onLevel: 100,
};

let ha: MockHa | null = null;
afterEach(async () => {
  await ha?.close();
  ha = null;
});

function auth(url: string, token = "valid-token"): Auth {
  return new Auth({ hassUrl: url, clientId: "https://se7enx.example/", expires: Date.now() + 3600_000, refresh_token: "r", access_token: token, expires_in: 1800 });
}

async function setup(opts: MockHaOptions = {}, t: LightTarget = target) {
  ha = await startMockHomeAssistant(opts);
  const { conn, caps } = await connectHomeAssistant(auth(ha.url));
  const adapter = new HomeAssistantAdapter(conn, caps, t, ha.url);
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  return { adapter, caps, events, ha };
}

const until = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error("timeout")) : setTimeout(tick, 10));
    tick();
  });

describe("Home Assistant OAuth", () => {
  it("builds an authorize URL with client_id, redirect_uri and a state nonce", () => {
    const u = new URL(buildAuthorizeUrl("https://ha.example.com/", "nonce123", "https://app.example/", "https://app.example/?se7enx_ha_callback=1"));
    expect(u.origin + u.pathname).toBe("https://ha.example.com/auth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("https://app.example/");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/?se7enx_ha_callback=1");
    expect(u.searchParams.get("state")).toBe("nonce123");
  });
});

describe("Home Assistant capability detection", () => {
  it("detects KNX, read-with-response, admin rights and interface link state", async () => {
    const { caps, adapter } = await setup();
    expect(caps).toMatchObject({ knxLoaded: true, canSend: true, canRead: true, readWithResponse: true, isAdmin: true, knxConnected: true, version: "2026.10.1" });
    await adapter.dispose();
  });

  it("reports a missing KNX integration and non-admin users", async () => {
    const { caps, adapter } = await setup({ knx: false, isAdmin: false });
    expect(caps.knxLoaded).toBe(false);
    expect(caps.canSend).toBe(false);
    expect(caps.isAdmin).toBe(false);
    expect(caps.knxConnected).toBeNull();
    await adapter.dispose();
  });

  it("rejects invalid tokens with an actionable error", async () => {
    ha = await startMockHomeAssistant();
    await expect(connectHomeAssistant(auth(ha.url, "wrong"))).rejects.toMatchObject({ code: "HA_AUTH_INVALID" });
  });
});

describe("HomeAssistantAdapter (admin)", () => {
  it("registers events, sends knx.send and confirms via the outgoing knx_event", async () => {
    const { adapter, events, ha } = await setup();
    await adapter.start();
    expect(ha.calls.find((c) => c.service === "event_register")?.service_data).toEqual({ address: ["0/0/1", "0/0/2"] });
    expect(ha.subscriptions()).toBe(1);
    const out = await adapter.send("on", { requestId: "r", source: "manual" });
    expect(out.phase).toBe("bus_confirmed");
    expect(ha.calls.find((c) => c.service === "send")?.service_data).toEqual({ address: "0/0/1", payload: 1 });
    // initial read on start produced a read_response state
    expect(events.some((e) => e.type === "state" && e.via === "read_response")).toBe(true);
    await adapter.dispose();
  });

  it("does not claim bus confirmation when no outgoing event is observed", async () => {
    const { adapter } = await setup({ echoOutgoing: false });
    await adapter.start();
    const out = await adapter.send("off", { requestId: "r", source: "voice" });
    expect(out.phase).toBe("accepted");
    await adapter.dispose();
  });

  it("turns status telegrams into confirmed device state and ignores unrelated addresses", async () => {
    const { adapter, events, ha } = await setup({ readPayload: null });
    await adapter.start();
    ha.emitKnxEvent({ destination: "5/5/5", direction: "Incoming", telegramtype: "GroupValueWrite", data: 1 });
    ha.emitKnxEvent({ destination: "0/0/2", direction: "Incoming", telegramtype: "GroupValueWrite", data: 1 });
    await until(() => events.some((e) => e.type === "state"));
    const states = events.filter((e) => e.type === "state");
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ value: "on", via: "status_address" });
    await adapter.dispose();
  });

  it("encodes DPT 5.001 as a raw byte", async () => {
    const { adapter, ha } = await setup({}, { ...target, dpt: "5.001", onLevel: 50 });
    await adapter.start();
    await adapter.send("on", { requestId: "r", source: "manual" });
    expect(ha.calls.find((c) => c.service === "send")?.service_data).toEqual({ address: "0/0/1", payload: [128] });
    await adapter.dispose();
  });

  it("maps knx.send failures to HA_SEND_FAILED", async () => {
    const { adapter } = await setup({ failSend: true });
    await adapter.start();
    await expect(adapter.send("on", { requestId: "r", source: "manual" })).rejects.toMatchObject({ code: "HA_SEND_FAILED" });
    await adapter.dispose();
  });
});

describe("HomeAssistantAdapter (non-admin)", () => {
  it("sends without claiming bus confirmation and reads state via knx.read responses", async () => {
    const { adapter, events, ha } = await setup({ isAdmin: false, readPayload: 0 });
    await adapter.start();
    expect(ha.subscriptions()).toBe(0);
    expect(ha.calls.some((c) => c.service === "event_register")).toBe(false);
    expect(events.some((e) => e.type === "state" && e.value === "off" && e.via === "read_response")).toBe(true);
    const out = await adapter.send("on", { requestId: "r", source: "manual" });
    expect(out.phase).toBe("accepted");
    expect(out.detail).toMatch(/administrator/);
    expect(adapter.feedbackAvailable).toBe(true);
    await adapter.dispose();
  });

  it("has no feedback without a status address when not admin and reads are unsupported", async () => {
    const { adapter } = await setup({ isAdmin: false, readWithResponse: false }, { ...target, statusAddress: null, displayStatusAddress: null });
    expect(adapter.feedbackAvailable).toBe(false);
    await adapter.dispose();
  });
});
