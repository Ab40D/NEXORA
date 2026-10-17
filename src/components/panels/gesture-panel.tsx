"use client";

import { Camera, CameraOff, Crosshair, Hand, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Slider, Switch } from "@/components/ui/primitives";
import { useTarget } from "@/lib/experience/store";
import { MIN_THRESHOLD_GAP } from "@/lib/gesture/gesture-engine";
import { cancelCalibration, startCalibration, startCamera, stopCamera, useGestureStore } from "@/lib/gesture/gesture-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";

const CAMERA_ERROR_CODES = new Set([
  "unsupported",
  "insecure",
  "ended",
  "NotAllowedError",
  "SecurityError",
  "NotFoundError",
  "OverconstrainedError",
  "NotReadableError",
  "AbortError",
]);

export function GesturePanel() {
  const { t, pct: fmtPct } = useT();
  const pct = (v: number) => fmtPct(v * 100);
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
  const legacySim = useAppStore((s) => s.light.mode === "simulation");
  const target = useTarget();
  const isSim = target ? target.simulated : legacySim;

  const cameraOn = camera === "starting" || camera === "loading-model" || camera === "running";
  const calibrating = !["idle", "done", "failed"].includes(calibration.phase);
  const errorText = error
    ? CAMERA_ERROR_CODES.has(error.code)
      ? t(`gesture.cameraError.${error.code}` as MessageKey)
      : error.code === "model"
        ? error.message
        : t("gesture.cameraError.generic", { code: error.code })
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Hand className="h-4 w-4" />}
          title={t("gesture.title")}
          subtitle={t("gesture.subtitle")}
          actions={
            cameraOn ? (
              <Badge tone={camera === "running" ? "ok" : "accent"} dot>
                {camera === "running" ? t("gesture.cameraOn") : t("gesture.starting")}
              </Badge>
            ) : null
          }
        />
        <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <div className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs leading-relaxed text-ink-300">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
            <p>{t("gesture.privacy")}</p>
          </div>

          <details className="rounded-xl border border-ink-700 p-3 text-xs text-ink-300" data-testid="gesture-tutorial">
            <summary className="cursor-pointer select-none font-medium text-ink-100">{t("gesture.tutorial.title")}</summary>
            <ol className="mt-2 list-decimal space-y-1 ps-5">
              <li>{t("gesture.tutorial.step1")}</li>
              <li>{t("gesture.tutorial.step2")}</li>
              <li>{t("gesture.tutorial.step3")}</li>
              <li>{t("gesture.tutorial.step4")}</li>
            </ol>
          </details>

          <div className="flex flex-wrap gap-2">
            {!cameraOn ? (
              <Button variant="primary" onClick={() => void startCamera()} disabled={camera === "requesting"} data-testid="enable-camera">
                <Camera className="h-4 w-4" aria-hidden />
                {camera === "requesting" ? t("gesture.waiting") : t("gesture.enable")}
              </Button>
            ) : (
              <Button variant="secondary" onClick={stopCamera}>
                <CameraOff className="h-4 w-4" aria-hidden />
                {t("gesture.turnOff")}
              </Button>
            )}
            <Button variant="outline" onClick={startCalibration} disabled={camera !== "running" || calibrating}>
              <Crosshair className="h-4 w-4" aria-hidden />
              {t("gesture.calibrate")}
            </Button>
          </div>

          {errorText ? (
            <Callout tone="danger" role="alert" title={t("gesture.unavailable")}>
              {errorText}
              <span className="mt-1 block text-ink-300">{t("gesture.keepWorking")}</span>
            </Callout>
          ) : null}

          {target ? (
            <p className="text-xs text-ink-300">
              {t("gesture.target", { name: target.name })}
            </p>
          ) : null}
          <Switch
            id="gestures-enabled"
            checked={enabled}
            onCheckedChange={(v) => setG({ gesturesEnabled: v })}
            label={t("gesture.send")}
            description={paused ? t("gesture.blocked") : isSim ? t("gesture.sendsSim") : t("gesture.sendsReal")}
          />

          {camera === "running" ? (
            <div className="grid gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm sm:grid-cols-2" aria-live="polite">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("gesture.tracking")}</p>
                <p className="mt-0.5 text-ink-100">{update ? t(`gesture.status.${update.status}`) : t("gesture.showHand")}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-400">
                  {t("gesture.metrics", {
                    fps,
                    delegate: delegate ?? "—",
                    height: update?.height != null ? pct(update.height) : "—",
                    confidence: update?.confidence ? pct(update.confidence) : "—",
                  })}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("gesture.lastGesture")}</p>
                {lastTrigger ? (
                  <p className={cn("mt-0.5", lastTrigger.ok ? "text-ok" : "text-warn")} data-testid="gesture-last">
                    {t(lastTrigger.value === "on" ? "light.on" : "light.off")} — {lastTrigger.message}
                  </p>
                ) : (
                  <p className="mt-0.5 text-ink-400">{t("gesture.noneYet")}</p>
                )}
              </div>
            </div>
          ) : null}

          {calibration.phase !== "idle" ? (
            <Callout
              tone={calibration.phase === "failed" ? "danger" : calibration.phase === "done" ? "ok" : "accent"}
              title={calibration.phase === "done" ? t("gesture.calDone") : calibration.phase === "failed" ? t("gesture.calFailed") : t("gesture.calibrating")}
            >
              <p>{calibration.message ?? (calibrating ? t(`gesture.cal.${calibration.phase as "get-low" | "low" | "get-high" | "high"}`) : "")}</p>
              {calibrating ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuenow={Math.round(calibration.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
                </div>
              ) : null}
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={cancelCalibration}>
                  {calibrating ? t("gesture.cancel") : t("gesture.dismiss")}
                </Button>
              </div>
            </Callout>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("gesture.tuning")}
          subtitle={t("gesture.tuningSub")}
          actions={
            <Button variant="ghost" size="sm" onClick={resetGesture}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t("gesture.defaults")}
            </Button>
          }
        />
        <div className="space-y-5 px-4 pb-5 pt-3 sm:px-5">
          <Slider
            id="on-threshold"
            label={t("gesture.onLine")}
            value={g.onThreshold}
            min={0.05}
            max={0.95}
            step={0.01}
            format={pct}
            onChange={(v) => setGesture({ onThreshold: Math.round(Math.max(v, g.offThreshold + MIN_THRESHOLD_GAP) * 100) / 100 })}
            description={t("gesture.onLineHint", { gap: pct(MIN_THRESHOLD_GAP) })}
          />
          <Slider
            id="off-threshold"
            label={t("gesture.offLine")}
            value={g.offThreshold}
            min={0.05}
            max={0.95}
            step={0.01}
            format={pct}
            onChange={(v) => setGesture({ offThreshold: Math.round(Math.min(v, g.onThreshold - MIN_THRESHOLD_GAP) * 100) / 100 })}
          />
          <Slider
            id="dwell"
            label={t("gesture.hold")}
            value={g.dwellMs}
            min={150}
            max={1500}
            step={50}
            format={(v) => `${v} ms`}
            onChange={(v) => setGesture({ dwellMs: v })}
            description={t("gesture.holdHint")}
          />
          <Slider
            id="cooldown"
            label={t("gesture.cooldown")}
            value={g.cooldownMs}
            min={500}
            max={5000}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)} s`}
            onChange={(v) => setGesture({ cooldownMs: v })}
            description={t("gesture.cooldownHint")}
          />
          <Switch
            id="open-for-off"
            checked={g.requireOpenForOff}
            onCheckedChange={(v) => setGesture({ requireOpenForOff: v })}
            label={t("gesture.openForOff")}
            description={t("gesture.openForOffHint")}
          />
          <Switch id="landmarks" checked={g.showLandmarks} onCheckedChange={(v) => setGesture({ showLandmarks: v })} label={t("gesture.landmarks")} />
        </div>
      </Card>
    </div>
  );
}
