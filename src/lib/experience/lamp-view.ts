/**
 * Digital Twin view for the selected experience target. The twin only shows what the device
 * reported (or the simulated state); an in-flight command is shown as "requested", never as done.
 */
import { formatPercent, type Locale } from "@/lib/i18n/core";
import { translate } from "@/lib/i18n";
import type { LampView } from "@/lib/state/selectors";
import type { Execution, TargetSnapshot } from "./store";

const MIN_GLOW = 0.12;

export function experienceLampView(target: TargetSnapshot, exec: Execution | null, locale: Locale): LampView {
  const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const inFlight = exec && (exec.state === "pending" || exec.state === "executing") ? exec : null;
  const pending = inFlight?.requested ? (inFlight.requested.on ? "on" : "off") : null;

  const onLabel = (brightness: number | null) =>
    brightness !== null && target.dimmable ? `${tr("light.on")} · ${formatPercent(brightness, locale)}` : tr("light.on");
  const glow = (brightness: number | null) => (brightness === null ? 1 : Math.max(MIN_GLOW, brightness / 100));

  if (target.simulated) {
    const st = target.state ?? target.lastKnown;
    const on = st?.on === true;
    return {
      lit: on,
      intensity: on ? glow(st?.brightness ?? null) : 0,
      certainty: "simulated",
      label: `${tr("badge.simulation")} · ${on ? onLabel(st?.brightness ?? null) : tr("light.off")}`,
      detail: tr("experience.simNotice"),
      tone: "sim",
      pending,
      feedbackMissing: false,
    };
  }

  if (target.connection === "offline") {
    return {
      lit: false,
      intensity: 0,
      certainty: "stale",
      label: tr("exec.offline"),
      detail: tr("errors.offline.hint"),
      tone: "error",
      pending,
      feedbackMissing: false,
    };
  }

  if (!target.state) {
    return {
      lit: false,
      intensity: 0,
      certainty: target.lastKnown ? "stale" : "unknown",
      label: tr("light.unknown"),
      detail: target.hasFeedback ? tr("light.stale") : tr("light.noFeedback"),
      tone: "warn",
      pending,
      feedbackMissing: !target.hasFeedback,
    };
  }

  const on = target.state.on;
  return {
    lit: on,
    intensity: on ? glow(target.state.brightness) : 0,
    certainty: "confirmed",
    label: on ? onLabel(target.state.brightness) : tr("light.off"),
    detail: tr("experience.twinHint"),
    tone: "live",
    pending,
    feedbackMissing: false,
  };
}
