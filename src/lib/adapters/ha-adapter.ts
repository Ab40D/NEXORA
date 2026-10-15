/**
 * LightAdapter backed by an existing Home Assistant KNX integration.
 *
 * Uses only HA's authenticated WebSocket API:
 *   knx.send   → GroupValueWrite (any authenticated user)
 *   knx.read   → GroupValueRead; recent HA versions return the response payload
 *   knx_event  → push updates; requires knx.event_register (admin-only service)
 *
 * Confirmation semantics (never overstated):
 *   - HA accepted knx.send                                  → "accepted"
 *   - outgoing knx_event observed for the telegram (admin)  → "bus_confirmed"
 *     (HA fires outgoing events only after its KNX interface confirmed sending)
 *   - status address telegram / read response               → reported device state
 */
import {
  callService,
  createConnection,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  ERR_INVALID_HTTPS_TO_HTTP,
  getConfig,
  getServices,
  getUser,
  type Auth,
  type Connection,
} from "home-assistant-js-websocket";
import { decodeOnOff, encodeOnOff } from "@/lib/knx/dpt";
import type { LightTarget, OnOff, ReportVia } from "@/lib/state/types";
import { AdapterEmitter, AdapterError, type AdapterListener, type CommandContext, type CommandOutcome, type LightAdapter } from "./types";

export interface HaCapabilities {
  version: string;
  userName: string;
  isAdmin: boolean;
  knxLoaded: boolean;
  canSend: boolean;
  canRead: boolean;
  readWithResponse: boolean;
  /** from the admin-only KNX panel API; null when unavailable */
  knxConnected: boolean | null;
  knxAddress: string | null;
}

export interface KnxEventData {
  destination?: string;
  direction?: string;
  telegramtype?: string;
  data?: unknown;
  payload?: unknown;
  source?: string;
}

function mapConnectError(err: unknown, hassUrl: string): AdapterError {
  if (err === ERR_INVALID_AUTH) {
    return new AdapterError("HA_AUTH_INVALID", "Home Assistant rejected the sign-in (token invalid or revoked).", {
      hint: "Sign in with Home Assistant again.",
    });
  }
  if (err === ERR_INVALID_HTTPS_TO_HTTP) {
    return new AdapterError("HA_MIXED_CONTENT", "Cannot connect to an http:// Home Assistant from this HTTPS page.", {
      hint: "Use your Home Assistant HTTPS URL.",
    });
  }
  if (err === ERR_CANNOT_CONNECT) {
    return new AdapterError("HA_UNREACHABLE", `Cannot reach Home Assistant at ${hassUrl}.`, {
      hint: "Check the URL, that Home Assistant is online, and that this device can reach it over HTTPS.",
    });
  }
  return new AdapterError("HA_CONNECT_FAILED", "Connecting to Home Assistant failed.", { cause: err });
}

export async function connectHomeAssistant(auth: Auth): Promise<{ conn: Connection; caps: HaCapabilities }> {
  let conn: Connection;
  try {
    conn = await createConnection({ auth });
  } catch (err) {
    throw mapConnectError(err, auth.data.hassUrl);
  }
  try {
    const [config, services, user] = await Promise.all([getConfig(conn), getServices(conn), getUser(conn)]);
    const knx = (services as Record<string, Record<string, { response?: { optional?: boolean } }>>).knx ?? {};
    const caps: HaCapabilities = {
      version: config.version,
      userName: user.name,
      isAdmin: !!user.is_admin,
      knxLoaded: config.components.includes("knx"),
      canSend: "send" in knx,
      canRead: "read" in knx,
      readWithResponse: !!knx.read?.response,
      knxConnected: null,
      knxAddress: null,
    };
    if (caps.isAdmin && caps.knxLoaded) {
      try {
        const base = await conn.sendMessagePromise<{ connection_info?: { connected?: boolean; current_address?: string } }>({
          type: "knx/get_base_data",
        });
        if (typeof base?.connection_info?.connected === "boolean") {
          caps.knxConnected = base.connection_info.connected;
          caps.knxAddress = base.connection_info.current_address ?? null;
        }
      } catch {
        /* panel API not available in this HA version — leave unknown */
      }
    }
    return { conn, caps };
  } catch (err) {
    conn.close();
    throw new AdapterError("HA_QUERY_FAILED", "Connected to Home Assistant but could not read its configuration.", { cause: err });
  }
}

