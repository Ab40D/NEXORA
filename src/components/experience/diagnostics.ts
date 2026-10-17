/**
 * Connection diagnostics shared by the Connect workspace cards: maps hub/integration/device status
 * to the stages shown to the user (Not configured · Connecting · Authentication failed · Device
 * unreachable · Interface detected · Protocol unsupported · Connected · Connected, state
 * unavailable · Disconnected) plus actionable guidance.
 */
import type { HubDevice, IntegrationStatus, KnxInterface } from "@/lib/hub/contract";
import type { MessageKey } from "@/lib/i18n";

export type Stage =
  | "notConfigured"
  | "connecting"
  | "authFailed"
  | "unreachable"
  | "interfaceDetected"
  | "protocolUnsupported"
  | "connected"
  | "connectedNoState"
  | "disconnected"
  | "ready"
  | "needsHub";

export interface Diagnosis {
  stage: Stage;
  guide?: MessageKey;
  /** extra localized detail (e.g. a KNX error explanation) */
  detail?: MessageKey;
}

export const STAGE_TONE: Record<Stage, "ok" | "warn" | "danger" | "neutral" | "accent"> = {
  notConfigured: "neutral",
  connecting: "accent",
  authFailed: "danger",
  unreachable: "danger",
  interfaceDetected: "accent",
  protocolUnsupported: "warn",
  connected: "ok",
  connectedNoState: "warn",
  disconnected: "danger",
  ready: "ok",
  needsHub: "neutral",
};

const GUIDE: Partial<Record<Stage, MessageKey>> = {
  notConfigured: "connect.guide.notConfigured",
  authFailed: "connect.guide.authFailed",
  unreachable: "connect.guide.unreachable",
  protocolUnsupported: "connect.guide.protocolUnsupported",
  connectedNoState: "connect.guide.connectedNoState",
  disconnected: "connect.guide.disconnected",
};

const withGuide = (stage: Stage, detail?: MessageKey): Diagnosis => ({ stage, guide: GUIDE[stage], ...(detail ? { detail } : {}) });

const KNX_ERRORS = ["KNX_CONNECT_TIMEOUT", "KNX_NO_GATEWAY_FOUND", "KNX_SECURE_ERROR", "KNX_CONNECT_FAILED"] as const;
type KnxErrorCode = (typeof KNX_ERRORS)[number];
const isKnxError = (code: string | undefined): code is KnxErrorCode => (KNX_ERRORS as readonly string[]).includes(code ?? "");

export function knxDiagnosis(k: KnxInterface | null, hubReady: boolean): Diagnosis {
  if (!hubReady) return { stage: "needsHub" };
  if (!k) return { stage: "connecting" };
  if (k.source === "none") return withGuide("notConfigured");
  const st = k.status.state;
  if (st === "connected") return { stage: "connected" };
  if (st === "connecting") return { stage: "connecting" };
  const code = k.status.lastError?.code;
  const detail: MessageKey | undefined = isKnxError(code) ? `knx.error.${code}` : undefined;
  if (code === "KNX_SECURE_ERROR") return withGuide("authFailed", detail);
  if (code === "KNX_CONNECT_TIMEOUT" || code === "KNX_NO_GATEWAY_FOUND" || code === "KNX_CONNECT_FAILED") return withGuide("unreachable", detail);
  return withGuide("disconnected", detail);
}

export function integrationDiagnosis(i: IntegrationStatus | undefined, hubReady: boolean): Diagnosis {
  if (!hubReady) return { stage: "needsHub" };
  if (!i) return withGuide("notConfigured");
  switch (i.state) {
    case "connected":
    case "degraded":
      return { stage: "connected" };
    case "connecting":
      return { stage: "connecting" };
    case "auth_failed":
      return withGuide("authFailed");
    case "not_configured":
      return withGuide("notConfigured");
    default: {
      const code = i.lastError?.code ?? "";
      return withGuide(/UNREACHABLE|TIMEOUT/.test(code) ? "unreachable" : "disconnected");
    }
  }
}

export function deviceDiagnosis(d: HubDevice): Diagnosis {
  if (d.simulated) return { stage: "ready" };
  switch (d.connection.status) {
    case "online":
      return typeof d.state.reported.on === "boolean" || d.state.reportedAt ? { stage: "connected" } : withGuide("connectedNoState");
    case "unauthorized":
      return withGuide("authFailed");
    case "unknown":
      return { stage: "connecting" };
    case "offline":
      return withGuide("unreachable");
    default:
      return withGuide("disconnected");
  }
}

/** Integration-level view for Shelly (devices are configured one by one). */
export function shellyDiagnosis(devices: HubDevice[], hubReady: boolean): Diagnosis {
  if (!hubReady) return { stage: "needsHub" };
  const shelly = devices.filter((d) => d.integration === "shelly");
  if (!shelly.length) return withGuide("notConfigured");
  if (shelly.some((d) => d.connection.status === "unauthorized")) return withGuide("authFailed");
  if (shelly.some((d) => d.connection.status === "online")) return { stage: "connected" };
  if (shelly.some((d) => d.connection.status === "unknown")) return { stage: "connecting" };
  return withGuide("unreachable");
}
