"use client";

import { Camera, CameraOff, Crosshair, Hand, RotateCcw, ShieldCheck } from "lucide-react";
import { GESTURE_STATUS_TEXT } from "@/components/gesture/camera-runtime";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Slider, Switch } from "@/components/ui/primitives";
import { MIN_THRESHOLD_GAP } from "@/lib/gesture/gesture-engine";
import { cancelCalibration, startCalibration, startCamera, stopCamera, useGestureStore } from "@/lib/gesture/gesture-store";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";

const pct = (v: number) => `${Math.round(v * 100)}%`;

const CAL_TEXT: Record<string, string> = {
  "get-low": "Step 1/2 — get ready: hold your OPEN hand LOW (around chest height)…",
  low: "Step 1/2 — hold still LOW…",
  "get-high": "Step 2/2 — get ready: raise your OPEN hand HIGH (above your head)…",
  high: "Step 2/2 — hold still HIGH…",
};

export function GesturePanel() {
  const camera = useGestureStore((s) => s.cameraStatus);
  const error = useGestureStore((s) => s.error);
  const update = useGestureStore((s) => s.update);
  const fps = useGestureStore((s) => s.fps);
  const delegate = useGestureStore((s) => s.delegate);
  const enabled = useGestureStore((s) => s.gesturesEnabled);
  const lastTrigger = useGestureStore((s) => s.lastTrigger);
  const calibration = useGestureStore((s) => s.calibration);
  const setG = useGestureStore((s) => s.set);
  const g = useSettings((s) => s.gesture);
  const setGesture = useSettings((s) => s.setGesture);
  const resetGesture = useSettings((s) => s.resetGesture);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const isSim = useAppStore((s) => s.light.mode === "simulation");

  const cameraOn = camera === "starting" || camera === "loading-model" || camera === "running";
  const calibrating = !["idle", "done", "failed"].includes(calibration.phase);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Hand className="h-4 w-4" />}
          title="Hand gestures"
          subtitle="Raise an open hand above the cyan line to switch ON. Lower it below the amber line to switch OFF. Hold briefly to confirm."
          actions={cameraOn ? <Badge tone={camera === "running" ? "ok" : "accent"} dot>{camera === "running" ? "Camera on" : "Starting"}</Badge> : null}
        />
        <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <div className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs leading-relaxed text-ink-300">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
            <p>
              The camera starts only when you click <strong className="text-ink-100">Enable camera</strong>. Video is analysed on this device
              by MediaPipe (WebAssembly) and is never uploaded or recorded.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {!cameraOn ? (
              <Button variant="primary" onClick={() => void startCamera()} disabled={camera === "requesting"} data-testid="enable-camera">
                <Camera className="h-4 w-4" aria-hidden />
                {camera === "requesting" ? "Waiting for permission…" : "Enable camera"}
              </Button>
            ) : (
              <Button variant="secondary" onClick={stopCamera}>
                <CameraOff className="h-4 w-4" aria-hidden />
                Turn camera off
              </Button>
            )}
            <Button variant="outline" onClick={startCalibration} disabled={camera !== "running" || calibrating}>
              <Crosshair className="h-4 w-4" aria-hidden />
              Calibrate
            </Button>
          </div>

          {error ? (
            <Callout tone="danger" role="alert" title="Camera unavailable">
              {error.message}
              <span className="mt-1 block text-ink-300">Manual controls and voice commands keep working.</span>
            </Callout>
          ) : null}

          <Switch
            id="gestures-enabled"
            checked={enabled}
            onCheckedChange={(v) => setG({ gesturesEnabled: v })}
            label="Send gesture commands"
            description={
              paused
                ? "Blocked by the emergency stop."
                : isSim
                  ? "Detected gestures switch the simulated lamp."
                  : "Detected gestures switch the REAL light. Turn off to only preview tracking."
            }
          />

          {camera === "running" ? (
            <div className="grid gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm sm:grid-cols-2" aria-live="polite">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Tracking</p>
                <p className="mt-0.5 text-ink-100">{update ? GESTURE_STATUS_TEXT[update.status] : "Show your open hand"}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-400">
                  {fps} fps · {delegate ?? "—"} · hand height {update?.height != null ? pct(update.height) : "—"} · confidence{" "}
                  {update?.confidence ? pct(update.confidence) : "—"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Last gesture</p>
                {lastTrigger ? (
                  <p className={cn("mt-0.5", lastTrigger.ok ? "text-ok" : "text-warn")}>
                    {lastTrigger.value.toUpperCase()} — {lastTrigger.message}
                  </p>
                ) : (
                  <p className="mt-0.5 text-ink-400">None yet</p>
                )}
              </div>
            </div>
          ) : null}

          {calibration.phase !== "idle" ? (
            <Callout
              tone={calibration.phase === "failed" ? "danger" : calibration.phase === "done" ? "ok" : "accent"}
              title={calibration.phase === "done" ? "Calibration complete" : calibration.phase === "failed" ? "Calibration failed" : "Calibrating"}
            >
              <p>{calibration.message ?? CAL_TEXT[calibration.phase]}</p>
              {calibrating ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuenow={Math.round(calibration.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
                </div>
              ) : null}
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={cancelCalibration}>
                  {calibrating ? "Cancel" : "Dismiss"}
                </Button>
              </div>
            </Callout>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Gesture tuning"
          subtitle="Thresholds are measured from the bottom (0%) to the top (100%) of the camera image."
          actions={
            <Button variant="ghost" size="sm" onClick={resetGesture}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Defaults
            </Button>
          }
        />
        <div className="space-y-5 px-4 pb-5 pt-3 sm:px-5">
          <Slider
            id="on-threshold"
            label="ON line (raise above)"
            value={g.onThreshold}
            min={0.05}
            max={0.95}
            step={0.01}
            format={pct}
            onChange={(v) => setGesture({ onThreshold: Math.round(Math.max(v, g.offThreshold + MIN_THRESHOLD_GAP) * 100) / 100 })}
            description={`Must stay at least ${Math.round(MIN_THRESHOLD_GAP * 100)}% above the OFF line.`}
          />
          <Slider
            id="off-threshold"
            label="OFF line (lower below)"
            value={g.offThreshold}
            min={0.05}
            max={0.95}
            step={0.01}
            format={pct}
            onChange={(v) => setGesture({ offThreshold: Math.round(Math.min(v, g.onThreshold - MIN_THRESHOLD_GAP) * 100) / 100 })}
          />
          <Slider
            id="dwell"
            label="Hold time"
            value={g.dwellMs}
            min={150}
            max={1500}
            step={50}
            format={(v) => `${v} ms`}
            onChange={(v) => setGesture({ dwellMs: v })}
            description="How long the hand must stay in a zone before the command is sent."
          />
          <Slider
            id="cooldown"
            label="Cooldown"
            value={g.cooldownMs}
            min={500}
            max={5000}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)} s`}
            onChange={(v) => setGesture({ cooldownMs: v })}
            description="Minimum pause after a gesture before the next one is accepted."
          />
          <Switch
            id="open-for-off"
            checked={g.requireOpenForOff}
            onCheckedChange={(v) => setGesture({ requireOpenForOff: v })}
            label="Require open hand for OFF"
            description="Reduces accidental OFF when you lower a relaxed hand."
          />
          <Switch id="landmarks" checked={g.showLandmarks} onCheckedChange={(v) => setGesture({ showLandmarks: v })} label="Show hand landmarks" />
        </div>
      </Card>
    </div>
  );
}
