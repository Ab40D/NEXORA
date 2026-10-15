/**
 * Datapoint types supported for light control.
 *
 * DPT 1.001 (Switch) is the standard KNX switching object: 1 bit, 1 = on.
 * DPT 5.001 (Scaling) is offered for actuators/gateways that are driven by a
 * brightness object; "on" sends the configured level, "off" sends 0 %.
 */
import type { OnOff } from "@/lib/state/types";

export const SUPPORTED_DPTS = ["1.001", "5.001"] as const;
export type DptId = (typeof SUPPORTED_DPTS)[number];

export interface DptInfo {
  id: DptId;
  name: string;
  description: string;
  sizeLabel: string;
}

export const DPT_INFO: Record<DptId, DptInfo> = {
  "1.001": {
    id: "1.001",
    name: "DPT 1.001 — Switch",
    description: "Standard on/off switching object (1 bit). Recommended for lights.",
    sizeLabel: "1 bit",
  },
  "5.001": {
    id: "5.001",
    name: "DPT 5.001 — Percentage",
    description: "Brightness value 0–100 % (1 byte). On sends the selected level, off sends 0 %.",
    sizeLabel: "1 byte",
  },
};

export function isSupportedDpt(value: unknown): value is DptId {
  return typeof value === "string" && (SUPPORTED_DPTS as readonly string[]).includes(value);
}

/** KNX payload: a small binary value (≤ 6 bits) or a byte array. */
export type KnxPayload = { kind: "binary"; value: number } | { kind: "array"; bytes: number[] };

export function clampOnLevel(level: number): number {
  if (!Number.isFinite(level)) return 100;
  return Math.min(100, Math.max(1, Math.round(level)));
}

export function percentToByte(percent: number): number {
  const p = Math.min(100, Math.max(0, percent));
  return Math.round((p * 255) / 100);
}

export function byteToPercent(byte: number): number {
  const b = Math.min(255, Math.max(0, Math.round(byte)));
  return Math.round((b * 100) / 255);
}

export function encodeOnOff(dpt: DptId, value: OnOff, onLevel = 100): KnxPayload {
  if (dpt === "1.001") return { kind: "binary", value: value === "on" ? 1 : 0 };
  return { kind: "array", bytes: [value === "on" ? percentToByte(clampOnLevel(onLevel)) : 0] };
}

/**
 * Decode a payload reported by the backend into on/off.
 * Returns null for payloads that do not fit the configured DPT.
 */
export function decodeOnOff(dpt: DptId, payload: unknown): OnOff | null {
  if (dpt === "1.001") {
    const v = Array.isArray(payload) ? (payload.length === 1 ? payload[0] : undefined) : payload;
    if (v === 0 || v === false) return "off";
    if (v === 1 || v === true) return "on";
    return null;
  }
  const v = Array.isArray(payload) ? (payload.length === 1 ? payload[0] : undefined) : payload;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) return null;
  return v > 0 ? "on" : "off";
}
