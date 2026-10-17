/**
 * Pure helpers for presenting hub devices truthfully (reported vs requested state), localized.
 * Labels for integrations, connection states and outcomes live in the dictionaries (hub.*).
 */
import { formatPercent, type Locale } from "@/lib/i18n/core";
import { translate } from "@/lib/i18n";
import type { DeviceType } from "./contract";

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

/** Human-readable reported state, e.g. ["On", "40%", "61.5 W"]. Empty when the device reported nothing. */
export function describeReported(type: DeviceType, reported: Record<string, unknown>, locale: Locale = "en"): string[] {
  const out: string[] = [];
  if (typeof reported.on === "boolean") out.push(translate(locale, reported.on ? "hub.state.on" : "hub.state.off"));
  const brightness = num(reported.brightness);
  if (brightness !== null && type === "light") out.push(formatPercent(brightness, locale));
  const position = num(reported.position);
  if (position !== null) out.push(translate(locale, "hub.state.open", { value: formatPercent(position, locale) }));
  if (reported.moving === "opening" || reported.moving === "closing") out.push(translate(locale, reported.moving === "opening" ? "hub.state.opening" : "hub.state.closing"));
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
  if (temperature !== null && type !== "sensor") out.push(translate(locale, "hub.state.deviceTemp", { value: `${temperature.toFixed(0)} °C` }));
  return out;
}

/** Requested (not yet confirmed) state, e.g. "40%" or "Off". */
export function describeRequested(requested: Record<string, unknown> | null, locale: Locale = "en"): string | null {
  if (!requested) return null;
  const parts: string[] = [];
  if (typeof requested.on === "boolean") parts.push(translate(locale, requested.on ? "hub.state.on" : "hub.state.off"));
  const b = num(requested.brightness);
  if (b !== null) parts.push(formatPercent(b, locale));
  const p = num(requested.position);
  if (p !== null) parts.push(translate(locale, "hub.state.open", { value: formatPercent(p, locale) }));
  return parts.length ? parts.join(", ") : null;
}

export function relativeTime(iso: string | null, now: number = Date.now(), locale: Locale = "en"): string {
  if (!iso) return translate(locale, "time.never");
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return translate(locale, "time.unknownTime");
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return translate(locale, "time.now");
  if (s < 60) return translate(locale, "time.seconds", { n: s });
  if (s < 3600) return translate(locale, "time.minutes", { n: Math.round(s / 60) });
  if (s < 86400) return translate(locale, "time.hours", { n: Math.round(s / 3600) });
  return new Date(t).toLocaleString(locale === "ar" ? "ar-u-nu-latn" : locale === "dz" ? "ar-DZ-u-nu-latn" : locale);
}
