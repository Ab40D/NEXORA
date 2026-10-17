/** Pure helpers for presenting hub devices truthfully (reported vs requested state). */
import type { DeviceType, HubDevice, Integration } from "./contract";

export const INTEGRATION_LABEL: Record<Integration, string> = {
  simulated: "Simulated",
  shelly: "Shelly",
  homeassistant: "Home Assistant",
  knx: "KNX",
};

export const CONNECTION_LABEL: Record<HubDevice["connection"]["status"], string> = {
  online: "Online",
  offline: "Offline",
  unauthorized: "Not authorized",
  unavailable: "Unavailable",
  error: "Error",
  unknown: "Unknown",
};

/** Device id from a display name: lowercase slug, unique among existing ids. */
export function slugifyId(name: string, existing: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "device";
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 44)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 36)}-${Date.now().toString(36)}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Human-readable reported state, e.g. ["On", "40 %", "61.5 W"]. Empty when the device reported nothing. */
export function describeReported(type: DeviceType, reported: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof reported.on === "boolean") out.push(reported.on ? "On" : "Off");
  const brightness = num(reported.brightness);
  if (brightness !== null && type === "light") out.push(`${Math.round(brightness)} %`);
  const position = num(reported.position);
  if (position !== null) out.push(`${Math.round(position)} % open`);
  if (reported.moving === "opening" || reported.moving === "closing") out.push(reported.moving === "opening" ? "Opening…" : "Closing…");
  const power = num(reported.power);
  if (power !== null) out.push(`${power.toFixed(power < 10 ? 1 : 0)} W`);
  const energy = num(reported.energy);
  if (energy !== null) out.push(energy >= 1000 ? `${(energy / 1000).toFixed(2)} kWh` : `${energy.toFixed(1)} Wh`);
  if ("value" in reported && reported.value !== null && reported.value !== undefined) {
    const v = reported.value;
    const unit = typeof reported.unit === "string" ? ` ${reported.unit}` : "";
    out.push(typeof v === "number" ? `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}` : `${String(v)}${unit}`);
  }
  const temperature = num(reported.temperature);
  if (temperature !== null && type !== "sensor") out.push(`device ${temperature.toFixed(0)} °C`);
  return out;
}

/** Requested (not yet confirmed) state, e.g. "40 %" or "Off". */
export function describeRequested(requested: Record<string, unknown> | null): string | null {
  if (!requested) return null;
  const parts: string[] = [];
  if (typeof requested.on === "boolean") parts.push(requested.on ? "On" : "Off");
  const b = num(requested.brightness);
  if (b !== null) parts.push(`${b} %`);
  const p = num(requested.position);
  if (p !== null) parts.push(`${p} % open`);
  return parts.length ? parts.join(", ") : null;
}

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}

export const OUTCOME_LABEL = {
  confirmed: "Confirmed by the device",
  accepted: "Accepted, awaiting device confirmation",
  simulated: "Simulated (no hardware)",
  already_satisfied: "Already in this state, nothing was sent",
} as const;
