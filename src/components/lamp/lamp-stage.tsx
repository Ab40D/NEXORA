"use client";

import { Power } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/primitives";
import { detectLowPower, detectWebGL, useIsClient, useNow, useReducedMotion } from "@/lib/device";
import { experienceLampView } from "@/lib/experience/lamp-view";
import { useExperience, useTarget } from "@/lib/experience/store";
import { useT, type MessageKey } from "@/lib/i18n";
import { canDispatch, selectLampView, type LampView } from "@/lib/state/selectors";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";
import { LampFallback } from "./lamp-fallback";

const LampScene = dynamic(() => import("./lamp-scene"), { ssr: false, loading: () => null });

const CERTAINTY_BADGE: Record<LampView["certainty"], { key: MessageKey; tone: "sim" | "ok" | "warn" | "neutral" | "danger" | "accent" }> = {
  simulated: { key: "lamp.certainty.simulated", tone: "sim" },
  confirmed: { key: "lamp.certainty.confirmed", tone: "ok" },
  observed: { key: "lamp.certainty.observed", tone: "warn" },
  assumed: { key: "lamp.certainty.assumed", tone: "warn" },
  unknown: { key: "lamp.certainty.unknown", tone: "neutral" },
  stale: { key: "lamp.certainty.stale", tone: "warn" },
};

export function LampStage() {
  const light = useAppStore((s) => s.light);
  const toggleLegacy = useAppStore((s) => s.toggle);
  const now = useNow(1000);
  const { t, locale } = useT();
  // The selected experience light drives the Digital Twin; without one the legacy view is unchanged.
  const target = useTarget();
  const exec = useExperience((s) => s.exec);
  const xpBusy = useExperience((s) => s.busy);
  const legacy = selectLampView(light, now);
  const view: LampView = target
    ? experienceLampView(target, exec, locale)
    : light.mode === "simulation"
      ? {
          ...legacy,
          label: `${t("badge.simulation")} · ${t(light.simulated === "on" ? "lamp.legacyOn" : "lamp.legacyOff")}`,
          detail: t("lamp.legacySimDetail"),
        }
      : legacy;
  const toggle = (source: "lamp") => (target ? useExperience.getState().execute({ kind: "toggle" }, source) : toggleLegacy(source));
  const isClient = useIsClient();
  const reducedMotion = useReducedMotion();
  const [contextLost, setContextLost] = useState(false);
  const webgl = useMemo(() => (isClient ? detectWebGL() : false), [isClient]);
  const lowPower = useMemo(() => (isClient ? detectLowPower() : true), [isClient]);
  const use3D = isClient && webgl && !contextLost;

  const pending = target ? xpBusy : light.lastCommand?.phase === "pending";
  const interactive = target ? target.controlAllowed && !xpBusy && (target.simulated || target.connection !== "offline") : canDispatch(light) && !pending;
  const isSim = target ? target.simulated : light.mode === "simulation";

  // Screen-reader announcement of state changes
  const [announcement, setAnnouncement] = useState("");
  const lastLabel = useRef("");
  useEffect(() => {
    const text = `${view.label}. ${view.detail}`;
    if (text !== lastLabel.current) {
      lastLabel.current = text;
      setAnnouncement(text);
    }
  }, [view.label, view.detail]);

  const badge = CERTAINTY_BADGE[view.certainty];
  const toneText =
    view.tone === "error" ? "text-danger" : view.tone === "warn" ? "text-warn" : view.tone === "sim" ? "text-sim" : view.lit ? "text-warm" : "text-ink-50";

  return (
    <section
      aria-label={t("lamp.section")}
      className="relative isolate h-[min(64vh,560px)] min-h-[360px] overflow-hidden rounded-3xl border border-ink-700/80 bg-ink-900 shadow-[var(--shadow-panel)] lg:h-[calc(100dvh-13.5rem)] lg:min-h-[520px]"
    >
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        style={{
          opacity: view.lit ? view.intensity : 0,
          background: "radial-gradient(55% 45% at 50% 50%, rgba(255,200,140,0.12), transparent 70%)",
        }}
      />
      {isSim ? <div aria-hidden className="sim-stripes pointer-events-none absolute inset-x-0 top-0 h-1.5" /> : null}

      <div className="absolute inset-0">
        {use3D ? (
          <LampScene
            view={view}
            lowPower={lowPower}
            reducedMotion={reducedMotion}
            interactive={interactive}
            onToggle={() => void toggle("lamp")}
            onContextLost={() => setContextLost(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 pb-20">
            <LampFallback view={view} className="max-h-full max-w-[420px]" />
          </div>
        )}
      </div>

      {/* state overlay */}
      <div className="pointer-events-none absolute left-0 top-0 z-10 max-w-[78%] p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone} dot>
            {t(badge.key)}
          </Badge>
          {isClient && !webgl ? <Badge tone="neutral">{t("lamp.fallback2d")}</Badge> : null}
          {contextLost ? <Badge tone="warn">{t("lamp.paused3d")}</Badge> : null}
        </div>
        <p data-testid="lamp-label" className={cn("mt-3 font-mono text-xl font-semibold uppercase tracking-[0.12em] sm:text-3xl", toneText)}>
          {view.label}
        </p>
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-ink-300 sm:text-sm">{view.detail}</p>
        {view.pending ? (
          <p className="mt-2 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            {t("lamp.requested", { value: t(view.pending === "on" ? "light.on" : "light.off") })}
          </p>
        ) : null}
      </div>

      {isSim ? (
        <div className="pointer-events-none absolute bottom-0 left-0 z-10 hidden p-6 md:block">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.3em] text-sim/70">{t("lamp.simFooter")}</p>
        </div>
      ) : null}

      {/* keyboard / touch accessible toggle */}
      <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
        <button
          type="button"
          onClick={() => void toggle("lamp")}
          disabled={!interactive}
          aria-label={t("lamp.toggleAria", { kind: t(isSim ? "lamp.kindSim" : "lamp.kindReal"), state: view.label })}
          className={cn(
            "group flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] backdrop-blur transition-all disabled:opacity-40",
            view.lit ? "border-warm/50 bg-warm/15 text-warm" : "border-ink-500 bg-ink-900/70 text-ink-100 hover:border-accent/60",
          )}
        >
          <Power className="h-4 w-4" aria-hidden />
          {pending ? t("lamp.sending") : isSim ? t("lamp.tapToggle") : t("lamp.toggle")}
        </button>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
