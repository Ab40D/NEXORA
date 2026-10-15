/**
 * In-process mock of the SE7ENX Bridge HTTP API (contract v1) for integration
 * tests of the web client. Behaviour is controllable from the test.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockBridgeState {
  pairingCode: string;
  tokens: Set<string>;
  knxState: "connected" | "connecting" | "disconnected" | "error";
  routing: boolean;
  confirm: "positive" | "negative" | "none";
  feedback: boolean;
  lightValue: "on" | "off" | "unknown";
  writes: Array<{ ga: string; payload: number | number[] }>;
  malformedSession: boolean;
}

export interface MockBridge {
  url: string;
  state: MockBridgeState;
  emitStatus: (value: "on" | "off") => void;
  emitKnx: (state: MockBridgeState["knxState"]) => void;
  dropStreams: () => void;
  revokeAll: () => void;
  streamCount: () => number;
  close: () => Promise<void>;
}

const KNX = (s: MockBridgeState) => ({
  state: s.knxState,
  connectionType: s.routing ? "routing" : "tunneling",
  gateway: s.routing ? null : { host: "192.168.1.20", port: 3671, name: "Mock IP Interface", individualAddress: "1.1.0" },
  localAddress: "1.1.241",
  since: "2026-10-15T00:00:00Z",
  lastError: s.knxState === "error" ? { code: "KNX_CONNECT_FAILED", message: "mock failure" } : null,
  confirmation: s.routing ? "local" : "interface",
  secure: false,
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function err(res: ServerResponse, status: number, code: string, message: string, hint?: string) {
  json(res, status, { error: { code, message, hint: hint ?? null } });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function startMockBridge(init: Partial<MockBridgeState> = {}): Promise<MockBridge> {
  const state: MockBridgeState = {
    pairingCode: "ABCD2345",
    tokens: new Set(),
    knxState: "connected",
    routing: false,
    confirm: "positive",
    feedback: true,
    lightValue: "unknown",
    writes: [],
    malformedSession: false,
    ...init,
  };
  const light = { id: "primary", switchAddress: "0/0/1", statusAddress: "0/0/2" as string | null, dpt: "1.001", onLevel: 100 };
  const streams = new Set<ServerResponse>();

  const lightState = () => ({
    lightId: light.id,
    value: state.lightValue,
    via: state.lightValue === "unknown" ? "none" : "status_address",
    at: state.lightValue === "unknown" ? null : new Date().toISOString(),
    payload: state.lightValue === "unknown" ? null : state.lightValue === "on" ? 1 : 0,
  });

  const send = (event: string, data: unknown) => {
    for (const s of streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
      res.end();
      return;
    }
    if (path === "/health") return json(res, 200, { ok: true, service: "se7enx-bridge", version: "1.0.0-mock", apiVersion: 1, pairingRequired: true });
    if (path === "/pair" && req.method === "POST") {
      const b = await body(req);
      if (String(b.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") !== state.pairingCode) {
        return err(res, 401, "PAIRING_FAILED", "The pairing code is wrong or has expired.", "Use the code from the bridge console.");
      }
      const token = `tok_${Math.random().toString(36).slice(2)}_${"x".repeat(24)}`;
      state.tokens.add(token);
      return json(res, 200, { token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), bridgeId: "mock" });
    }

    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!state.tokens.has(token)) return err(res, 401, "SESSION_INVALID", "The session token is invalid, expired or revoked.", "Pair again.");

    if (path === "/session") {
      if (state.malformedSession) return json(res, 200, { session: "nope" });
      return json(res, 200, {
        session: { clientName: "vitest", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
        bridge: { id: "mock", name: "Mock Bridge", version: "1.0.0-mock" },
        knx: KNX(state),
        policy: { allowedGroupAddresses: ["0/0/*"], supportedDpts: ["1.001", "5.001"], clientGatewayOverride: false, discovery: true },
      });
    }
    if (path === "/knx/status") return json(res, 200, KNX(state));
    if (path === "/knx/connect") {
      state.knxState = "connected";
      return json(res, 200, KNX(state));
    }
    if (path === "/knx/test") return json(res, 200, { ok: true, checks: [{ id: "link", label: "KNX link", ok: true, detail: "mock" }] });
    if (path === "/lights/primary" && req.method === "PUT") {
      const b = await body(req);
      if (typeof b.switchAddress === "string" && !b.switchAddress.startsWith("0/0/")) {
        return err(res, 403, "GA_NOT_ALLOWED", `Group address ${b.switchAddress} is not permitted by this bridge.`, "Allowed: 0/0/*");
      }
      light.switchAddress = String(b.switchAddress);
      light.statusAddress = (b.statusAddress as string | null) ?? null;
      light.dpt = String(b.dpt ?? "1.001");
      light.onLevel = Number(b.onLevel ?? 100);
      return json(res, 200, { light, state: lightState() });
    }
    if (path === "/lights/primary/state") return json(res, 200, lightState());
    const m = /^\/lights\/primary\/(on|off)$/.exec(path);
    if (m && req.method === "POST") {
      const b = await body(req);
      if (state.knxState !== "connected") return err(res, 409, "KNX_NOT_CONNECTED", "The bridge is not connected to the KNX interface.");
      if (state.confirm === "negative") return err(res, 502, "KNX_NEGATIVE_CONFIRMATION", "negative L_Data.con", "Check the bus.");
      if (state.confirm === "none") return err(res, 504, "KNX_CONFIRMATION_TIMEOUT", "no L_Data.con", "Check the interface.");
      const value = m[1] as "on" | "off";
      state.writes.push({ ga: light.switchAddress, payload: value === "on" ? 1 : 0 });
      if (state.feedback && light.statusAddress) {
        setTimeout(() => {
          state.lightValue = value;
          send("light.state", lightState());
        }, 20);
      }
      return json(res, 200, {
        requestId: String(b.requestId),
        lightId: "primary",
        value,
        outcome: state.routing ? "sent_unconfirmed" : "bus_confirmed",
        confirmation: state.routing ? "local" : "interface_positive",
        detail: state.routing ? "Sent via routing (no bus confirmation)." : "The KNX interface confirmed transmission on the bus.",
        telegram: { destination: light.switchAddress, payload: value === "on" ? 1 : 0 },
        at: new Date().toISOString(),
      });
    }
    if (path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      streams.add(res);
      res.write(`: connected\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ bridgeId: "mock", knx: KNX(state) })}\n\n`);
      req.on("close", () => streams.delete(res));
      return;
    }
    return err(res, 404, "NOT_FOUND", "Not found");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    emitStatus: (value) => {
      state.lightValue = value;
      send("light.state", lightState());
    },
    emitKnx: (s) => {
      state.knxState = s;
      send("knx.status", KNX(state));
    },
    dropStreams: () => {
      for (const s of streams) s.destroy();
      streams.clear();
    },
    revokeAll: () => {
      state.tokens.clear();
      for (const s of streams) s.destroy();
      streams.clear();
    },
    streamCount: () => streams.size,
    close: () =>
      new Promise<void>((r) => {
        for (const s of streams) s.destroy();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
