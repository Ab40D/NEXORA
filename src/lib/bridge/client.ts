/**
 * Typed client for the SE7ENX Bridge API (contract v1).
 */
import {
  AssistantInfoSchema,
  AssistantInterpretSchema,
  TranscriptionSchema,
  DeviceListSchema,
  HaConfigSchema,
  HaEntitiesSchema,
  HaTestSchema,
  HubCommandResponseSchema,
  HubDeviceSchema,
  IntegrationListSchema,
  KnxInterfaceSchema,
  KnxUsbReportSchema,
  SafetySchema,
  ShellyIdentitySchema,
  type AddDeviceBody,
  type AssistantInfo,
  type Transcription,
  type AssistantInterpretation,
  type DevicePatchBody,
  type HaConfig,
  type HaEntity,
  type HubCommand,
  type HubCommandResponse,
  type HubDevice,
  type KnxInterface,
  type KnxInterfaceInput,
  type KnxUsbReport,
  type Safety,
  type ShellyIdentity,
} from "@/lib/hub/contract";
import { z } from "zod";
import {
  AccountSessionSchema,
  AuditPageSchema,
  AuthStatusSchema,
  BuildingSnapshotSchema,
  CreatedInviteSchema,
  CreatedUserSchema,
  InvitesSchema,
  MeSchema,
  OneTimeCodeSchema,
  RolesSchema,
  SecuritySchema,
  SignInResultSchema,
  UpdatedUserSchema,
  UsersSchema,
  type AccountSession,
  type AuthStatus,
  type BuildingCollection,
  type BuildingImportTree,
  type BuildingSnapshot,
  type Me,
  type OneTimeCode,
  type Preferences,
  type Registration,
  type Role,
  type Roles,
  type SignInResult,
  type User,
} from "@/lib/core/contract";
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
  /**
   * Same-origin account session (appliance): the hub's HttpOnly session cookie authenticates requests,
   * no token is ever visible to JavaScript. Cross-origin clients use a bearer token instead.
   */
  cookieAuth?: boolean;
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
  readonly cookieAuth: boolean;

  constructor(opts: BridgeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.targetAddressSpace = opts.targetAddressSpace;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.appOrigin = opts.appOrigin ?? (typeof location !== "undefined" ? location.origin : "this site");
    this.firstByteMs = opts.streamTimeouts?.firstByteMs ?? STREAM_FIRST_BYTE_TIMEOUT_MS;
    this.idleMs = opts.streamTimeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.cookieAuth = opts.cookieAuth ?? false;
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
        // The browser cannot tell "nothing is listening" from "origin not allowed" (both are opaque
        // network errors; the bridge's CORP header also blocks no-cors probes), so list both and
        // point at the bridge log, which is unambiguous.
        `Check that the bridge is running and that this is its web address: the bridge prints it when it starts (default port 8787; the dev stack prints a “Bridge URL” line). ` +
        `The KNX interface's own address (UDP port 3671, or the dev stack's internal fake-interface port) is not the bridge URL. ` +
        `This device must be able to reach the bridge (same LAN or tailnet). ` +
        `If the bridge logs “Rejected request from origin '${this.appOrigin}'”, add ${this.appOrigin} to SE7ENX_ALLOWED_ORIGINS and restart it; with the SE7ENX Docker appliance you can instead open the appliance's own address, which serves this app. ` +
        `For http:// LAN addresses, allow “local network access” when the browser asks; Safari/Firefox require https://.`,
      cause: err,
    });
  }

  private async request<S extends z.ZodTypeAny>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    schema: S | null,
    body?: unknown,
    opts: { auth?: boolean; timeoutMs?: number; raw?: { body: Blob; contentType: string } } = {},
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.raw) headers["Content-Type"] = opts.raw.contentType;
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      else if (!this.cookieAuth)
        throw new AdapterError("NOT_PAIRED", "This browser is not paired with the bridge yet.", { hint: "Enter the pairing code shown by the bridge." });
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path), {
        method,
        headers,
        body: opts.raw ? opts.raw.body : body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        targetAddressSpace: this.targetAddressSpace,
        credentials: this.cookieAuth ? "same-origin" : "omit",
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
  // ------------------------------------------------------------------ hub device API (bridge >= 1.1)

  devices(): Promise<z.infer<typeof DeviceListSchema>> {
    return this.request("GET", "/devices", DeviceListSchema);
  }

  addDevice(body: AddDeviceBody): Promise<HubDevice> {
    return this.request("POST", "/devices", HubDeviceSchema, body, { timeoutMs: 20000 });
  }

  patchDevice(id: string, patch: DevicePatchBody): Promise<HubDevice> {
    return this.request("PATCH", `/devices/${encodeURIComponent(id)}`, HubDeviceSchema, patch);
  }

  async removeDevice(id: string): Promise<void> {
    await this.request("DELETE", `/devices/${encodeURIComponent(id)}`, null);
  }

  deviceCommand(
    id: string,
    command: HubCommand,
    params: Record<string, unknown>,
    requestId: string,
    source: CommandSource = "manual",
  ): Promise<HubCommandResponse> {
    return this.request("POST", `/devices/${encodeURIComponent(id)}/commands`, HubCommandResponseSchema, { command, params, requestId, source }, { timeoutMs: 16000 });
  }

  refreshDevice(id: string): Promise<HubDevice> {
    return this.request("POST", `/devices/${encodeURIComponent(id)}/refresh`, HubDeviceSchema, {}, { timeoutMs: 15000 });
  }

  integrations(): Promise<z.infer<typeof IntegrationListSchema>> {
    return this.request("GET", "/integrations", IntegrationListSchema);
  }

  setSafety(active: boolean): Promise<Safety> {
    return this.request("POST", active ? "/safety/stop" : "/safety/resume", SafetySchema, {});
  }

  shellyIdentify(host: string, username?: string, password?: string): Promise<ShellyIdentity> {
    const body: Record<string, string> = { host };
    if (username) body.username = username;
    if (password) body.password = password;
    return this.request("POST", "/integrations/shelly/identify", ShellyIdentitySchema, body, { timeoutMs: 20000 });
  }

  homeAssistant(): Promise<HaConfig> {
    return this.request("GET", "/integrations/homeassistant", HaConfigSchema);
  }

  configureHomeAssistant(url: string, token: string | undefined, verifyTls: boolean): Promise<HaConfig> {
    return this.request("PUT", "/integrations/homeassistant", HaConfigSchema, { url, verifyTls, ...(token ? { token } : {}) });
  }

  testHomeAssistant(url: string | undefined, token: string | undefined, verifyTls: boolean): Promise<z.infer<typeof HaTestSchema>> {
    return this.request("POST", "/integrations/homeassistant/test", HaTestSchema, { verifyTls, ...(url ? { url } : {}), ...(token ? { token } : {}) }, { timeoutMs: 20000 });
  }

  homeAssistantEntities(): Promise<HaEntity[]> {
    return this.request("GET", "/integrations/homeassistant/entities", HaEntitiesSchema).then((r) => r.entities);
  }

  // ---- KNX/IP interface configured on the hub (hub >= 1.2) ----

  knxInterface(): Promise<KnxInterface> {
    return this.request("GET", "/integrations/knx", KnxInterfaceSchema);
  }

  configureKnxInterface(body: KnxInterfaceInput): Promise<KnxInterface> {
    return this.request("PUT", "/integrations/knx", KnxInterfaceSchema, body);
  }

  async removeKnxInterface(): Promise<void> {
    await this.request("DELETE", "/integrations/knx", null);
  }

  /** Waits (server side, up to ~12 s) for the connection handshake to finish and returns the real result. */
  testKnxInterface(): Promise<KnxInterface> {
    return this.request("POST", "/integrations/knx/test", KnxInterfaceSchema, {}, { timeoutMs: 20000 });
  }

  knxUsbReport(): Promise<KnxUsbReport> {
    return this.request("GET", "/integrations/knx/usb", KnxUsbReportSchema);
  }

  // ---- optional LLM intent interpreter (hub >= 1.2) ----

  assistantInfo(): Promise<AssistantInfo> {
    return this.request("GET", "/assistant", AssistantInfoSchema);
  }

  assistantInterpret(body: {
    text: string;
    lang: "en" | "fr" | "ar" | "dz";
    device?: { name: string; dimmable: boolean; on: boolean | null; brightness: number | null };
  }): Promise<AssistantInterpretation> {
    return this.request("POST", "/assistant/interpret", AssistantInterpretSchema, body, { timeoutMs: 20000 });
  }

  /** Local speech-to-text on the hub (SE7ENX_STT_URL). The audio is not stored anywhere. */
  transcribe(audio: Blob, lang: string): Promise<Transcription> {
    const contentType = (audio.type || "audio/webm").split(";")[0]!;
    return this.request("POST", `/assistant/transcribe?lang=${encodeURIComponent(lang)}`, TranscriptionSchema, undefined, {
      timeoutMs: 60000,
      raw: { body: audio, contentType },
    });
  }

  exportConfig(): Promise<unknown> {
    return this.request("GET", "/config/export", null);
  }

  // ------------------------------------------------------------------ SE7ENX Core: accounts (M1)

  authStatus(): Promise<AuthStatus> {
    return this.request("GET", "/auth/status", AuthStatusSchema, undefined, { auth: false, timeoutMs: 6000 });
  }

  private async signIn(path: string, body: Record<string, unknown>): Promise<SignInResult> {
    const transport = this.cookieAuth ? "cookie" : "bearer";
    const res = await this.request("POST", path, SignInResultSchema, { ...body, transport }, { auth: false, timeoutMs: 15000 });
    if (res.token) this.token = res.token;
    return res;
  }

  setupOwner(body: { setupCode: string; username: string; displayName: string; password: string; email?: string; remember: boolean; clientName: string }): Promise<SignInResult> {
    return this.signIn("/auth/setup", body);
  }

  login(body: { login: string; password: string; remember: boolean; clientName: string }): Promise<SignInResult> {
    return this.signIn("/auth/login", body);
  }

  register(body: { inviteCode?: string; username: string; displayName: string; password: string; email?: string; remember: boolean; clientName: string }): Promise<SignInResult> {
    return this.signIn("/auth/register", body);
  }

  redeemResetCode(body: { code: string; newPassword: string; remember: boolean; clientName: string }): Promise<SignInResult> {
    return this.signIn("/auth/reset", body);
  }

  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout", null, {});
    this.token = null;
  }

  me(): Promise<Me> {
    return this.request("GET", "/auth/me", MeSchema);
  }

  updateMe(body: { displayName?: string; email?: string | null; preferences?: Preferences }): Promise<Me> {
    return this.request("PATCH", "/auth/me", MeSchema, body);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<Me> {
    return this.request("POST", "/auth/password", MeSchema, { currentPassword, newPassword }, { timeoutMs: 15000 });
  }

  async mySessions(): Promise<AccountSession[]> {
    return (await this.request("GET", "/auth/sessions", z.object({ sessions: z.array(AccountSessionSchema) }))).sessions;
  }

  async revokeMySession(id: string): Promise<void> {
    await this.request("DELETE", `/auth/sessions/${encodeURIComponent(id)}`, null);
  }

  async users(): Promise<User[]> {
    return (await this.request("GET", "/users", UsersSchema)).users;
  }

  createUser(body: { username: string; displayName: string; role: Role; email?: string; password?: string }): Promise<z.infer<typeof CreatedUserSchema>> {
    return this.request("POST", "/users", CreatedUserSchema, body, { timeoutMs: 15000 });
  }

  async updateUser(id: string, body: { displayName?: string; email?: string | null; role?: Role; disabled?: boolean }): Promise<User> {
    return (await this.request("PATCH", `/users/${encodeURIComponent(id)}`, UpdatedUserSchema, body)).user;
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/users/${encodeURIComponent(id)}`, null);
  }

  userResetCode(id: string): Promise<OneTimeCode> {
    return this.request("POST", `/users/${encodeURIComponent(id)}/reset-code`, OneTimeCodeSchema, {});
  }

  invites(): Promise<z.infer<typeof InvitesSchema>> {
    return this.request("GET", "/invites", InvitesSchema);
  }

  createInvite(role: Role, ttlHours: number): Promise<z.infer<typeof CreatedInviteSchema>> {
    return this.request("POST", "/invites", CreatedInviteSchema, { role, ttlHours });
  }

  async revokeInvite(id: string): Promise<void> {
    await this.request("DELETE", `/invites/${encodeURIComponent(id)}`, null);
  }

  roles(): Promise<Roles> {
    return this.request("GET", "/roles", RolesSchema);
  }

  updateRole(role: Role, permissions: string[]): Promise<Roles> {
    return this.request("PUT", `/roles/${encodeURIComponent(role)}`, RolesSchema, { permissions });
  }

  security(): Promise<z.infer<typeof SecuritySchema>> {
    return this.request("GET", "/system/security", SecuritySchema);
  }

  updateSecurity(registration: Registration): Promise<z.infer<typeof SecuritySchema>> {
    return this.request("PUT", "/system/security", SecuritySchema, { registration });
  }

  audit(params: { limit?: number; before?: number; action?: string; outcome?: string } = {}): Promise<z.infer<typeof AuditPageSchema>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return this.request("GET", `/audit${qs ? `?${qs}` : ""}`, AuditPageSchema);
  }

  // ------------------------------------------------------------------ SE7ENX Core: building model

  building(): Promise<BuildingSnapshot> {
    return this.request("GET", "/building", BuildingSnapshotSchema);
  }

  createBuildingEntity(collection: BuildingCollection, body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/building/${collection}`, null, body);
  }

  updateBuildingEntity(collection: BuildingCollection, id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PATCH", `/building/${collection}/${encodeURIComponent(id)}`, null, body);
  }

  deleteBuildingEntity(collection: BuildingCollection, id: string, cascade: boolean): Promise<unknown> {
    return this.request("DELETE", `/building/${collection}/${encodeURIComponent(id)}${cascade ? "?cascade=true" : ""}`, null);
  }

  importBuilding(tree: BuildingImportTree): Promise<BuildingSnapshot> {
    return this.request("POST", "/building/import", BuildingSnapshotSchema, tree);
  }

  placeDevice(deviceId: string, roomId: string | null): Promise<HubDevice> {
    return this.request("PUT", `/devices/${encodeURIComponent(deviceId)}/room`, HubDeviceSchema, { roomId });
  }

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
          headers: this.token ? { Accept: "text/event-stream", Authorization: `Bearer ${this.token}` } : { Accept: "text/event-stream" },
          signal: controller.signal,
          cache: "no-store",
          credentials: this.cookieAuth ? "same-origin" : "omit",
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
