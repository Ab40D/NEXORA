"use client";

import { ArrowDown, ArrowUp, Lightbulb, Minus, Plus, Power, ShieldAlert, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CommitSlider } from "@/components/ui/commit-slider";
import { Badge, Callout, Checkbox } from "@/components/ui/primitives";
import type { HubCommand, HubDevice } from "@/lib/hub/contract";
import { errorCategory } from "@/lib/experience/errors";
import { describeReported, describeRequested, relativeTime } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/hub-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const CONNECTION_TONE = { online: "ok", offline: "danger", unauthorized: "danger", unavailable: "warn", error: "danger", unknown: "neutral" } as const;

export function DeviceCard({ device, now }: { device: HubDevice; now: number }) {
  const { t, locale, pct, dir } = useT();
  const command = useHub((s) => s.command);
  const patch = useHub((s) => s.patch);
  const remove = useHub((s) => s.remove);
  const busy = useHub((s) => !!s.busy[device.id]);
  const result = useHub((s) => s.results[device.id]);
  const safety = useHub((s) => s.safety);
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const has = (c: HubCommand) => device.commands.includes(c);
  const rep = device.state.reported;
  const reported = describeReported(device.type, rep, locale);
  const requested = describeRequested(device.state.requested, locale);
  const real = !device.simulated;
  const controlsDisabled = busy || !device.controlAllowed;
  const send = (c: HubCommand, params?: Record<string, unknown>) => void command(device.id, c, params);
  const readOnly = device.commands.length === 0;

  async function guarded(fn: () => Promise<void>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("hub.card.actionFailed"));
    }
  }

  return (
    <article className="rounded-2xl border border-ink-600/70 bg-ink-850/70 p-4" aria-labelledby={`dev-${device.id}-name`} data-testid={`device-${device.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`dev-${device.id}-name`} className="truncate text-sm font-semibold text-ink-50" dir="auto">
            {device.name}
          </h3>
          <p className="truncate text-xs text-ink-400">
            {device.model ?? t(`hub.type.${device.type}`)}
            {device.metadata.room ? ` · ${device.metadata.room}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={device.simulated ? "sim" : "accent"}>{t(`hub.integration.${device.integration}`)}</Badge>
          <Badge tone={CONNECTION_TONE[device.connection.status]} dot>
            {t(`hub.connection.${device.connection.status}`)}
          </Badge>
        </div>
      </header>

      <div className="mt-3 space-y-1 text-sm" aria-live="polite">
        <p className="text-ink-100">
          <span className="text-ink-400">{t("hub.card.reported")} </span>
          {reported.length ? reported.join(" · ") : <span className="text-ink-300">{t("hub.card.noState")}</span>}
        </p>
        <p className="text-xs text-ink-400">
          {device.state.reportedAt ? `${relativeTime(device.state.reportedAt, now, locale)} · ${device.state.source ?? t("hub.card.sourceDevice")}` : t("hub.card.waiting")}
        </p>
        {device.state.pending && requested ? (
          <p className="text-xs text-warn" data-testid={`device-${device.id}-pending`}>
            {t("hub.card.requested", { value: requested, time: relativeTime(device.state.requestedAt, now, locale) })}
          </p>
        ) : null}
        {device.connection.lastError && device.connection.status !== "online" ? <p className="text-xs text-danger">{device.connection.lastError.message}</p> : null}
      </div>

      {readOnly ? (
        <p className="mt-3 text-xs text-ink-400">{t("hub.card.readOnly")}</p>
      ) : real && !device.controlEnabled ? (
        <div className="mt-3 space-y-2">
          {!confirming ? (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              {t("hub.card.enable")}
            </Button>
          ) : (
            <Callout tone="danger" title={t("hub.card.realTitle")}>
              <p className="mb-2 text-xs">{t("hub.card.realBody")}</p>
              <Checkbox id={`ack-${device.id}`} checked={ack} onCheckedChange={setAck}>
                {t("hub.card.realAck")}
              </Checkbox>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" size="sm" disabled={!ack} onClick={() => guarded(() => patch(device.id, { controlEnabled: true, acknowledgeRealControl: true }))}>
                  {t("hub.card.enableConfirm")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  {t("hub.card.cancel")}
                </Button>
              </div>
            </Callout>
          )}
          <p className="text-xs text-ink-400">{t("hub.card.statusOnly")}</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {safety.active && real ? <p className="text-xs text-danger">{t("hub.card.hubStopped")}</p> : null}
          {has("turn_on") || has("open") ? (
            <div className="flex flex-wrap gap-2">
              {has("turn_on") ? (
                <Button variant="on" size="sm" disabled={controlsDisabled} onClick={() => send("turn_on")}>
                  <Power className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.on")}
                </Button>
              ) : null}
              {has("turn_off") ? (
                <Button variant="off" size="sm" disabled={controlsDisabled} onClick={() => send("turn_off")}>
                  {t("hub.card.off")}
                </Button>
              ) : null}
              {has("open") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("open")}>
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.open")}
                </Button>
              ) : null}
              {has("stop") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("stop")}>
                  <Square className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.stop")}
                </Button>
              ) : null}
              {has("close") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("close")}>
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.close")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {has("set_brightness") ? (
            <CommitSlider
              id={`b-${device.id}`}
              label={t("hub.card.brightness")}
              value={typeof rep.brightness === "number" ? rep.brightness : 0}
              disabled={controlsDisabled}
              dir={dir}
              onCommit={(v) => send("set_brightness", { brightness: v })}
              format={pct}
            />
          ) : null}
          {has("dim") ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-300">{t("hub.card.relativeDim")}</span>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "down" })} aria-label={t("hub.card.dimDown")}>
                <Minus className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "stop" })}>
                {t("hub.card.stop")}
              </Button>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "up" })} aria-label={t("hub.card.dimUp")}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
          {has("set_position") ? (
            <CommitSlider
              id={`p-${device.id}`}
              label={t("hub.card.position")}
              value={typeof rep.position === "number" ? rep.position : 0}
              disabled={controlsDisabled}
              dir={dir}
              onCommit={(v) => send("set_position", { position: v })}
              format={pct}
            />
          ) : null}
        </div>
      )}

      {result ? (
        <div className={cn("mt-3 text-xs", result.ok ? (result.outcome === "accepted" ? "text-warn" : "text-ok") : "text-danger")} role="status">
          {result.ok ? (
            <p>{result.outcome ? t(`hub.outcome.${result.outcome}`) : result.text}</p>
          ) : (
            <>
              <p>{t(`errors.${errorCategory(result.code, result.status)}.message`)}</p>
              <p className="text-ink-300">{t(`errors.${errorCategory(result.code, result.status)}.hint`)}</p>
            </>
          )}
          {!result.ok || locale === "en" ? (
            <details className="mt-1 text-ink-400">
              <summary className="cursor-pointer select-none">{t("common.details")}</summary>
              <p className="mt-1 break-words font-mono text-[11px]" dir="ltr">
                {result.code ? `${result.code}: ` : ""}
                {result.text}
                {result.hint ? ` — ${result.hint}` : ""}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
      {actionError ? <p className="mt-2 text-xs text-danger">{actionError}</p> : null}

      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700/70 pt-3">
        {real && device.controlEnabled ? (
          <Button variant="ghost" size="sm" onClick={() => guarded(() => patch(device.id, { controlEnabled: false }))}>
            <Lightbulb className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.disable")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (window.confirm(t("hub.card.removeConfirm", { name: device.name }))) void guarded(() => remove(device.id));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t("hub.card.remove")}
        </Button>
        {device.credentialsStored ? <span className="text-[11px] text-ink-400">{t("hub.card.credentials")}</span> : null}
      </footer>
    </article>
  );
}
