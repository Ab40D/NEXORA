/**
 * Typed client for the SE7ENX Bridge API (contract v1).
 */
import type { z } from "zod";
import { AdapterError } from "@/lib/adapters/types";
import { fetchWithTimeout, NetworkError } from "@/lib/net/http";
import type { CommandSource, OnOff } from "@/lib/state/types";
import {
  API_PREFIX,
  BridgeEventSchema,
  CommandResponseSchema,
  DiscoverResponseSchema,
  ErrorBodySchema,
  HealthSchema,
  KnxStatusSchema,
  LightResponseSchema,
  LightStateSchema,
  PairResponseSchema,
  SessionInfoSchema,
  TestResultSchema,
  type BridgeEvent,
  type CommandResponse,
  type ConnectOverride,
  type Gateway,
  type Health,
  type KnxStatus,
  type LightRegistration,
  type LightResponse,
  type LightStateDto,
  type PairResponse,
  type SessionInfo,
  type TestResult,
} from "./contract";
import { SseParser } from "./sse";

export interface BridgeClientOptions {
  baseUrl: string;
  targetAddressSpace?: "loopback" | "local";
  token?: string | null;
  timeoutMs?: number;
  /** origin of this web app, used in actionable error hints */
  appOrigin?: string;
  /** event stream watchdogs (tests use shorter values) */
  streamTimeouts?: { firstByteMs?: number; idleMs?: number };
}

export interface EventStreamHandlers {
  onEvent: (event: BridgeEvent) => void;
  onOpen?: () => void;
  onDrop?: (err: AdapterError) => void;
  onAuthError?: (err: AdapterError) => void;
}

export interface EventStreamHandle {
  close: () => void;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
const STREAM_IDLE_TIMEOUT_MS = 45_000;
/** The bridge sends its hello immediately; silence means something is buffering the stream. */
const STREAM_FIRST_BYTE_TIMEOUT_MS = 10_000;

export class BridgeClient {
  readonly baseUrl: string;
  private token: string | null;
  private readonly targetAddressSpace: "loopback" | "local" | undefined;
  private readonly timeoutMs: number;
  private readonly appOrigin: string;
  private readonly firstByteMs: number;
  private readonly idleMs: number;

