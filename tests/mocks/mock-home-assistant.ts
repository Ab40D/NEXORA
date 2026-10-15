/**
 * Minimal Home Assistant WebSocket API mock (auth phase, get_config,
 * get_services, auth/current_user, subscribe_events, call_service incl.
 * return_response, knx/get_base_data) for testing the HA adapter.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface MockHaOptions {
  token?: string;
  isAdmin?: boolean;
  knx?: boolean;
  readWithResponse?: boolean;
  knxConnected?: boolean;
  /** respond to knx.read with this payload (null = no device answers) */
  readPayload?: number | number[] | null;
  /** emit an outgoing knx_event after knx.send (HA does this after L_Data.con) */
  echoOutgoing?: boolean;
  failSend?: boolean;
}

export interface ServiceCall {
  domain: string;
  service: string;
  service_data?: Record<string, unknown>;
  return_response?: boolean;
}

export interface MockHa {
  url: string;
  calls: ServiceCall[];
  subscriptions: () => number;
  emitKnxEvent: (data: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export async function startMockHomeAssistant(opts: MockHaOptions = {}): Promise<MockHa> {
  const o = { token: "valid-token", isAdmin: true, knx: true, readWithResponse: true, knxConnected: true, readPayload: 1, echoOutgoing: true, failSend: false, ...opts };
  const http: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http, path: "/api/websocket" });
  const calls: ServiceCall[] = [];
  const subs = new Map<WebSocket, number[]>();

  const emit = (ws: WebSocket, data: Record<string, unknown>) => {
    for (const id of subs.get(ws) ?? []) {
      ws.send(JSON.stringify({ id, type: "event", event: { event_type: "knx_event", data, origin: "LOCAL", time_fired: new Date().toISOString() } }));
    }
  };

  wss.on("connection", (ws) => {
    let authed = false;
    ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.1" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown> & { id?: number; type: string };
      if (!authed) {
        if (msg.type === "auth" && msg.access_token === o.token) {
          authed = true;
          ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.10.1" }));
        } else {
          ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
          ws.close();
        }
        return;
      }
      const ok = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result }));
      const fail = (code: string, message: string) => ws.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { code, message } }));
      switch (msg.type) {
        case "supported_features":
          return ok(null);
        case "get_config":
          return ok({ version: "2026.10.1", components: o.knx ? ["http", "knx", "light"] : ["http", "light"], location_name: "Home" });
        case "get_services":
          return ok(
            o.knx
              ? {
                  knx: {
                    send: { name: "Send", fields: {} },
                    read: { name: "Read", fields: {}, ...(o.readWithResponse ? { response: { optional: true } } : {}) },
                    ...(o.isAdmin ? { event_register: { name: "Register event", fields: {} } } : {}),
                  },
                }
              : { light: { turn_on: {} } },
          );
        case "auth/current_user":
          return ok({ id: "u1", name: o.isAdmin ? "Admin" : "Guest", is_owner: o.isAdmin, is_admin: o.isAdmin, credentials: [], mfa_modules: [] });
        case "knx/get_base_data":
          if (!o.isAdmin) return fail("unauthorized", "Unauthorized");
          return ok({ connection_info: { version: "4.0.0", connected: o.knxConnected, current_address: "1.1.250" } });
        case "subscribe_events": {
          if (!o.isAdmin && msg.event_type === "knx_event") return fail("unauthorized", "Unauthorized");
          subs.set(ws, [...(subs.get(ws) ?? []), msg.id as number]);
          return ok(null);
        }
        case "unsubscribe_events":
          return ok(null);
        case "call_service": {
          const call = msg as unknown as ServiceCall;
          calls.push({ domain: call.domain, service: call.service, service_data: call.service_data, return_response: call.return_response });
          if (call.domain !== "knx") return fail("not_found", "Service not found");
          if (call.service === "event_register" && !o.isAdmin) return fail("unauthorized", "Unauthorized");
          if (call.service === "send") {
            if (o.failSend) return fail("home_assistant_error", "KNX connection not established");
            ok({ context: { id: "c1" } });
            if (o.echoOutgoing) {
              const d = call.service_data ?? {};
              setTimeout(() => emit(ws, { destination: d.address, direction: "Outgoing", telegramtype: "GroupValueWrite", data: d.payload, source: "1.1.250", value: null }), 15);
            }
            return;
          }
          if (call.service === "read") {
            if (call.return_response) {
              if (!o.readWithResponse) return fail("service_validation_error", "Service does not support responses");
              if (o.readPayload === null) return fail("home_assistant_error", "No response received");
              return ok({ context: { id: "c2" }, response: { value: null, payload: o.readPayload, source: "1.1.10" } });
            }
            return ok({ context: { id: "c3" } });
          }
          return ok({ context: { id: "c4" } });
        }
        default:
          return fail("unknown_command", `Unknown command ${msg.type}`);
      }
    });
    ws.on("close", () => subs.delete(ws));
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    subscriptions: () => [...subs.values()].reduce((n, l) => n + l.length, 0),
    emitKnxEvent: (data) => {
      for (const ws of wss.clients) emit(ws, data);
    },
    close: () =>
      new Promise<void>((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.close(() => r());
      }),
  };
}