function payloadForHa(target: LightTarget, value: OnOff): number | number[] {
  const p = encodeOnOff(target.dpt, value, target.onLevel);
  return p.kind === "binary" ? p.value : p.bytes;
}

interface OutgoingWaiter {
  resolve: (ok: boolean) => void;
  expected: OnOff;
  timer: ReturnType<typeof setTimeout>;
}

export class HomeAssistantAdapter implements LightAdapter {
  readonly mode = "homeassistant" as const;
  readonly label: string;
  readonly feedbackAvailable: boolean;
  private emitter = new AdapterEmitter();
  private unsubscribe: (() => Promise<void>) | null = null;
  private push = false;
  private waiter: OutgoingWaiter | null = null;
  private disposed = false;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onReady = () => {
    this.emitter.emit({ type: "link", status: "connected", message: this.linkMessage() });
    void this.refreshState().catch(() => undefined);
  };
  private readonly onDisconnected = () => {
    this.emitter.emit({ type: "link", status: "reconnecting", message: "Connection to Home Assistant lost — reconnecting…" });
  };
  private readonly onReconnectError = () => {
    this.emitter.emit({ type: "link", status: "error", message: "Home Assistant session expired. Sign in again." });
  };

  constructor(
    private readonly conn: Connection,
    private readonly caps: HaCapabilities,
    private readonly target: LightTarget,
    private readonly hassUrl: string,
  ) {
    this.label = `Home Assistant ${hassUrl} (KNX)`;
    this.feedbackAvailable = !!target.statusAddress && (caps.isAdmin || caps.readWithResponse);
  }

  private linkMessage(): string {
    const parts = [`Home Assistant ${this.caps.version}`, this.caps.isAdmin ? "admin" : "user"];
    if (this.caps.knxConnected === true) parts.push("KNX interface connected");
    if (this.caps.knxConnected === false) parts.push("KNX interface DISCONNECTED in HA");
    return parts.join(" · ");
  }

  async start(): Promise<void> {
    this.conn.addEventListener("ready", this.onReady);
    this.conn.addEventListener("disconnected", this.onDisconnected);
    this.conn.addEventListener("reconnect-error", this.onReconnectError);

    if (this.caps.isAdmin) {
      try {
        this.unsubscribe = await this.conn.subscribeEvents<{ data: KnxEventData }>((ev) => this.handleKnxEvent(ev.data), "knx_event");
        const addresses = [this.target.groupAddress, ...(this.target.statusAddress ? [this.target.statusAddress] : [])];
        await callService(this.conn, "knx", "event_register", { address: addresses });
        this.push = true;
      } catch (err) {
        this.push = false;
        this.emitter.emit({
          type: "note",
          tone: "warning",
          title: "Live KNX events unavailable",
          detail: `Could not subscribe to knx_event (${err instanceof Error ? err.message : "error"}). Falling back to reads.`,
        });
      }
    }
    this.emitter.emit({ type: "link", status: "connected", message: this.linkMessage() });
    await this.refreshState().catch(() => undefined);
  }

