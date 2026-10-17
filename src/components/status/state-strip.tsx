"use client";

import { EXEC_VIEW } from "@/components/experience/exec-view";
import { useNow } from "@/lib/device";
import { useExperience, useTarget, type ExperienceCommand } from "@/lib/experience/store";
import { useT } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";

function Cell({ label, value, sub, tone, testId }: { label: string; value: string; sub: string; tone: string; testId?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-ink-700/70 bg-ink-850/70 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">{label}</p>
      <p data-testid={testId} dir="auto" className={cn("mt-1 truncate font-mono text-lg font-semibold tracking-wider", tone)}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-300" title={sub}>
        {sub}
      </p>
    </div>
  );
}

/** Keeps the kinds of state visibly separate: simulated, requested, confirmed. */
export function StateStrip() {
  const target = useTarget();
  return target ? <ExperienceStrip /> : <LegacyStrip />;
}

function ExperienceStrip() {
  const { t, pct, ago } = useT();
  const target = useTarget();
  const exec = useExperience((s) => s.exec);
  const now = useNow(1000);
  if (!target) return null;
  const level = (on: boolean, b: number | null) => (on ? (target.dimmable && b !== null ? `${t("light.on")} · ${pct(b)}` : t("light.on")) : t("light.off"));
  const cmdLabel = (c: ExperienceCommand) =>
    c.kind === "set_brightness"
      ? t("cmd.set_brightness", { value: pct(c.value) })
      : c.kind === "adjust_brightness"
        ? c.delta >= 0
          ? t("cmd.brighter", { value: pct(c.delta) })
          : t("cmd.dimmer", { value: pct(-c.delta) })
        : t(`cmd.${c.kind}`);
  const view = exec ? EXEC_VIEW[exec.state] : null;
  const confirmed = target.simulated
    ? { label: t("strip.simulatedState"), value: target.state ? level(target.state.on, target.state.brightness) : t("strip.unknown"), sub: t("strip.simNoDevice"), tone: "text-sim" }
    : target.state
      ? { label: t("strip.confirmed"), value: level(target.state.on, target.state.brightness), sub: t("strip.reliable"), tone: target.state.on ? "text-warm" : "text-ink-50" }
      : { label: t("strip.confirmed"), value: t("strip.unknown"), sub: target.hasFeedback ? t("strip.unreliable") : t("light.noFeedback"), tone: "text-ink-400" };
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={t("strip.aria")} data-testid="experience-strip">
      <Cell
        label={t("strip.light")}
        value={target.name}
        sub={`${t(target.simulated ? "badge.simulation" : "badge.real")} · ${t(`experience.providers.${target.provider}`)}`}
        tone={target.simulated ? "text-sim" : "text-accent"}
        testId="xp-strip-light"
      />
      <Cell
        label={t("strip.requested")}
        value={exec ? cmdLabel(exec.command) : "—"}
        sub={exec && view ? `${t(view.key)} · ${t(`exec.source.${exec.source}`)} · ${ago(exec.at, now)}` : t("strip.noCommand")}
        tone={!view ? "text-ink-400" : view.tone === "danger" ? "text-danger" : view.tone === "accent" ? "text-accent" : "text-ink-50"}
        testId="xp-strip-requested"
      />
      <Cell label={confirmed.label} value={confirmed.value} sub={confirmed.sub} tone={confirmed.tone} testId="xp-strip-confirmed" />
    </div>
  );
}

function LegacyStrip() {
  const { t, ago } = useT();
  const light = useAppStore((s) => s.light);
  const now = useNow(1000);
  const cmd = light.lastCommand;
  const isSim = light.mode === "simulation";
  const onOff = (v: "on" | "off") => t(v === "on" ? "lamp.legacyOn" : "lamp.legacyOff");

  const requested = cmd
    ? {
        value: onOff(cmd.value),
        sub: `${t(`strip.phase.${cmd.phase}`)} · ${t(`exec.source.${cmd.source}`)} · ${ago(cmd.createdAt, now)}`,
        tone: cmd.phase === "failed" ? "text-danger" : cmd.phase === "pending" ? "text-accent" : "text-ink-50",
      }
    : { value: "—", sub: t("strip.noCommand"), tone: "text-ink-400" };

  const rep = light.reported;
  const via = rep.via === "status_address" || rep.via === "read_response" || rep.via === "switch_address" ? rep.via : "backend";
  const confirmed = isSim
    ? { value: t("strip.na"), sub: t("strip.simNoDevice"), tone: "text-ink-400" }
    : rep.value !== "unknown" && rep.at
      ? { value: onOff(rep.value), sub: `${t(`strip.via.${via}`)} · ${ago(rep.at, now)}`, tone: rep.value === "on" ? "text-warm" : "text-ink-50" }
      : { value: t("strip.unknown"), sub: light.feedbackAvailable ? t("strip.waitingFeedback") : t("strip.noFeedback"), tone: "text-ink-400" };

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={t("strip.aria")}>
      <Cell
        label={isSim ? t("strip.simLamp") : t("strip.mode")}
        value={isSim ? onOff(light.simulated) : light.mode === "bridge" ? t("strip.liveBridge") : t("strip.liveHa")}
        sub={isSim ? t("strip.inBrowser") : (light.backendLabel ?? "")}
        tone={isSim ? "text-sim" : "text-accent"}
        testId="simulated-state"
      />
      <Cell label={t("strip.requested")} value={requested.value} sub={requested.sub} tone={requested.tone} testId="requested-state" />
      <Cell label={t("strip.confirmed")} value={confirmed.value} sub={confirmed.sub} tone={confirmed.tone} testId="confirmed-state" />
    </div>
  );
}
