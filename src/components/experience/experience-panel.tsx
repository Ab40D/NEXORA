"use client";
/**
 * Smart Light Experience screen: the selected light, its provider, honest REAL HARDWARE /
 * SIMULATION status, confirmed state, on/off, brightness (only for dimmable lights), the last
 * command's execution state, and "Talk to SE7ENX".
 */
import { Ban, Cable, FlaskConical, Lightbulb, Minus, Plus, Power, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CommitSlider } from "@/components/ui/commit-slider";
import { Badge, Callout, Card } from "@/components/ui/primitives";
import { useExperience, useTarget, type Execution, type ExperienceCommand, type TargetSnapshot } from "@/lib/experience/store";
import { useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useUi } from "@/lib/state/ui-store";
import { cn } from "@/lib/utils";
import { AssistantChat } from "./assistant-chat";
import { EXEC_VIEW } from "./exec-view";
import { FirstTestDialog } from "./first-test-dialog";

const PRESETS = [25, 50, 75, 100] as const;
const STEP = 10;

const TONE_TEXT = { accent: "text-accent", ok: "text-ok", warn: "text-warn", danger: "text-danger", sim: "text-sim", neutral: "text-ink-200" } as const;

function useCommandLabel() {
  const { t, pct } = useT();
  return (c: ExperienceCommand) => {
    switch (c.kind) {
      case "set_brightness":
        return t("cmd.set_brightness", { value: pct(c.value) });
      case "adjust_brightness":
        return c.delta >= 0 ? t("cmd.brighter", { value: pct(c.delta) }) : t("cmd.dimmer", { value: pct(-c.delta) });
      default:
        return t(`cmd.${c.kind}`);
    }
  };
}