  constructor(opts: BridgeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.targetAddressSpace = opts.targetAddressSpace;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.appOrigin = opts.appOrigin ?? (typeof location !== "undefined" ? location.origin : "this site");
    this.firstByteMs = opts.streamTimeouts?.firstByteMs ?? STREAM_FIRST_BYTE_TIMEOUT_MS;
    this.idleMs = opts.streamTimeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${API_PREFIX}${path}`;
  }

  private unreachable(err: NetworkError): AdapterError {
    if (err.kind === "timeout") {
      return new AdapterError("BRIDGE_TIMEOUT", `The SE7ENX Bridge at ${this.baseUrl} did not answer in time.`, {
        hint: "Check that the bridge is running and reachable from this device. The KNX interface may also be slow to respond.",
        cause: err,
      });
    }
    return new AdapterError("BRIDGE_UNREACHABLE", `Cannot reach the SE7ENX Bridge at ${this.baseUrl}.`, {
      hint:
        `Check that the bridge is running and the URL/port are correct, and that this device can reach it (same LAN or tailnet). ` +
        `The bridge must allow this site's origin (${this.appOrigin}) in SE7ENX_ALLOWED_ORIGINS. ` +
        `For http:// LAN addresses, allow “local network access” when the browser asks; Safari/Firefox require https://.`,
      cause: err,
    });
  }

  private async request<S extends z.ZodTypeAny>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    schema: S | null,
    body?: unknown,
    opts: { auth?: boolean; timeoutMs?: number } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      if (!this.token) throw new AdapterError("NOT_PAIRED", "This browser is not paired with the bridge yet.", { hint: "Enter the pairing code shown by the bridge." });
      headers.Authorization = `Bearer ${this.token}`;
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        targetAddressSpace: this.targetAddressSpace,
        credentials: "omit",
        cache: "no-store",
        mode: "cors",
      });
    } catch (err) {
      if (err instanceof NetworkError) throw this.unreachable(err);
      throw err;
    }

    if (res.status === 204) return undefined as z.infer<S>;

    let json: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new AdapterError(e.code, e.message, { hint: e.hint ?? defaultHint(res.status), status: res.status });
      }
      throw new AdapterError(`HTTP_${res.status}`, `Bridge returned HTTP ${res.status}.`, { hint: defaultHint(res.status), status: res.status });
    }

    if (!schema) return json as z.infer<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AdapterError("CONTRACT_MISMATCH", "The bridge answered with an unexpected response format.", {
        hint: "Make sure the bridge and the web app versions are compatible (API v1).",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  health(): Promise<Health> {
    return this.request("GET", "/health", HealthSchema, undefined, { auth: false, timeoutMs: 5000 });
  }

  async pair(code: string, clientName: string): Promise<PairResponse> {
    const res = await this.request("POST", "/pair", PairResponseSchema, { code, clientName }, { auth: false });
    this.token = res.token;
    return res;
  }

  session(): Promise<SessionInfo> {
    return this.request("GET", "/session", SessionInfoSchema);
  }

  async revoke(): Promise<void> {
    await this.request("POST", "/session/revoke", null, {});
    this.token = null;
  }

  knxStatus(): Promise<KnxStatus> {
    return this.request("GET", "/knx/status", KnxStatusSchema);
  }

  async discover(): Promise<Gateway[]> {
    const res = await this.request("POST", "/knx/discover", DiscoverResponseSchema, {}, { timeoutMs: 15000 });
    return res.gateways;
  }

  connect(override?: ConnectOverride): Promise<KnxStatus> {
    return this.request("POST", "/knx/connect", KnxStatusSchema, override ? { override } : {}, { timeoutMs: 25000 });
  }

  disconnect(): Promise<KnxStatus> {
    return this.request("POST", "/knx/disconnect", KnxStatusSchema, {}, { timeoutMs: 15000 });
  }

  test(readAddress?: string | null): Promise<TestResult> {
    return this.request("POST", "/knx/test", TestResultSchema, readAddress ? { readAddress } : {}, { timeoutMs: 15000 });
  }

  putLight(id: string, reg: LightRegistration): Promise<LightResponse> {
    return this.request("PUT", `/lights/${encodeURIComponent(id)}`, LightResponseSchema, reg);
  }

  lightState(id: string, refresh = false): Promise<LightStateDto> {
    return this.request("GET", `/lights/${encodeURIComponent(id)}/state${refresh ? "?refresh=1" : ""}`, LightStateSchema, undefined, {
      timeoutMs: refresh ? 12000 : this.timeoutMs,
    });
  }

  command(id: string, value: OnOff, requestId: string, source: CommandSource): Promise<CommandResponse> {
    return this.request("POST", `/lights/${encodeURIComponent(id)}/${value}`, CommandResponseSchema, { requestId, source }, { timeoutMs: 12000 });
  }

  /**
   * Open the authenticated server-sent event stream with automatic reconnect
   * (exponential backoff) and an idle watchdog. Stops permanently on 401/403.
   */
  openEvents(handlers: EventStreamHandlers): EventStreamHandle {
    let closed = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (err: AdapterError) => {
      if (closed) return;
      handlers.onDrop?.(err);
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]!;
      attempt++;
      retryTimer = setTimeout(run, delay);
    };

    const run = async () => {
      if (closed) return;
      controller = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let gotData = false;
      let stalled = false;
      const kick = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(
          () => {
            stalled = true;
            controller?.abort();
          },
          gotData ? this.idleMs : this.firstByteMs,
        );
      };
      try {
        const init: RequestInit & { targetAddressSpace?: string } = {
          method: "GET",
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.token ?? ""}` },
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
        };
        if (this.targetAddressSpace) init.targetAddressSpace = this.targetAddressSpace;
        kick();
        const res = await fetch(this.url("/events"), init);
        if (res.status === 401 || res.status === 403) {
          const body = ErrorBodySchema.safeParse(await res.json().catch(() => null));
          closed = true;
          handlers.onAuthError?.(
            new AdapterError(body.success ? body.data.error.code : "UNAUTHORIZED", body.success ? body.data.error.message : "Bridge session rejected.", {
              hint: "Your pairing session expired or was revoked (bridge restarted?). Pair again with a new code.",
              status: res.status,
            }),
          );
          return;
        }
        if (!res.ok || !res.body) throw new AdapterError(`HTTP_${res.status}`, `Event stream failed with HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let opened = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          gotData = true;
          kick();
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            let data: unknown = {};
            try {
              data = msg.data ? JSON.parse(msg.data) : {};
            } catch {
              continue;
            }
            const parsed = BridgeEventSchema.safeParse({ type: msg.event, data });
            if (!parsed.success) continue;
            if (parsed.data.type === "hello" && !opened) {
              opened = true;
              attempt = 0;
              handlers.onOpen?.();
            }
            handlers.onEvent(parsed.data);
          }
        }
        throw new AdapterError("STREAM_CLOSED", "Bridge closed the event stream.");
      } catch (err) {
        if (closed) return;
        const e =
          err instanceof AdapterError
            ? err
            : stalled
              ? new AdapterError(
                  gotData ? "STREAM_IDLE" : "STREAM_BUFFERED",
                  gotData
                    ? "The bridge event stream went silent."
                    : "Connected to the bridge, but live updates are not arriving — a proxy may be buffering or compressing the event stream.",
                  { hint: "If the bridge is behind a reverse proxy, disable buffering/compression for /api/v1/events.", cause: err },
                )
              : new AdapterError("STREAM_LOST", "Lost connection to the bridge event stream.", { cause: err });
        scheduleRetry(e);
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
    };

    void run();
    return {
      close: () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        controller?.abort();
      },
    };
  }
}

function defaultHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return "Pair this browser again with the code shown by the bridge.";
    case 403:
      return "The bridge rejected this request (origin or group address not permitted). Check the bridge configuration.";
    case 404:
      return "Endpoint not found — is this URL really an SE7ENX Bridge (API v1)?";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    default:
      return status >= 500 ? "The bridge reported an internal or KNX error. Check the bridge logs." : undefined;
  }
}
