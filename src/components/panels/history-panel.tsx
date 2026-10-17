"use client";

import { Ban, CircleAlert, CircleCheck, Info, Radio, ShieldAlert, Trash2, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { EXEC_VIEW } from "@/components/experience/exec-view";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/primitives";
import { useExperience, type ExperienceCommand } from "@/lib/experience/store";
import { useT } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import type { HistoryEntry } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const ICON: Record<HistoryEntry["kind"], ReactNode> = {
  command: <Zap className="h-3.5 w-3.5" />,
  blocked: <Ban className="h-3.5 w-3.5" />,
  state: <CircleCheck className="h-3.5 w-3.5" />,
  link: <Radio className="h-3.5 w-3.5" />,
  mode: <Info className="h-3.5 w-3.5" />,
  safety: <ShieldAlert className="h-3.5 w-3.5" />,
  info: <CircleAlert className="h-3.5 w-3.5" />,
};

const TONE: Record<HistoryEntry["tone"], string> = {
  neutral: "text-ink-300 border-ink-600",
  info: "text-accent border-accent/40",
  success: "text-ok border-ok/40",
  warning: "text-warn border-warn/40",
  danger: "text-danger border-danger/50",
};

const EXEC_TONE = { accent: "text-accent border-accent/40", ok: "text-ok border-ok/40", warn: "text-warn border-warn/40", danger: "text-danger border-danger/50", sim: "text-sim border-sim/50", neutral: "text-ink-300 border-ink-600" } as const;

/** Localized log of the Smart Light Experience pipeline (structured records, so fully translatable). */
function ExperienceHistory() {
  const { t, pct, clock } = useT();
  const history = useExperience((s) => s.history);
  if (!history.length) return null;
  const label = (c: ExperienceCommand) =>
    c.kind === "set_brightness"
      ? t("cmd.set_brightness", { value: pct(c.value) })
      : c.kind === "adjust_brightness"
        ? c.delta >= 0
          ? t("cmd.brighter", { value: pct(c.delta) })
          : t("cmd.dimmer", { value: pct(-c.delta) })
        : t(`cmd.${c.kind}`);
  return (
    <section className="px-2 pb-2 pt-2 sm:px-3">
      <h3 className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">{t("history.experience")}</h3>
      <ol className="space-y-1" data-testid="experience-history">
        {history.map((h) => {
          const view = EXEC_VIEW[h.state];
          const Icon = view.icon;
          return (
            <li key={h.id} className="flex gap-3 rounded-xl px-3 py-2 hover:bg-ink-800/60">
              <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border", EXEC_TONE[view.tone])} aria-hidden>
                <Icon className={cn("h-3.5 w-3.5", view.spin && "animate-spin")} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium text-ink-50">{label(h.command)}</p>
                  <time className="shrink-0 font-mono text-[11px] text-ink-400" dateTime={new Date(h.at).toISOString()}>
                    {clock(h.at)}
                  </time>
                </div>
                <p className="mt-0.5 text-xs text-ink-300">
                  {t(view.key)} · {t("exec.via", { source: t(`exec.source.${h.source}`) })}
                </p>
                {h.error && h.state !== "already" ? <p className="text-xs text-ink-400">{t(`errors.${h.error}.message`)}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function HistoryPanel() {
  const { t, clock } = useT();
  const history = useAppStore((s) => s.light.history);
  const dispatch = useAppStore((s) => s.dispatch);
  const xpCount = useExperience((s) => s.history.length);

  return (
    <Card>
      <CardHeader
        title={t("history.title")}
        subtitle={t("history.subtitle")}
        actions={
          history.length || xpCount ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dispatch({ type: "HISTORY_CLEARED" });
                useExperience.setState({ history: [] });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              {t("history.clear")}
            </Button>
          ) : null
        }
      />
      <ExperienceHistory />
      <div className="px-2 pb-3 pt-2 sm:px-3">
        {xpCount && history.length ? <h3 className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">{t("history.classic")}</h3> : null}
        {history.length === 0 ? (
          xpCount ? null : <p className="px-3 py-8 text-center text-sm text-ink-400">{t("history.empty")}</p>
        ) : (
          <ol className="scrollbar-thin max-h-[60vh] space-y-1 overflow-y-auto pe-1" aria-label={t("history.aria")} data-testid="history">
            {history.map((h) => (
              <li key={h.id} className="flex gap-3 rounded-xl px-3 py-2 hover:bg-ink-800/60">
                <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border", TONE[h.tone])} aria-hidden>
                  {ICON[h.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink-50">{h.title}</p>
                    <time className="shrink-0 font-mono text-[11px] text-ink-400" dateTime={new Date(h.at).toISOString()}>
                      {clock(h.at)}
                    </time>
                  </div>
                  {h.detail ? <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-300">{h.detail}</p> : null}
                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-400">{t(`history.mode.${h.mode}`)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