export function ExecutionStatus({ exec, className }: { exec: Execution | null; className?: string }) {
  const { t } = useT();
  const label = useCommandLabel();
  if (!exec) return <p className={cn("text-xs text-ink-400", className)}>{t("exec.none")}</p>;
  const view = EXEC_VIEW[exec.state];
  const Icon = view.icon;
  return (
    <div
      className={cn("space-y-1 rounded-xl border border-ink-700 bg-ink-900/60 p-3", className)}
      role="status"
      aria-live="polite"
      data-testid="exec-status"
      data-state={exec.state}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-400">{t("exec.title")}</p>
      <p className={cn("flex items-center gap-2 text-sm font-medium", TONE_TEXT[view.tone])}>
        <Icon className={cn("h-4 w-4 shrink-0", view.spin && "animate-spin")} aria-hidden />
        <span>{t(view.key)}</span>
      </p>
      <p className="text-xs text-ink-300">
        {label(exec.command)} · {t("exec.via", { source: t(`exec.source.${exec.source}`) })}
      </p>
      {exec.error && exec.state !== "already" ? (
        <div className="pt-1 text-xs">
          <p className="text-ink-100">{t(`errors.${exec.error}.message`)}</p>
          <p className="text-ink-300">{t(`errors.${exec.error}.hint`)}</p>
          {exec.detail ? (
            <details className="mt-1 text-ink-400">
              <summary className="cursor-pointer select-none">{t("common.details")}</summary>
              <p className="mt-1 break-words font-mono text-[11px]" dir="ltr">
                {exec.code ? `${exec.code}: ` : ""}
                {exec.detail}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function providerKey(t: TargetSnapshot): MessageKey {
  return `experience.providers.${t.provider}`;
}

function TargetHeader({ target }: { target: TargetSnapshot }) {
  const { t } = useT();
  const conn = target.simulated ? null : target.connection;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-400">
          <Lightbulb className="h-3.5 w-3.5" aria-hidden />
          {t("experience.title")}
        </p>
        <h2 className="mt-1 truncate text-lg font-semibold text-ink-50" dir="auto" data-testid="target-name">
          {target.name}
        </h2>
        <p className="mt-0.5 text-xs text-ink-300">
          {t("experience.provider")}: <span className="text-ink-100">{t(providerKey(target))}</span>
          {conn ? (
            <>
              {" · "}
              <span className={conn === "online" ? "text-ok" : conn === "offline" ? "text-danger" : "text-warn"}>{t(`experience.connection.${conn}`)}</span>
            </>
          ) : null}
        </p>
      </div>
      {target.simulated ? (
        <Badge tone="sim" dot className="sim-stripes shrink-0 text-xs">
          <span data-testid="hw-badge">{t("badge.simulation")}</span>
        </Badge>
      ) : (
        <Badge tone="accent" dot className="shrink-0 text-xs">
          <span data-testid="hw-badge">{t("badge.real")}</span>
        </Badge>
      )}
    </div>
  );
}

function BrightnessControl({ target, disabled, run }: { target: TargetSnapshot; disabled: boolean; run: (c: ExperienceCommand) => void }) {
  const { t, pct, dir } = useT();
  const exec = useExperience((s) => s.exec);
  const confirmed = target.state;
  const shownValue = confirmed ? (confirmed.on ? (confirmed.brightness ?? 100) : 0) : (target.lastKnown?.brightness ?? 0);
  const inFlight = exec && (exec.state === "pending" || exec.state === "executing") ? exec.requested : undefined;
  const relativeDisabled = disabled || !confirmed;
  return (
    <div className="space-y-3 rounded-xl border border-ink-700 p-3" data-testid="brightness-control">
      <CommitSlider
        id="xp-brightness"
        label={t("experience.sliderLabel")}
        value={shownValue}
        disabled={disabled}
        dir={dir}
        onCommit={(v) => run({ kind: "set_brightness", value: v })}
        format={pct}
      />
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink-300">
          {inFlight && inFlight.brightness !== null ? (
            <span className="text-accent" data-testid="brightness-pending">
              {t("light.requested", { value: pct(inFlight.on ? inFlight.brightness : 0) })}
            </span>
          ) : confirmed ? (
            <span data-testid="brightness-confirmed">{t("light.confirmedLevel", { value: pct(shownValue) })}</span>
          ) : (
            <span className="text-warn">{t("light.unknown")}</span>
          )}
        </span>
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={relativeDisabled}
            onClick={() => run({ kind: "adjust_brightness", delta: -STEP })}
            aria-label={`${t("experience.dimmer")} (${pct(STEP)})`}
            data-testid="dim-down"
          >
            <Minus className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={relativeDisabled}
            onClick={() => run({ kind: "adjust_brightness", delta: STEP })}
            aria-label={`${t("experience.brighter")} (${pct(STEP)})`}
            data-testid="dim-up"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      {!confirmed && !disabled ? <p className="text-xs text-ink-400">{t("errors.stateUnknown.hint")}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("experience.presets")}>
        <span className="me-1 text-xs text-ink-400">{t("experience.presets")}</span>
        {PRESETS.map((p) => (
          <Button key={p} variant="outline" size="sm" disabled={disabled} onClick={() => run({ kind: "set_brightness", value: p })} data-testid={`preset-${p}`}>
            <span dir="ltr">{pct(p)}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function NoTarget() {
  const { t } = useT();
  const setTab = useUi((s) => s.setTab);
  const selectSim = useExperience((s) => s.selectSim);
  return (
    <Card className="p-5" data-testid="experience-empty">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-400">
        <Lightbulb className="h-3.5 w-3.5" aria-hidden />
        {t("experience.title")}
      </p>
      <h2 className="mt-2 text-lg font-semibold text-ink-50">{t("experience.noTarget")}</h2>
      <p className="mt-1 text-sm text-ink-300">{t("experience.noTargetBody")}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button variant="primary" onClick={() => setTab("connect")} data-testid="xp-connect">
          <Cable className="h-4 w-4" aria-hidden />
          {t("intro.connect")}
        </Button>
        <Button variant="outline" onClick={selectSim} data-testid="xp-explore">
          <FlaskConical className="h-4 w-4" aria-hidden />
          {t("intro.explore")}
        </Button>
      </div>
    </Card>
  );
}

export function ExperiencePanel() {
  const { t } = useT();
  const target = useTarget();
  const exec = useExperience((s) => s.exec);
  const busy = useExperience((s) => s.busy);
  const execute = useExperience((s) => s.execute);
  const setTab = useUi((s) => s.setTab);
  const reconnect = useHub((s) => s.connect);
  const hubStatus = useHub((s) => s.status);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!target) {
    return (
      <div className="space-y-4">
        <NoTarget />
        <AssistantChat />
      </div>
    );
  }

  const offline = !target.simulated && target.connection === "offline";
  const needsTest = target.kind === "hub" && !target.simulated && !target.controlEnabled;
  const disabled = busy || !target.controlAllowed || offline;
  const run = (c: ExperienceCommand) => void execute(c, "manual");
  const isOn = target.state?.on;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5" data-testid="experience-panel">
        <TargetHeader target={target} />
        <p className={cn("rounded-lg px-3 py-2 text-xs", target.simulated ? "sim-stripes bg-sim/5 text-sim" : "bg-accent/5 text-accent")}>
          {target.simulated ? t("experience.simNotice") : t("experience.realNotice")}
        </p>
        {needsTest ? (
          <Callout tone="warn" role="status">
            <span className="block">{t("experience.enableControl")}</span>
            <Button className="mt-2" variant="secondary" size="sm" onClick={() => setConfirmOpen(true)} data-testid="xp-first-test">
              {t("experience.enableControlAction")}
            </Button>
          </Callout>
        ) : null}
        {offline ? (
          <Callout tone="danger" role="alert">
            <span className="block">{t("errors.offline.message")}</span>
            <span className="block text-xs opacity-80">{t("errors.offline.hint")}</span>
          </Callout>
        ) : null}
        {!target.simulated && !target.hasFeedback ? <p className="text-xs text-warn">{t("light.noFeedback")}</p> : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant={isOn === true ? "on" : "secondary"}
            size="lg"
            disabled={disabled}
            onClick={() => run({ kind: "turn_on" })}
            aria-pressed={isOn === true}
            data-testid="xp-on"
          >
            <Power className="h-5 w-5" aria-hidden />
            {t("experience.turnOn")}
          </Button>
          <Button
            variant={isOn === false ? "off" : "secondary"}
            size="lg"
            disabled={disabled}
            onClick={() => run({ kind: "turn_off" })}
            aria-pressed={isOn === false}
            data-testid="xp-off"
          >
            <Ban className="h-5 w-5" aria-hidden />
            {t("experience.turnOff")}
          </Button>
        </div>

        {target.dimmable ? (
          <BrightnessControl target={target} disabled={disabled} run={run} />
        ) : (
          <p className="rounded-xl border border-dashed border-ink-600 p-3 text-xs text-ink-300" data-testid="not-dimmable">
            {t("experience.notDimmable")}
          </p>
        )}

        <ExecutionStatus exec={exec} />
        <p className="text-[11px] leading-relaxed text-ink-400">{t("experience.twinHint")}</p>

        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          <Button variant="ghost" size="sm" onClick={() => setTab("connect")} data-testid="xp-change">
            <Cable className="h-3.5 w-3.5" aria-hidden />
            {t("experience.changeDevice")}
          </Button>
          {target.kind === "hub" ? (
            <Button variant="ghost" size="sm" onClick={() => void reconnect()} disabled={hubStatus === "connecting"}>
              <RefreshCw className={cn("h-3.5 w-3.5", hubStatus === "connecting" && "animate-spin")} aria-hidden />
              {t("experience.reconnect")}
            </Button>
          ) : null}
        </div>
      </Card>
      {target.kind === "hub" ? <FirstTestDialog deviceId={target.id} deviceName={target.name} open={confirmOpen} onOpenChange={setConfirmOpen} /> : null}
      <AssistantChat />
    </div>
  );
}
