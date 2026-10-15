"use client";

import { Cable, FlaskConical, Hand, Lightbulb, LightbulbOff, Mic, RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, KeyValue } from "@/components/ui/primitives";
import { useGestureStore } from "@/lib/gesture/gesture-store";
import { canDispatch } from "@/lib/state/selectors";
import { useAppStore } from "@/lib/state/store";
import { useUi } from "@/lib/state/ui-store";
import { useVoiceStore } from "@/lib/voice/voice-controller";
import { disconnectActiveBackend } from "@/lib/connection/session";

export function ControlPanel() {
  const light = useAppStore((s) => s.light);
  const requestCommand = useAppStore((s) => s.requestCommand);
  const refreshState = useAppStore((s) => s.refreshState);
  const switchToSimulation = useAppStore((s) => s.switchToSimulation);
  const openWizard = useUi((s) => s.openWizard);
  const setTab = useUi((s) => s.setTab);
  const camera = useGestureStore((s) => s.cameraStatus);
  const gesturesEnabled = useGestureStore((s) => s.gesturesEnabled);
  const voiceEnabled = useVoiceStore((s) => s.enabled);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const isSim = light.mode === "simulation";
  const pending = light.lastCommand?.phase === "pending";
  const enabled = canDispatch(light) && !pending;
  const t = light.target;

  const read = async () => {
    setReading(true);
    setReadError(null);
    try {
      await refreshState();
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Read failed");
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={isSim ? <FlaskConical className="h-4 w-4" /> : <Cable className="h-4 w-4" />}
          title={isSim ? "Simulation mode" : light.mode === "bridge" ? "Live KNX via SE7ENX Bridge" : "Live KNX via Home Assistant"}
          subtitle={
            isSim
              ? "The lamp is simulated in your browser. No real light is controlled."
              : light.link.message ?? "Connected backend"
          }
        />
        <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          {!isSim && t ? (
            <dl className="grid grid-cols-2 gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 sm:grid-cols-4">
              <KeyValue label="Group address" value={t.displayAddress} mono />
              <KeyValue label="DPT" value={t.dpt} mono />
              <KeyValue label="Status address" value={t.displayStatusAddress ?? "—"} mono />
              <KeyValue label="Feedback" value={light.feedbackAvailable ? "Available" : "None"} />
            </dl>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant={isSim ? "primary" : "outline"} onClick={openWizard}>
              <Cable className="h-4 w-4" aria-hidden />
              {isSim ? "Connect a real KNX light…" : "Connection settings…"}
            </Button>
            {!isSim ? (
              <>
                <Button variant="secondary" onClick={read} disabled={reading || light.link.status !== "connected"}>
                  <RefreshCw className={reading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
                  Read state
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await disconnectActiveBackend();
                    await switchToSimulation();
                  }}
                >
                  <Unplug className="h-4 w-4" aria-hidden />
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
          {readError ? (
            <Callout tone="danger" role="alert" title="Could not read state">
              {readError}
            </Callout>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          icon={<Lightbulb className="h-4 w-4" />}
          title="Manual control"
          subtitle={isSim ? "Always available — the reliable fallback for gestures and voice." : "Sends a real KNX telegram to the configured group address."}
        />
        <div className="grid grid-cols-2 gap-3 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <Button variant="on" size="lg" disabled={!enabled} onClick={() => void requestCommand("on", "manual")} data-testid="manual-on">
            <Lightbulb className="h-5 w-5" aria-hidden />
            Switch ON
          </Button>
          <Button variant="off" size="lg" disabled={!enabled} onClick={() => void requestCommand("off", "manual")} data-testid="manual-off">
            <LightbulbOff className="h-5 w-5" aria-hidden />
            Switch OFF
          </Button>
          {!enabled && !isSim ? (
            <p className="col-span-2 text-xs text-ink-300">
              {pending ? "Waiting for the previous command…" : "Controls are disabled until the KNX backend is connected."}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Hand className="h-4 w-4" />} title="Hands-free control" subtitle="Each input is enabled separately and can be stopped instantly." />
        <div className="grid gap-2 px-4 pb-4 pt-3 sm:grid-cols-2 sm:px-5 sm:pb-5">
          <button
            type="button"
            onClick={() => setTab("gesture")}
            className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-left transition-colors hover:border-accent/50"
          >
            <Hand className="h-5 w-5 text-accent" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink-50">Gestures</span>
              <span className="block truncate text-xs text-ink-300">
                {camera === "running" ? (gesturesEnabled ? "Camera on · active" : "Camera on · gestures off") : camera === "error" ? "Camera error" : "Camera off"}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab("voice")}
            className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-left transition-colors hover:border-accent/50"
          >
            <Mic className="h-5 w-5 text-accent" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink-50">Voice</span>
              <span className="block truncate text-xs text-ink-300">{voiceEnabled ? "Enabled · press Listen" : "Off"}</span>
            </span>
          </button>
          {light.dispatchPaused ? (
            <Callout tone="danger" className="sm:col-span-2" title="Emergency stop active">
              Gesture and voice commands are blocked. Use “Resume hands-free” in the header to re-enable them.
            </Callout>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