  /** exposed for tests */
  handleKnxEvent(d: KnxEventData): void {
    if (!d || typeof d.destination !== "string") return;
    const raw = d.data !== undefined ? d.data : d.payload;
    const incoming = d.direction === "Incoming";
    const type = d.telegramtype;

    if (d.destination === this.target.groupAddress && d.direction === "Outgoing" && type === "GroupValueWrite") {
      const value = decodeOnOff(this.target.dpt, raw);
      if (this.waiter && value === this.waiter.expected) {
        clearTimeout(this.waiter.timer);
        this.waiter.resolve(true);
        this.waiter = null;
      }
      return;
    }
    if (!incoming || (type !== "GroupValueWrite" && type !== "GroupValueResponse")) return;

    let via: ReportVia | null = null;
    if (this.target.statusAddress && d.destination === this.target.statusAddress) {
      via = type === "GroupValueResponse" ? "read_response" : "status_address";
    } else if (!this.target.statusAddress && d.destination === this.target.groupAddress) {
      via = type === "GroupValueResponse" ? "read_response" : "switch_address";
    } else if (this.target.statusAddress && d.destination === this.target.groupAddress && type === "GroupValueWrite") {
      // another device switched the light; actuator feedback should follow on the status address
      return;
    }
    if (!via) return;
    const value = decodeOnOff(this.target.dpt, raw);
    if (value) this.emitter.emit({ type: "state", value, via, at: Date.now() });
  }

  async send(value: OnOff, _ctx: CommandContext): Promise<CommandOutcome> {
    if (!this.caps.canSend) throw new AdapterError("HA_NO_KNX_SEND", "The knx.send action is not available in Home Assistant.");
    let waitPromise: Promise<boolean> | null = null;
    if (this.push) {
      if (this.waiter) {
        clearTimeout(this.waiter.timer);
        this.waiter.resolve(false);
      }
      waitPromise = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve(false);
        }, 3500);
        this.waiter = { resolve, expected: value, timer };
      });
    }
    try {
      await callService(this.conn, "knx", "send", {
        address: this.target.groupAddress,
        payload: payloadForHa(this.target, value),
      });
    } catch (err) {
      if (this.waiter) {
        clearTimeout(this.waiter.timer);
        this.waiter = null;
      }
      const msg = (err as { message?: string })?.message ?? "Home Assistant rejected knx.send";
      throw new AdapterError("HA_SEND_FAILED", msg, { hint: "Check the group address and the KNX integration state in Home Assistant." });
    }

    if (!this.push && this.target.statusAddress && this.caps.readWithResponse) {
      if (this.readTimer) clearTimeout(this.readTimer);
      this.readTimer = setTimeout(() => void this.refreshState().catch(() => undefined), 900);
    }

    if (waitPromise) {
      const confirmed = await waitPromise;
      if (confirmed) {
        return { phase: "bus_confirmed", detail: "Home Assistant's KNX interface transmitted the telegram (outgoing knx_event observed)." };
      }
      return { phase: "accepted", detail: "Accepted by Home Assistant, but the outgoing telegram was not observed within 3.5 s." };
    }
    return {
      phase: "accepted",
      detail: "Accepted by Home Assistant and queued for the KNX bus. Sign in as an HA administrator to observe bus transmission.",
    };
  }

  async refreshState(): Promise<void> {
    if (this.disposed) return;
    const address = this.target.statusAddress ?? this.target.groupAddress;
    if (this.caps.readWithResponse) {
      try {
        const res = await this.conn.sendMessagePromise<{ response?: { payload?: unknown } }>({
          type: "call_service",
          domain: "knx",
          service: "read",
          service_data: { address },
          return_response: true,
        });
        const value = decodeOnOff(this.target.dpt, res?.response?.payload);
        if (value) this.emitter.emit({ type: "state", value, via: "read_response", at: Date.now() });
      } catch {
        // no device answered the read (read flag not set / wrong address) — state stays unknown
      }
      return;
    }
    if (this.push && this.caps.canRead) {
      await callService(this.conn, "knx", "read", { address }).catch(() => undefined);
    }
  }

  subscribe(listener: AdapterListener): () => void {
    return this.emitter.subscribe(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.readTimer) clearTimeout(this.readTimer);
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.resolve(false);
      this.waiter = null;
    }
    this.conn.removeEventListener("ready", this.onReady);
    this.conn.removeEventListener("disconnected", this.onDisconnected);
    this.conn.removeEventListener("reconnect-error", this.onReconnectError);
    try {
      await this.unsubscribe?.();
    } catch {
      /* ignore */
    }
    this.conn.close();
    this.emitter.clear();
  }
}
