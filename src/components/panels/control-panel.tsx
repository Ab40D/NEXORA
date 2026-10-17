"use client";

import { Cable, FlaskConical, Hand, Info, Lightbulb, LightbulbOff, Mic, RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, KeyValue } from "@/components/ui/primitives";
import { disconnectActiveBackend } from "@/lib/connection/session";
import { useExperience } from "@/lib/experience/store";
import { useGestureStore } from "@/lib/gesture/gesture-store";
import { useT } from "@/lib/i18n";
import { canDispatch } from "@/lib/state/selectors";
import { useAppStore } from "@/lib/state/store";
import { useUi } from "@/lib/state/ui-store";
import { useVoiceStore } from "@/lib/voice/voice-controller";

/** "Classic" tab: the original single-light connection (simulation, SE7ENX Bridge, Home Assistant). */
export function ControlPanel() {
  const { t } = useT();
  const light = useAppStore((s) => s.light);
  const requestCommand = useAppStore((s) => s.requestCommand);
  const refreshState = useAppStore((s) => s.refreshState);
  const switchToSimulation = useAppStore((s) => s.switchToSimulation);
  const openWizard = useUi((s) => s.openWizard);
  const setTab = useUi((s) => s.setTab);
  const camera = useGestureStore((s) => s.cameraStatus);
  const gesturesEnabled = useGestureStore((s) => s.gesturesEnabled);
  const voiceEnabled = useVoiceStore((s) => s.enabled);
  const experienceActive = useExperience((s) => s.target !== "none");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const isSim = light.mode === "simulation";
  const pending = light.lastCommand?.phase === "pending";
  const enabled = canDispatch(light) && !pending;
  const target = light.target;

  const read = async () => {
    setReading(true);
    setReadError(null);
    try {
      await refreshState();
    } catch (err) {
      setReadError(err instanceof Error ? err.message : t("classic.readFailedGeneric"));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="space-y-4">
      {experienceActive ? (
        <Callout tone="neutral" icon={<Info className="h-4 w-4" />}>
          {t("classic.note")}
        </Callout>
      ) : null}
      <Card>
        <CardHeader
          icon={isSim ? <FlaskConical className="h-4 w-4" /> : <Cable className="h-4 w-4" />}
          title={isSim ? t("classic.simTitle") : light.mode === "bridge" ? t("classic.bridgeTitle") : t("classic.haTitle")}
          subtitle={isSim ? t("classic.simSub") : (light.link.message ?? t("classic.connectedBackend"))}
        />
        <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          {!isSim && target ? (
            <dl className="grid grid-cols-2 gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 sm:grid-cols-4">
              <KeyValue label={t("classic.ga")} value={target.displayAddress} mono />
              <KeyValue label={t("classic.dpt")} value={target.dpt} mono />
              <KeyValue label={t("classic.statusGa")} value={target.displayStatusAddress ?? "—"} mono />
              <KeyValue label={t("classic.feedback")} value={light.feedbackAvailable ? t("classic.available") : t("classic.none")} />
            </dl>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant={isSim ? "primary" : "outline"} onClick={openWizard}>
              <Cable className="h-4 w-4" aria-hidden />
              {isSim ? t("classic.connectReal") : t("classic.settings")}
            </Button>
            {!isSim ? (
              <>
                <Button variant="secondary" onClick={read} disabled={reading || light.link.status !== "connected"}>
                  <RefreshCw className={reading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
                  {t("classic.read")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await disconnectActiveBackend();
                    await switchToSimulation();
                  }}
                >
                  <Unplug className="h-4 w-4" aria-hidden />
                  {t("classic.disconnect")}
                </Button>
              </>
            ) : null}
          </div>
          {readError ? (
            <Callout tone="danger" role="alert" title={t("classic.readFailed")}>
              {readError}
            </Callout>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Lightbulb className="h-4 w-4" />} title={t("classic.manual")} subtitle={isSim ? t("classic.manualSimSub") : t("classic.manualRealSub")} />
        <div className="grid grid-cols-2 gap-3 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <Button variant="on" size="lg" disabled={!enabled} onClick={() => void requestCommand("on", "manual")} data-testid="manual-on">
            <Lightbulb className="h-5 w-5" aria-hidden />
            {t("classic.on")}
          </Button>
          <Button variant="off" size="lg" disabled={!enabled} onClick={() => void requestCommand("off", "manual")} data-testid="manual-off">
            <LightbulbOff className="h-5 w-5" aria-hidden />
            {t("classic.off")}
          </Button>
          {!enabled && !isSim ? <p className="col-span-2 text-xs text-ink-300">{pending ? t("classic.waiting") : t("classic.disabled")}</p> : null}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Hand className="h-4 w-4" />} title={t("classic.handsFree")} subtitle={t("classic.handsFreeSub")} />
        <div className="grid gap-2 px-4 pb-4 pt-3 sm:grid-cols-2 sm:px-5 sm:pb-5">
          <button
            type="button"
            onClick={() => setTab("gesture")}
            className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-start transition-colors hover:border-accent/50"
          >
            <Hand className="h-5 w-5 text-accent" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink-50">{t("classic.gestures")}</span>
              <span className="block truncate text-xs text-ink-300">
                {camera === "running" ? (gesturesEnabled ? t("classic.camActive") : t("classic.camGesturesOff")) : camera === "error" ? t("classic.camError") : t("classic.camOff")}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab("voice")}
            className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-start transition-colors hover:border-accent/50"
          >
            <Mic className="h-5 w-5 text-accent" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink-50">{t("classic.voice")}</span>
              <span className="block truncate text-xs text-ink-300">{voiceEnabled ? t("classic.voiceOn") : t("classic.voiceOff")}</span>
            </span>
          </button>
          {light.dispatchPaused ? (
            <Callout tone="danger" className="sm:col-span-2" title={t("classic.stopped")}>
              {t("classic.stoppedBody")}
            </Callout>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
