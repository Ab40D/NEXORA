"use client";

/**
 * Client state for the SE7ENX hub device layer (Devices tab).
 *
 * The hub is the paired SE7ENX bridge (same session token as the Local KNX Bridge mode). In the
 * appliance build the UI is served by the hub itself, so the hub URL is this page's origin.
 * Live updates use the existing authenticated event stream; device state shown here is always the
 * hub's reported state. Requested state is displayed separately until the device confirms it.
 */
import { create } from "zustand";
import { AdapterError, describeError } from "@/lib/adapters/types";
import { BridgeClient, type EventStreamHandle } from "@/lib/bridge/client";
import { clearBridgeSession, peekBridgeSession, saveBridgeSession } from "@/lib/connection/session";
import { checkEndpointUrl } from "@/lib/net/endpoint";
import type { AddDeviceBody, DevicePatchBody, HubCommand, HubDevice, IntegrationStatus, Safety } from "./contract";

export const APPLIANCE = process.env.NEXT_PUBLIC_SE7ENX_APPLIANCE === "true";

export type HubStatus = "idle" | "connecting" | "needs_pairing" | "ready" | "unsupported" | "error";

export interface CommandResultView {
  ok: boolean;
  text: string;
  hint?: string;
  outcome?: "confirmed" | "accepted" | "simulated";
  at: number;
}

interface HubStore {
  status: HubStatus;
  baseUrl: string | null;
  error: { message: string; hint?: string } | null;
  devices: Record<string, HubDevice>;
  order: string[];
  integrations: IntegrationStatus[];
  persistent: boolean;
  safety: Safety;
  busy: Record<string, boolean>;
  results: Record<string, CommandResultView>;
  connect: () => Promise<void>;
  pair: (code: string, clientName: string) => Promise<void>;
  disconnect: () => void;
  command: (id: string, command: HubCommand, params?: Record<string, unknown>) => Promise<void>;
  patch: (id: string, patch: DevicePatchBody) => Promise<void>;
  remove: (id: string) => Promise<void>;
  add: (body: AddDeviceBody) => Promise<HubDevice>;
  setSafety: (active: boolean) => Promise<void>;
  refreshIntegrations: () => Promise<void>;
}

let client: BridgeClient | null = null;
let stream: EventStreamHandle | null = null;
let rid = 0;

export function hubClient(): BridgeClient {
  if (!client) throw new AdapterError("HUB_NOT_CONNECTED", "Not connected to a SE7ENX hub.");
  return client;
}

function makeClient(baseUrl: string, token: string | null): BridgeClient {
  const check = typeof window !== "undefined" ? checkEndpointUrl(baseUrl, { pageProtocol: window.location.protocol, kind: "bridge" }) : null;
  return new BridgeClient({
    baseUrl,
    token,
    targetAddressSpace: check && check.ok ? check.targetAddressSpace : undefined,
    appOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
  });
}

function upsert(state: Pick<HubStore, "devices" | "order">, d: HubDevice): Pick<HubStore, "devices" | "order"> {
  return { devices: { ...state.devices, [d.id]: d }, order: state.order.includes(d.id) ? state.order : [...state.order, d.id] };
}

