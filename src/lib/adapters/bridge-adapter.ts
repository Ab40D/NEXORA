/**
 * LightAdapter backed by the SE7ENX Bridge (KNXnet/IP via xknx on the LAN).
 */
import type { BridgeClient, EventStreamHandle } from "@/lib/bridge/client";
import type { CommandResponse, KnxStatus, LightConfig, LightStateDto } from "@/lib/bridge/contract";
import type { LinkStatus, OnOff } from "@/lib/state/types";
import { AdapterEmitter, type AdapterListener, type CommandContext, type CommandOutcome, type LightAdapter } from "./types";

export function describeKnxStatus(s: KnxStatus): string {
  const type = s.connectionType.replace(/_/g, " ");
  const gw = s.gateway?.name || s.gateway?.host;
  return `${type}${gw ? ` via ${gw}` : ""}${s.gateway?.host && s.gateway?.name ? ` (${s.gateway.host})` : ""}`;
}

export function knxStatusToLink(s: KnxStatus): { status: LinkStatus; message: string } {
  switch (s.state) {
    case "connected":
      return {
        status: "connected",
        message:
          s.confirmation === "local"
            ? `KNX ${describeKnxStatus(s)} — routing mode: commands cannot be bus-confirmed.`
            : `KNX ${describeKnxStatus(s)}`,
      };
    case "connecting":
      return { status: "reconnecting", message: "Bridge online — KNX interface (re)connecting…" };
    case "disconnected":
      return { status: "disconnected", message: "Bridge online, but the KNX interface is disconnected." };
    default:
      return {
        status: "error",
        message: `Bridge online, KNX interface error: ${s.lastError?.message ?? "unknown error"}`,
      };
  }
}

export function commandOutcome(res: CommandResponse): CommandOutcome {
  if (res.outcome === "bus_confirmed") return { phase: "bus_confirmed", detail: res.detail };
  return { phase: "accepted", detail: res.detail };
}

export class BridgeAdapter implements LightAdapter {
  readonly mode = "bridge" as const;
  readonly label: string;
  readonly feedbackAvailable: boolean;
  private emitter = new AdapterEmitter();
  private stream: EventStreamHandle | null = null;
  private disposed = false;
  private knxConnected = false;

  constructor(
    private readonly client: BridgeClient,
    private readonly light: LightConfig,
    knx: KnxStatus,
  ) {
    this.label = `SE7ENX Bridge ${client.baseUrl} → ${describeKnxStatus(knx)}`;
    // A status address gives actuator feedback; without it the bridge can still
    // read the switching address if the actuator's object has the read flag.
    this.feedbackAvailable = light.statusAddress !== null;
    this.knxConnected = knx.state === "connected";
  }

  get lightId(): string {
    return this.light.id;
  }

  /** Start streaming events. Call once after construction. */
  start(): void {
    if (this.stream || this.disposed) return;
    this.stream = this.client.openEvents({
      onOpen: () => {
        void this.refreshState().catch(() => undefined);
      },
      onEvent: (ev) => {
        if (ev.type === "hello" || ev.type === "knx.status") {
          const status = ev.type === "hello" ? ev.data.knx : ev.data;
          const wasConnected = this.knxConnected;
          this.knxConnected = status.state === "connected";
          const link = knxStatusToLink(status);
          this.emitter.emit({ type: "link", status: link.status, message: link.message });
          if (!wasConnected && this.knxConnected && ev.type === "knx.status") void this.refreshState().catch(() => undefined);
        } else if (ev.type === "light.state" && ev.data.lightId === this.light.id) {
          this.emitState(ev.data);
        }
      },
      onDrop: (err) => {
        this.emitter.emit({ type: "link", status: "reconnecting", message: `${err.message} Retrying…` });
      },
      onAuthError: (err) => {
        this.emitter.emit({ type: "link", status: "error", message: `${err.message} ${err.hint ?? ""}`.trim() });
      },
    });
  }

  private emitState(dto: LightStateDto): void {
    if (dto.value === "unknown") return;
    this.emitter.emit({
      type: "state",
      value: dto.value,
      via: dto.via,
      at: Date.now(), // client receive time: avoids clock skew between bridge host and browser
    });
  }

  async send(value: OnOff, ctx: CommandContext): Promise<CommandOutcome> {
    const res = await this.client.command(this.light.id, value, ctx.requestId, ctx.source);
    return commandOutcome(res);
  }

  async refreshState(): Promise<void> {
    const dto = await this.client.lightState(this.light.id, true);
    this.emitState(dto);
  }

  subscribe(listener: AdapterListener): () => void {
    return this.emitter.subscribe(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stream?.close();
    this.stream = null;
    this.emitter.clear();
  }
}
