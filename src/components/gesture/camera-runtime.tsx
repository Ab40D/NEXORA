"use client";

/**
 * Camera preview + hand-tracking loop. Mounted on the lamp stage whenever the
 * camera is active. Frames are processed locally; nothing is uploaded.
 */
import { Maximize2, Minimize2, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { computeCalibration } from "@/lib/gesture/calibration";
import { drawOverlay } from "@/lib/gesture/draw";
import { GestureEngine, type GestureUpdate } from "@/lib/gesture/gesture-engine";
import { stopCamera, useGestureStore } from "@/lib/gesture/gesture-store";
import type { HandObservation } from "@/lib/gesture/hand-features";
import { getHandTracker } from "@/lib/gesture/hand-tracker";
import { detectLowPower } from "@/lib/device";
import { EXEC_VIEW } from "@/components/experience/exec-view";
import { useExperience } from "@/lib/experience/store";
import { t, useT } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import type { OnOff } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const CAL_PREP_MS = 1500;
const CAL_SAMPLE_MS = 2000;

/**
 * A recognised gesture is only a request: the message shows what actually happened.
 * With a light selected in the Smart Light Experience the gesture goes through the same pipeline
 * as every other input (emergency stop, capability, hub policy); otherwise the legacy path is used.
 */
async function dispatchGesture(value: OnOff) {
  const gs = useGestureStore.getState();
  const at = Date.now();
  if (!gs.gesturesEnabled) {
    gs.set({ lastTrigger: { value, at, ok: false, message: t("gesture.trigger.disabled") } });
    return;
  }
  const xp = useExperience.getState();
  if (xp.target !== "none") {
    const exec = await xp.execute({ kind: value === "on" ? "turn_on" : "turn_off" }, "gesture");
    const ok = exec.state === "confirmed" || exec.state === "simulated" || exec.state === "already";
    const message = t(EXEC_VIEW[exec.state].key) + (exec.error && exec.state !== "already" ? ` — ${t(`errors.${exec.error}.message`)}` : "");
    useGestureStore.getState().set({ lastTrigger: { value, at, ok, message } });
    return;
  }
  const res = await useAppStore.getState().requestCommand(value, "gesture");
  const message =
    res.status === "blocked"
      ? t(`block.${res.reason}`)
      : res.status === "failed"
        ? t("gesture.trigger.failed", { reason: res.message })
        : res.detail;
  useGestureStore.getState().set({ lastTrigger: { value, at, ok: res.status === "done", message } });
}

export function CameraRuntime() {
  const stream = useGestureStore((s) => s.stream);
  const cameraStatus = useGestureStore((s) => s.cameraStatus);
  const previewLarge = useGestureStore((s) => s.previewLarge);
  const { t: tr } = useT();
  const update = useGestureStore((s) => s.update);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GestureEngine | null>(null);

  // keep engine config in sync with settings
  const gesture = useSettings((s) => s.gesture);
  useEffect(() => {
    const cfg = {
      onThreshold: gesture.onThreshold,
      offThreshold: gesture.offThreshold,
      dwellMs: gesture.dwellMs,
      cooldownMs: gesture.cooldownMs,
      requireOpenForOff: gesture.requireOpenForOff,
    };
    if (!engineRef.current) engineRef.current = new GestureEngine(cfg);
    else {
      try {
        engineRef.current.configure(cfg);
      } catch {
        /* invalid combination mid-edit — keep previous config */
      }
    }
  }, [gesture]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!stream || !video || !canvas) return;
    let cancelled = false;
    let raf = 0;
    let vfc = 0;
    const lowPower = detectLowPower();
    const minFrameGap = lowPower ? 60 : 30;
    const ctx = canvas.getContext("2d");
    const store = useGestureStore.getState();
    engineRef.current?.reset();

    let lastVideoTime = -1;
    let lastProcessed = 0;
    let lastPublish = 0;
    let lastStatus = "";
    let frames = 0;
    let fpsWindow = performance.now();
    const cal = { phase: "idle" as string, since: 0, low: [] as number[], high: [] as number[] };

    const start = async () => {
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
      } catch {
        /* autoplay of a muted inline video should always succeed after a user gesture */
      }
      if (cancelled) return;
      store.set({ cameraStatus: "loading-model" });
      let handle;
      try {
        handle = await getHandTracker();
      } catch (err) {
        if (cancelled) return;
        useGestureStore.getState().set({
          cameraStatus: "error",
          error: {
            code: "model",
            message: t("gesture.overlay.modelError", { error: err instanceof Error ? err.message : "?" }),
          },
        });
        return;
      }
      if (cancelled) return;
      useGestureStore.getState().set({ cameraStatus: "running", delegate: handle.delegate });

      const loop = () => {
        if (cancelled) return;
        schedule();
        if (document.hidden || video.readyState < 2) return;
        const now = performance.now();
        if (video.currentTime === lastVideoTime || now - lastProcessed < minFrameGap) return;
        lastVideoTime = video.currentTime;
        lastProcessed = now;

        let hands: HandObservation[] = [];
        try {
          const res = handle.landmarker.detectForVideo(video, now);
          hands = res.landmarks.map((lm, i) => ({
            landmarks: lm,
            score: res.handedness[i]?.[0]?.score ?? 0,
            handedness: res.handedness[i]?.[0]?.categoryName,
          }));
        } catch (err) {
          console.warn("[se7enx] hand tracking frame failed", err);
          return;
        }

        const engine = engineRef.current!;
        const gs = useGestureStore.getState();
        const settings = useSettings.getState().gesture;
        let upd: GestureUpdate = engine.update({ t: now, hands });

        // ---- calibration state machine (suppresses triggers while running)
        const phase = gs.calibration.phase;
        if (phase !== cal.phase) {
          cal.phase = phase;
          cal.since = now;
          if (phase === "get-low") {
            cal.low = [];
            cal.high = [];
          }
        }
        if (phase !== "idle" && phase !== "done" && phase !== "failed") {
          upd = { ...upd, trigger: null };
          const elapsed = now - cal.since;
          const valid = upd.rawHeight !== null && upd.open && upd.status !== "low-confidence" && upd.status !== "no-hand";
          if (phase === "get-low" && elapsed > CAL_PREP_MS) gs.set({ calibration: { phase: "low", message: null, progress: 0 } });
          else if (phase === "low") {
            if (valid) cal.low.push(upd.rawHeight!);
            if (elapsed > CAL_SAMPLE_MS) gs.set({ calibration: { phase: "get-high", message: null, progress: 0 } });
            else gs.set({ calibration: { phase, message: null, progress: elapsed / CAL_SAMPLE_MS } });
          } else if (phase === "get-high" && elapsed > CAL_PREP_MS) gs.set({ calibration: { phase: "high", message: null, progress: 0 } });
          else if (phase === "high") {
            if (valid) cal.high.push(upd.rawHeight!);
            if (elapsed > CAL_SAMPLE_MS) {
              const r = computeCalibration(cal.low, cal.high);
              if (r.ok) {
                useSettings.getState().setGesture({ onThreshold: r.onThreshold, offThreshold: r.offThreshold });
                engine.reset();
                gs.set({
                  calibration: {
                    phase: "done",
                    progress: 1,
                    message: t("gesture.cal.done", { on: `${Math.round(r.onThreshold * 100)}%`, off: `${Math.round(r.offThreshold * 100)}%` }),
                  },
                });
              } else {
                gs.set({ calibration: { phase: "failed", progress: 0, message: t(`gesture.cal.${r.code}`) } });
              }
            } else gs.set({ calibration: { phase, message: null, progress: elapsed / CAL_SAMPLE_MS } });
          }
        }

        if (upd.trigger) void dispatchGesture(upd.trigger);

        // ---- draw overlay
        if (ctx) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.round(canvas.clientWidth * dpr);
          const h = Math.round(canvas.clientHeight * dpr);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          drawOverlay(ctx, w, h, hands.map((x) => x.landmarks), upd, {
            onThreshold: settings.onThreshold,
            offThreshold: settings.offThreshold,
            showLandmarks: settings.showLandmarks,
            mirror: true,
            dpr,
          });
        }

        // ---- publish to React at ~10 Hz (or immediately on status change)
        frames++;
        if (now - fpsWindow > 1000) {
          gs.set({ fps: Math.round((frames * 1000) / (now - fpsWindow)) });
          frames = 0;
          fpsWindow = now;
        }
        if (upd.trigger || upd.status !== lastStatus || now - lastPublish > 100) {
          lastStatus = upd.status;
          lastPublish = now;
          gs.set({ update: upd });
        }
      };

      const v = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
        cancelVideoFrameCallback?: (id: number) => void;
      };
      const schedule = () => {
        if (cancelled) return;
        if (typeof v.requestVideoFrameCallback === "function" && !document.hidden) vfc = v.requestVideoFrameCallback(loop);
        else raf = requestAnimationFrame(loop);
      };
      schedule();
    };

    void start();
    const onVisibility = () => {
      if (document.hidden) engineRef.current?.reset();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const v = video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
      if (vfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(vfc);
      document.removeEventListener("visibilitychange", onVisibility);
      video.pause();
      video.srcObject = null;
    };
  }, [stream]);

  if (!stream) return null;

  const statusText =
    cameraStatus === "loading-model"
      ? tr("gesture.overlay.loading")
      : cameraStatus === "starting"
        ? tr("gesture.overlay.starting")
        : update
          ? tr(`gesture.status.${update.status}`)
          : tr("gesture.showHand");

  return (
    <div
      className={cn(
        "pointer-events-auto absolute bottom-3 right-3 z-20 overflow-hidden rounded-2xl border border-ink-500/80 bg-ink-950 shadow-[var(--shadow-glow)] transition-[width] duration-300",
        previewLarge ? "w-[min(92%,26rem)]" : "w-[min(46%,13.5rem)]",
      )}
    >
      <div className="relative aspect-[4/3]">
        <video ref={videoRef} className="absolute inset-0 h-full w-full -scale-x-100 object-cover opacity-80" muted playsInline aria-label={tr("gesture.overlay.preview")} />
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
        {cameraStatus !== "running" ? (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/70 text-xs text-ink-200">{statusText}</div>
        ) : null}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 bg-gradient-to-b from-ink-950/90 to-transparent px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-100">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-hidden />
            {tr("gesture.overlay.localOnly")}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => useGestureStore.getState().set({ previewLarge: !previewLarge })}
              className="grid h-6 w-6 place-items-center rounded-md bg-ink-800/80 text-ink-100 hover:bg-ink-700"
              aria-label={previewLarge ? tr("gesture.overlay.shrink") : tr("gesture.overlay.enlarge")}
            >
              {previewLarge ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={stopCamera}
              className="grid h-6 w-6 place-items-center rounded-md bg-ink-800/80 text-ink-100 hover:bg-danger/40"
              aria-label={tr("gesture.overlay.off")}
            >
              <VideoOff className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-ink-700 px-2.5 py-1.5 text-[11px] text-ink-200" aria-live="polite">
        <span className="truncate">{statusText}</span>
      </div>
    </div>
  );
}
