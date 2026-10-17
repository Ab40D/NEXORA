"use client";
/**
 * Cinematic welcome (first visit only, "Replay intro" any time):
 *   dark stage with light reflections → original SE7ENX logo → Digital Twin room reveal →
 *   the light turns on → welcome + "Connect Your Real Light" / "Explore Simulation".
 * ~3.4 s, skippable at any moment, static when the user prefers reduced motion.
 *
 * The spoken welcome uses the Web Speech API. Browsers usually block speech without a user
 * gesture: then a "Play welcome" button is shown. The UI only says "Speaking…" once the browser
 * actually started speaking.
 */
import { Dialog } from "radix-ui";
import { Cable, FlaskConical, Play, RotateCcw, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { speak, stopSpeaking } from "@/lib/assistant/speech";
import { useReducedMotion } from "@/lib/device";
import { useExperience } from "@/lib/experience/store";
import { useT } from "@/lib/i18n";
import { useUi } from "@/lib/state/ui-store";
import { cn } from "@/lib/utils";
import { TwinRoom } from "./twin-room";

type Phase = 0 | 1 | 2 | 3 | 4;
type VoiceState = "idle" | "speaking" | "done" | "blocked" | "unsupported" | "no-voice";

const TIMELINE: [Phase, number][] = [
  [1, 250],
  [2, 1250],
  [3, 2300],
  [4, 3400],
];

export function WelcomeIntro() {
  const open = useUi((s) => s.introOpen);
  if (!open) return null;
  return <IntroOverlay />;
}

function IntroOverlay() {
  const { t, locale, dir } = useT();
  const reduced = useReducedMotion();
  const closeIntro = useUi((s) => s.closeIntro);
  const setTab = useUi((s) => s.setTab);
  const selectSim = useExperience((s) => s.selectSim);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<Phase>(0);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const shown: Phase = reduced ? 4 : phase;

  // animation timeline (restarted by "Replay")
  useEffect(() => {
    if (reduced) return;
    const timers = TIMELINE.map(([p, ms]) => setTimeout(() => setPhase(p), ms));
    return () => timers.forEach(clearTimeout);
  }, [reduced, run]);

  const playWelcome = useCallback(() => {
    void speak(t("intro.spoken"), locale, {
      onStart: () => setVoice("speaking"),
      onEnd: () => setVoice("done"),
    }).then(({ outcome }) => {
      if (outcome === "blocked") setVoice("blocked");
      else if (outcome === "unsupported") setVoice("unsupported");
      else if (outcome === "no-voice") setVoice("no-voice");
    });
  }, [t, locale]);

  // try to speak once when the intro opens; browsers may block it until the user interacts
  useEffect(() => {
    const timer = setTimeout(playWelcome, reduced ? 0 : 400);
    return () => {
      clearTimeout(timer);
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening / replay
  }, [run]);

  const finish = (next?: "connect" | "simulation") => {
    stopSpeaking();
    closeIntro();
    if (next === "simulation") {
      selectSim();
      setTab("experience");
    } else if (next === "connect") {
      setTab("connect");
    }
  };

  const restart = () => {
    stopSpeaking();
    setVoice("idle");
    setPhase(0);
    setRun((r) => r + 1);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => (o ? undefined : finish())}>
      <Dialog.Portal>
        <Dialog.Content
          dir={dir}
          data-testid="welcome-intro"
          data-phase={shown}
          aria-describedby="intro-support"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            document.getElementById("intro-skip")?.focus();
          }}
          className="fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-ink-950 focus:outline-none"
        >
          {/* dark premium stage + light reflections */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_30%,rgb(79_140_255/0.10),transparent_65%),radial-gradient(700px_420px_at_50%_80%,rgb(255_207_153/0.06),transparent_70%)]"
          />
          <div aria-hidden className="intro-sheen pointer-events-none absolute inset-0" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-1000"
            style={{ opacity: shown >= 3 ? 1 : 0, background: "radial-gradient(520px 380px at 50% 45%, rgb(255 207 153 / 0.13), transparent 70%)" }}
          />

          <div className="relative z-10 flex items-center justify-end gap-2 p-3 sm:p-5">
            <Button id="intro-skip" variant="ghost" size="sm" onClick={() => finish()} data-testid="intro-skip">
              <X className="h-3.5 w-3.5" aria-hidden />
              {t("intro.skip")}
            </Button>
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-5 pb-10 text-center">
            {/* original logo, uniform scale only — never distorted, recoloured or cropped */}
            <div
              className={cn(
                "flex flex-col items-center gap-3 transition-all duration-700",
                shown >= 1 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
              )}
            >
              <LogoMark className="h-16 w-16 sm:h-20 sm:w-20" />
              <span dir="ltr">
                <Wordmark className="text-2xl sm:text-3xl" />
              </span>
            </div>

            <div className="w-full max-w-xl">
              <TwinRoom lit={shown >= 3} revealed={shown >= 2} label={t("intro.roomLabel")} className="drop-shadow-[0_30px_60px_rgba(0,0,0,0.6)]" />
            </div>

            <div
              className={cn("space-y-3 transition-all duration-700", shown >= 4 ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0")}
            >
              <Dialog.Title className="text-balance text-2xl font-semibold text-ink-50 sm:text-3xl">{t("intro.title")}</Dialog.Title>
              <p id="intro-support" className="mx-auto max-w-xl text-balance text-sm leading-relaxed text-ink-200 sm:text-base">
                {t("intro.support")}
              </p>
              <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
                <Button variant="primary" size="lg" onClick={() => finish("connect")} data-testid="intro-connect" tabIndex={shown >= 4 ? 0 : -1}>
                  <Cable className="h-5 w-5" aria-hidden />
                  {t("intro.connect")}
                </Button>
                <Button variant="outline" size="lg" onClick={() => finish("simulation")} data-testid="intro-explore" tabIndex={shown >= 4 ? 0 : -1}>
                  <FlaskConical className="h-5 w-5" aria-hidden />
                  {t("intro.explore")}
                </Button>
              </div>
            </div>

            <div
              className="flex min-h-9 flex-wrap items-center justify-center gap-2 text-xs text-ink-300"
              aria-live="polite"
              data-testid="intro-voice"
              data-voice={voice}
            >
              {voice === "speaking" ? (
                <span className="inline-flex items-center gap-1.5 text-accent">
                  <Volume2 className="h-3.5 w-3.5 animate-pulse" aria-hidden />
                  {t("intro.playing")}
                </span>
              ) : voice === "blocked" ? (
                <>
                  <span>{t("intro.blocked")}</span>
                  <Button variant="secondary" size="sm" onClick={playWelcome} data-testid="intro-play">
                    <Play className="h-3.5 w-3.5" aria-hidden />
                    {t("intro.play")}
                  </Button>
                </>
              ) : voice === "unsupported" ? (
                <span>{t("intro.noSpeech")}</span>
              ) : voice === "no-voice" ? (
                <span>{t("intro.noVoice")}</span>
              ) : voice === "done" ? (
                <Button variant="ghost" size="sm" onClick={playWelcome}>
                  <Volume2 className="h-3.5 w-3.5" aria-hidden />
                  {t("intro.play")}
                </Button>
              ) : null}
              {shown >= 4 && !reduced ? (
                <Button variant="ghost" size="sm" onClick={restart} data-testid="intro-replay">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  {t("intro.replay")}
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
