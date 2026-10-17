import { describe, expect, it } from "vitest";
import { BridgeEventSchema } from "@/lib/bridge/contract";
import { HubCommandResponseSchema, HubDeviceSchema, ShellyIdentitySchema } from "@/lib/hub/contract";
import { describeReported, describeRequested, relativeTime, slugifyId } from "@/lib/hub/format";

// Shape produced by bridge/se7enx_bridge/devices/registry.py#device_json
const device = {
  id: "kitchen",
  name: "Kitchen",
  type: "light",
  integration: "homeassistant",
  simulated: false,
  model: "Home Assistant light",
  capabilities: ["brightness", "on_off"],
  commands: ["turn_on", "turn_off", "toggle", "set_brightness"],
  controlEnabled: false,
  controlAllowed: false,
  hidden: false,
  metadata: { tags: [] },
  connection: { status: "online", lastSeen: "2026-10-17T10:00:00Z", lastError: null },
  state: { reported: { on: true, brightness: 40 }, reportedAt: "2026-10-17T10:00:00Z", source: "event", requested: null, requestedAt: null, pending: false },
  config: { entityId: "light.kitchen" },
  credentialsStored: false,
  diagnostics: { entityId: "light.kitchen" },
  someFutureField: 1,
};

describe("hub contract", () => {
  it("parses devices and ignores unknown fields", () => {
    const d = HubDeviceSchema.parse(device);
    expect(d.integration).toBe("homeassistant");
    expect("someFutureField" in d).toBe(false);
  });

  it("rejects invalid connection states and integrations", () => {
    expect(HubDeviceSchema.safeParse({ ...device, integration: "zigbee" }).success).toBe(false);
    expect(HubDeviceSchema.safeParse({ ...device, connection: { ...device.connection, status: "maybe" } }).success).toBe(false);
  });

  it("accepts hub events on the existing event stream and still accepts legacy events", () => {
    expect(BridgeEventSchema.safeParse({ type: "device.state", data: device }).success).toBe(true);
    expect(BridgeEventSchema.safeParse({ type: "device.removed", data: { id: "kitchen" } }).success).toBe(true);
    expect(BridgeEventSchema.safeParse({ type: "safety", data: { active: true, since: "x", by: "y" } }).success).toBe(true);
    expect(BridgeEventSchema.safeParse({ type: "integration.status", data: { name: "shelly", state: "connected", detail: "", lastSuccessAt: null, lastError: null, devices: 1 } }).success).toBe(true);
    expect(BridgeEventSchema.safeParse({ type: "ping", data: { t: "now" } }).success).toBe(true);
  });

  it("parses command responses and Shelly identities", () => {
    expect(HubCommandResponseSchema.parse({ outcome: "accepted", delivery: "http_ok", detail: "x", device }).outcome).toBe("accepted");
    expect(HubCommandResponseSchema.safeParse({ outcome: "done", delivery: "x", detail: "x", device }).success).toBe(false);
    const ident = ShellyIdentitySchema.parse({
      host: "192.168.1.40",
      gen: 2,
      model: "SNSW-102P16EU",
      shellyId: "shellyplus2pm-x",
      authRequired: true,
      channels: [{ component: "switch", channel: 0, capabilities: ["on_off", "power"], suggestedType: "outlet", state: { on: false } }],
      unsupportedComponents: ["rgb:0"],
    });
    expect(ident.channels[0]?.suggestedType).toBe("outlet");
  });
});

describe("hub formatting", () => {
  it("creates unique, safe device ids", () => {
    expect(slugifyId("Salle de bain — Plafonnier")).toBe("salle-de-bain-plafonnier");
    expect(slugifyId("Kitchen", ["kitchen", "kitchen-2"])).toBe("kitchen-3");
    expect(slugifyId("!!!")).toBe("device");
    expect(slugifyId("x".repeat(80)).length).toBeLessThanOrEqual(48);
  });

  it("describes reported state per type without inventing values", () => {
    expect(describeReported("light", { on: true, brightness: 40 })).toEqual(["On", "40 %"]);
    expect(describeReported("outlet", { on: true, power: 61.5, energy: 1234.5 })).toEqual(["On", "62 W", "1.23 kWh"]);
    expect(describeReported("cover", { position: 80, moving: "opening" })).toEqual(["80 % open", "Opening…"]);
    expect(describeReported("sensor", { value: 21.5, unit: "°C" })).toEqual(["21.5 °C"]);
    expect(describeReported("light", {})).toEqual([]);
  });

  it("describes requested state separately", () => {
    expect(describeRequested({ brightness: 30 })).toBe("30 %");
    expect(describeRequested({ on: false })).toBe("Off");
    expect(describeRequested(null)).toBeNull();
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-17T10:01:00Z");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-10-17T10:00:58Z", now)).toBe("just now");
    expect(relativeTime("2026-10-17T10:00:30Z", now)).toBe("30 s ago");
    expect(relativeTime("2026-10-17T09:51:00Z", now)).toBe("10 min ago");
  });
});
