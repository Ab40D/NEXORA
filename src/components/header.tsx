"use client";

import { Cable, Clapperboard, OctagonX, Play } from "lucide-react";
import { AccountMenu } from "@/components/auth/account-menu";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { useTarget } from "@/lib/experience/store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import { useUi } from "@/lib/state/ui-store";
import type { LinkStatus, Mode } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const MODE_BADGE: Record<Mode, { key: MessageKey; tone: "sim" | "accent" }> = {
  simulation: { key: "header.mode.simulation", tone: "sim" },
  bridge: { key: "header.mode.bridge", tone: "accent" },
  homeassistant: { key: "header.mode.homeassistant", tone: "accent" },
};

const LINK_TEXT: Record<LinkStatus, { key: MessageKey; dot: string }> = {
  idle: { key: "header.link.idle", dot: "bg-sim" },
  connecting: { key: "header.link.connecting", dot: "bg-accent animate-pulse" },
  connected: { key: "header.link.connected", dot: "bg-ok" },
  reconnecting: { key: "header.link.reconnecting", dot: "bg-warn animate-pulse" },
  disconnected: { key: "header.link.disconnected", dot: "bg-ink-400" },
  error: { key: "header.link.error", dot: "bg-danger" },
};

export function Header() {
  const mode = useAppStore((s) => s.light.mode);
  const link = useAppStore((s) => s.light.link.status);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const setPaused = useAppStore((s) => s.setPaused);
  const setTab = useUi((s) => s.setTab);
  const openIntro = useUi((s) => s.openIntro);
  const target = useTarget();
  const { t } = useT();
  const badge = MODE_BADGE[mode];
  const l = LINK_TEXT[link];
  const targetSim = target?.simulated ?? false;

  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/75 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark />
          <div className="min-w-0 leading-tight">
            <span dir="ltr">
              <Wordmark className="text-sm sm:text-base" />
            </span>
            <p className="hidden text-[10px] uppercase tracking-[0.24em] text-ink-400 sm:block">{t("header.tagline")}</p>
          </div>
        </div>

        <div className="ms-auto flex items-center gap-2 sm:gap-3">
          {/* always-visible, honest status: the selected light (experience) or the legacy mode */}
          <div className="hidden items-center gap-2 md:flex" aria-live="polite">
            {target ? (
              <Badge tone={targetSim ? "sim" : "accent"} className={cn("max-w-[16rem]", targetSim && "sim-stripes")} dot>
                <span data-testid="target-badge" className="truncate">
                  {t(targetSim ? "badge.simulation" : "badge.real")} · <bdi>{target.name}</bdi>
                </span>
              </Badge>
            ) : (
              <>
                <Badge tone={badge.tone} className={cn(mode === "simulation" && "sim-stripes")} dot>
                  <span data-testid="mode-badge">{t(badge.key)}</span>
                </Badge>
                {mode !== "simulation" ? (
                  <span className="flex items-center gap-1.5 text-xs text-ink-200">
                    <span className={cn("h-2 w-2 rounded-full", l.dot)} aria-hidden />
                    {t(l.key)}
                  </span>
                ) : null}
              </>
            )}
          </div>
          <Badge tone={target ? (targetSim ? "sim" : "accent") : badge.tone} className="md:hidden" dot>
            {t((target ? targetSim : mode === "simulation") ? "header.short.sim" : "header.short.live")}
          </Badge>

          <LanguageSwitcher />
          <AccountMenu />
          <Button
            variant="ghost"
            size="icon"
            onClick={openIntro}
            aria-label={t("header.replayIntro")}
            title={t("header.replayIntro")}
            className="hidden h-8 w-8 sm:inline-flex"
            data-testid="replay-intro"
          >
            <Clapperboard className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTab("connect")} className="hidden sm:inline-flex" data-testid="header-connect">
            <Cable className="h-3.5 w-3.5" aria-hidden />
            {t("header.connect")}
          </Button>

          <Button
            variant={paused ? "primary" : "danger"}
            size="sm"
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            title={t("header.stopTitle")}
            data-testid="emergency-stop"
          >
            {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <OctagonX className="h-3.5 w-3.5" aria-hidden />}
            <span className="hidden sm:inline">{paused ? t("header.resumeHandsFree") : t("header.stopHandsFree")}</span>
            <span className="sm:hidden">{paused ? t("header.resume") : t("header.stop")}</span>
          </Button>
        </div>
      </div>
      {paused ? (
        <div role="status" className="border-t border-danger/40 bg-danger/10 px-4 py-1.5 text-center text-xs font-medium text-danger">
          {t("header.stoppedBanner")}
        </div>
      ) : null}
    </header>
  );
}
