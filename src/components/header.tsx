"use client";

import { Cable, OctagonX, Play } from "lucide-react";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { useAppStore } from "@/lib/state/store";
import { useUi } from "@/lib/state/ui-store";
import type { LinkStatus, Mode } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const MODE_BADGE: Record<Mode, { text: string; tone: "sim" | "accent" }> = {
  simulation: { text: "Simulation", tone: "sim" },
  bridge: { text: "Live KNX · Bridge", tone: "accent" },
  homeassistant: { text: "Live KNX · Home Assistant", tone: "accent" },
};

const LINK_TEXT: Record<LinkStatus, { text: string; dot: string }> = {
  idle: { text: "No hardware", dot: "bg-sim" },
  connecting: { text: "Connecting", dot: "bg-accent animate-pulse" },
  connected: { text: "Connected", dot: "bg-ok" },
  reconnecting: { text: "Reconnecting", dot: "bg-warn animate-pulse" },
  disconnected: { text: "Disconnected", dot: "bg-ink-400" },
  error: { text: "Error", dot: "bg-danger" },
};

export function Header() {
  const mode = useAppStore((s) => s.light.mode);
  const link = useAppStore((s) => s.light.link.status);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const setPaused = useAppStore((s) => s.setPaused);
  const openWizard = useUi((s) => s.openWizard);
  const badge = MODE_BADGE[mode];
  const l = LINK_TEXT[link];

  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/75 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark />
          <div className="min-w-0 leading-tight">
            <Wordmark className="text-sm sm:text-base" />
            <p className="hidden text-[10px] uppercase tracking-[0.24em] text-ink-400 sm:block">Smart Light Experience</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-2 md:flex" aria-live="polite">
            <Badge tone={badge.tone} className={cn(mode === "simulation" && "sim-stripes")} dot>
              <span data-testid="mode-badge">{badge.text}</span>
            </Badge>
            {mode !== "simulation" ? (
              <span className="flex items-center gap-1.5 text-xs text-ink-200">
                <span className={cn("h-2 w-2 rounded-full", l.dot)} aria-hidden />
                {l.text}
              </span>
            ) : null}
          </div>
          <Badge tone={badge.tone} className="md:hidden" dot>
            {mode === "simulation" ? "SIM" : "LIVE"}
          </Badge>

          <Button variant="outline" size="sm" onClick={openWizard} className="hidden sm:inline-flex">
            <Cable className="h-3.5 w-3.5" aria-hidden />
            {mode === "simulation" ? "Connect KNX" : "Connection"}
          </Button>

          <Button
            variant={paused ? "primary" : "danger"}
            size="sm"
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            title="Emergency stop: immediately stops gesture and voice commands (Esc)"
            data-testid="emergency-stop"
          >
            {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <OctagonX className="h-3.5 w-3.5" aria-hidden />}
            <span className="hidden sm:inline">{paused ? "Resume hands-free" : "Stop hands-free"}</span>
            <span className="sm:hidden">{paused ? "Resume" : "Stop"}</span>
          </Button>
        </div>
      </div>
      {paused ? (
        <div role="status" className="border-t border-danger/40 bg-danger/10 px-4 py-1.5 text-center text-xs font-medium text-danger">
          Emergency stop active — gesture and voice commands are not sent. Manual controls still work.
        </div>
      ) : null}
    </header>
  );
}
