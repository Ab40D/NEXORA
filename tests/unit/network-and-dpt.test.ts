import { describe, expect, it } from "vitest";
import { byteToPercent, decodeOnOff, encodeOnOff, percentToByte } from "@/lib/knx/dpt";
import { SseParser } from "@/lib/bridge/sse";
import { checkEndpointUrl, classifyHost } from "@/lib/net/endpoint";

describe("classifyHost", () => {
  it.each([
    ["localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["[::1]", "loopback"],
    ["192.168.1.20", "local"],
    ["10.0.0.5", "local"],
    ["172.20.1.1", "local"],
    ["172.32.1.1", "public"],
    ["169.254.10.10", "local"],
    ["100.101.102.103", "local"],
    ["knx-bridge.local", "local"],
    ["[fd12:3456::1]", "local"],
    ["bridge.example.com", "public"],
    ["8.8.8.8", "public"],
  ])("%s → %s", (host, space) => {
    expect(classifyHost(host)).toBe(space);
  });
});

describe("checkEndpointUrl", () => {
  const https = { pageProtocol: "https:", kind: "bridge" as const };
  const http = { pageProtocol: "http:", kind: "bridge" as const };

  it("normalizes a valid https URL", () => {
    const r = checkEndpointUrl(" https://bridge.tailnet.ts.net/ ", https);
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://bridge.tailnet.ts.net");
    expect(r.targetAddressSpace).toBeUndefined();
  });

  it("allows http loopback from https with a Safari warning and the loopback LNA hint", () => {
    const r = checkEndpointUrl("http://127.0.0.1:8787", https);
    expect(r.ok).toBe(true);
    expect(r.targetAddressSpace).toBe("loopback");
    expect(r.warnings.join(" ")).toMatch(/Safari/);
  });

  it("allows http LAN IPs from https only with the local LNA hint and a warning", () => {
    const r = checkEndpointUrl("http://192.168.1.50:8787", https);
    expect(r.ok).toBe(true);
    expect(r.targetAddressSpace).toBe("local");
    expect(r.warnings.join(" ")).toMatch(/local network access/i);
  });

  it("warns when a bridge URL uses the KNX interface port 3671 (common mix-up)", () => {
    const r = checkEndpointUrl("http://192.168.1.20:3671", http);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/3671 is the KNXnet\/IP port/);
    expect(r.warnings.join(" ")).toMatch(/8787/);
    expect(checkEndpointUrl("http://127.0.0.1:8787", http).warnings).toEqual([]);
    expect(checkEndpointUrl("http://192.168.1.20:3671", { pageProtocol: "http:", kind: "homeassistant" }).warnings).toEqual([]);
  });

  it("rejects http public hosts from https (mixed content)", () => {
    expect(checkEndpointUrl("http://bridge.example.com", https).ok).toBe(false);
    expect(checkEndpointUrl("http://bridge.example.com", http).ok).toBe(true);
  });

  it.each([
    ["", /Enter/],
    ["bridge.local:8787", /scheme/],
    ["ftp://x", /scheme/],
    ["https://user:pw@bridge.local", /credentials/],
    ["https://bridge.local/?x=1", /query/],
    ["javascript:alert(1)", /scheme/],
  ])("rejects %j", (input, msg) => {
    const r = checkEndpointUrl(input, https);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(msg);
  });

  it("requires https for Home Assistant unless loopback, and no path", () => {
    expect(checkEndpointUrl("http://192.168.1.10:8123", { pageProtocol: "https:", kind: "homeassistant" }).ok).toBe(false);
    expect(checkEndpointUrl("https://ha.example.com/lovelace", { pageProtocol: "https:", kind: "homeassistant" }).ok).toBe(false);
    expect(checkEndpointUrl("https://ha.example.com", { pageProtocol: "https:", kind: "homeassistant" }).ok).toBe(true);
  });
});

describe("DPT encoding", () => {
  it("encodes DPT 1.001", () => {
    expect(encodeOnOff("1.001", "on")).toEqual({ kind: "binary", value: 1 });
    expect(encodeOnOff("1.001", "off")).toEqual({ kind: "binary", value: 0 });
  });

  it("encodes DPT 5.001 with the on level", () => {
    expect(encodeOnOff("5.001", "on", 100)).toEqual({ kind: "array", bytes: [255] });
    expect(encodeOnOff("5.001", "on", 50)).toEqual({ kind: "array", bytes: [128] });
    expect(encodeOnOff("5.001", "off", 50)).toEqual({ kind: "array", bytes: [0] });
    expect(percentToByte(0)).toBe(0);
    expect(byteToPercent(255)).toBe(100);
  });

  it("decodes payloads defensively", () => {
    expect(decodeOnOff("1.001", 1)).toBe("on");
    expect(decodeOnOff("1.001", [0])).toBe("off");
    expect(decodeOnOff("1.001", 7)).toBeNull();
    expect(decodeOnOff("5.001", [128])).toBe("on");
    expect(decodeOnOff("5.001", [0])).toBe("off");
    expect(decodeOnOff("5.001", [300])).toBeNull();
    expect(decodeOnOff("5.001", "x")).toBeNull();
  });
});

describe("SseParser", () => {
  it("parses events split across chunks, ignores comments", () => {
    const p = new SseParser();
    expect(p.push(": ping\n\nevent: light.state\ndata: {\"a\"")).toEqual([]);
    const out = p.push(":1}\n\nevent: ping\r\ndata: {}\r\n\r\n");
    expect(out).toEqual([
      { event: "light.state", data: '{"a":1}' },
      { event: "ping", data: "{}" },
    ]);
  });

  it("joins multi-line data", () => {
    const p = new SseParser();
    expect(p.push("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});