export const useHub = create<HubStore>((set, get) => ({
  status: "idle",
  baseUrl: null,
  error: null,
  devices: {},
  order: [],
  integrations: [],
  persistent: false,
  safety: { active: false },
  busy: {},
  results: {},

  connect: async () => {
    if (get().status === "connecting") return;
    const session = peekBridgeSession();
    const baseUrl = APPLIANCE && typeof window !== "undefined" ? window.location.origin : (session?.baseUrl ?? null);
    if (!baseUrl || !session || session.baseUrl !== baseUrl) {
      set({ status: "needs_pairing", baseUrl, error: null });
      return;
    }
    set({ status: "connecting", baseUrl, error: null });
    stream?.close();
    client = makeClient(baseUrl, session.token);
    try {
      const [list, integ] = await Promise.all([client.devices(), client.integrations()]);
      set({
        status: "ready",
        devices: Object.fromEntries(list.devices.map((d) => [d.id, d])),
        order: list.devices.map((d) => d.id),
        safety: list.safety,
        integrations: integ.integrations,
        persistent: integ.persistent,
      });
    } catch (err) {
      if (err instanceof AdapterError && err.status === 401) {
        clearBridgeSession();
        set({ status: "needs_pairing", error: { message: "The hub session expired or was revoked. Pair again." } });
        return;
      }
      if (err instanceof AdapterError && err.status === 404) {
        set({ status: "unsupported", error: { message: "This SE7ENX bridge has no device API.", hint: "Update the bridge/hub to version 1.1 or later." } });
        return;
      }
      const e = describeError(err);
      set({ status: "error", error: { message: e.message, hint: e.hint } });
      return;
    }
    stream = client.openEvents({
      onEvent: (ev) => {
        if (ev.type === "device.state") set((s) => upsert(s, ev.data));
        else if (ev.type === "device.removed")
          set((s) => {
            const devices = { ...s.devices };
            delete devices[ev.data.id];
            return { devices, order: s.order.filter((x) => x !== ev.data.id) };
          });
        else if (ev.type === "integration.status")
          set((s) => ({ integrations: [...s.integrations.filter((i) => i.name !== ev.data.name), ev.data].sort((a, b) => a.name.localeCompare(b.name)) }));
        else if (ev.type === "safety") set({ safety: ev.data });
      },
      onAuthError: () => {
        clearBridgeSession();
        set({ status: "needs_pairing", error: { message: "The hub session expired or was revoked. Pair again." } });
      },
    });
  },

  pair: async (code, clientName) => {
    const baseUrl = get().baseUrl ?? (typeof window !== "undefined" ? window.location.origin : null);
    if (!baseUrl) throw new AdapterError("HUB_URL_UNKNOWN", "Hub address unknown.");
    const c = makeClient(baseUrl, null);
    const res = await c.pair(code, clientName);
    saveBridgeSession({ baseUrl, token: res.token, expiresAt: res.expiresAt });
    set({ status: "idle" });
    await get().connect();
  },

  disconnect: () => {
    stream?.close();
    stream = null;
    client = null;
    set({ status: "idle", devices: {}, order: [], integrations: [] });
  },

  command: async (id, command, params = {}) => {
    if (get().busy[id]) return;
    set((s) => ({ busy: { ...s.busy, [id]: true } }));
    try {
      const res = await hubClient().deviceCommand(id, command, params, `ui-${Date.now().toString(36)}-${++rid}`);
      set((s) => ({
        ...upsert(s, res.device),
        results: { ...s.results, [id]: { ok: true, outcome: res.outcome, text: res.detail, at: Date.now() } },
      }));
    } catch (err) {
      const e = describeError(err);
      set((s) => ({ results: { ...s.results, [id]: { ok: false, text: e.message, hint: e.hint, at: Date.now() } } }));
    } finally {
      set((s) => ({ busy: { ...s.busy, [id]: false } }));
    }
  },

  patch: async (id, patch) => {
    const d = await hubClient().patchDevice(id, patch);
    set((s) => upsert(s, d));
  },

  remove: async (id) => {
    await hubClient().removeDevice(id);
    set((s) => {
      const devices = { ...s.devices };
      delete devices[id];
      return { devices, order: s.order.filter((x) => x !== id) };
    });
  },

  add: async (body) => {
    const d = await hubClient().addDevice(body);
    set((s) => upsert(s, d));
    return d;
  },

  setSafety: async (active) => {
    const safety = await hubClient().setSafety(active);
    set({ safety });
  },

  refreshIntegrations: async () => {
    const r = await hubClient().integrations();
    set({ integrations: r.integrations, persistent: r.persistent });
  },
}));
