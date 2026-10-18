"use client";

/**
 * Camera preview + hand-tracking loop, mounted once in the app shell so gestures work on every
 * page while the camera is on. Frames are processed locally; nothing is uploaded.
 *
 * Pipeline per frame: MediaPipe landmarks → static pose recognizer (thumb up, fist, …) and,
 * for the classic profile, the hand-height engine → the active gesture profile → dispatch
 * through the normal command pipeline (permissions, emergency stop, hub policy).
 */
import { Maximize2, Minimize2, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { computeCalibration } from "@/lib/gesture/calibration";
import { dispatchGesture } from "@/lib/gesture/dispatch";
import { drawOverlay, drawPoseOverlay } from "@/lib/gesture/draw";
import { GestureEngine, type GestureUpdate } from "@/lib/gesture/gesture-engine";
import { stopCamera, useGestureStore } from "@/lib/gesture/gesture-store";
import type { HandObservation } from "@/lib/gesture/hand-features";
import { fallbackToCpu, getHandTracker, type TrackerHandle } from "@/lib/gesture/hand-tracker";
import { activePoses, getActiveProfile, useActiveProfile, usesHeight, type GestureId } from "@/lib/gesture/profiles";
import { PoseRecognizer, type RecognizerUpdate } from "@/lib/gesture/recognizer";
import { detectLowPower } from "@/lib/device";
import { t, useT } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { cn } from "@/lib/utils";

const CAL_PREP_MS = 1500;
const CAL_SAMPLE_MS = 2000;
/** consecutive failing frames before the tracker is replaced by a CPU one */
const MAX_FRAME_ERRORS = 3;
/** auto mode: GPU slower than this after warm-up → switch to CPU */
const SLOW_GPU_FPS = 6;
const WARMUP_MS = 4000;

let dispatching = false;

async function runGesture(gesture: GestureId): Promise<void> {
  if (dispatching) return; // never queue commands from the camera
  const profile = getActiveProfile();
  if (!profile.bindings[gesture]) return;
  dispatching = true;
  try {
    const res = await dispatchGesture(gesture, profile, { gesturesEnabled: useGestureStore.getState().gesturesEnabled });
    if (res) useGestureStore.getState().set({ lastTrigger: res });
  } finally {
    dispatching = false;
  }
}

export function CameraRuntime() {
  const stream = useGestureStore((s) => s.stream);
  const cameraStatus = useGestureStore((s) => s.cameraStatus);
  const previewLarge = useGestureStore((s) => s.previewLarge);
  const pose = useGestureStore((s) => s.pose);
  const update = useGestureStore((s) => s.update);
  const lastTrigger = useGestureStore((s) => s.lastTrigger);
  const profile = useActiveProfile();
  const { t: tr } = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GestureEngine | null>(null);
  const recognizerRef = useRef<PoseRecognizer | null>(null);

  // keep the height engine in sync with settings
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

  // keep the pose recognizer in sync with the active profile
  useEffect(() => {
    const cfg = { holdMs: profile.holdMs, cooldownMs: profile.cooldownMs };
    if (!recognizerRef.current) recognizerRef.current = new PoseRecognizer(activePoses(profile), cfg);
    else recognizerRef.current.configure(activePoses(profile), cfg);
  }, [profile]);

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
    recognizerRef.current?.reset();

    let handle: TrackerHandle | null = null;
    let lastVideoTime = -1;
    let lastProcessed = 0;
    let lastPublish = 0;
    let lastStatus = "";
    let frames = 0;
    let fpsWindow = performance.now();
    let runningSince = 0;
    let consecutiveErrors = 0;
    let switching = false;
    const inference: number[] = [];
    const cal = { phase: "idle" as string, since: 0, low: [] as number[], high: [] as number[] };

    const switchToCpu = async (note: string) => {
      if (!handle || handle.delegate === "CPU" || switching) return;
      switching = true;
      try {
        handle = await fallbackToCpu(handle);
        runningSince = performance.now();
        consecutiveErrors = 0;
        useGestureStore.getState().set({ delegate: handle.delegate, delegateReason: handle.reason, delegateNote: note });
      } catch (err) {
        useGestureStore.getState().set({
          cameraStatus: "error",
          error: { code: "model", message: t("gesture.overlay.modelError", { error: err instanceof Error ? err.message : "?" }) },
        });
        cancelled = true;
      } finally {
        switching = false;
      }
    };

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
      try {
        handle = await getHandTracker(useSettings.getState().gesture.delegate);
      } catch (err) {
        if (cancelled) return;
        useGestureStore.getState().set({
          cameraStatus: "error",
          error: { code: "model", message: t("gesture.overlay.modelError", { error: err instanceof Error ? err.message : "?" }) },
        });
        return;
      }
      if (cancelled) return;
      runningSince = performance.now();
      useGestureStore.getState().set({ cameraStatus: "running", delegate: handle.delegate, delegateReason: handle.reason, modelLoadMs: handle.loadMs });

      const loop = () => {
        if (cancelled) return;
        schedule();
        if (!handle || switching || document.hidden || video.readyState < 2) return;
        const now = performance.now();
        if (video.currentTime === lastVideoTime || now - lastProcessed < minFrameGap) return;
        lastVideoTime = video.currentTime;
        lastProcessed = now;
        const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;

        let hands: HandObservation[] = [];
        try {
          const t0 = performance.now();
          const res = handle.landmarker.detectForVideo(video, now);
          inference.push(performance.now() - t0);
          if (inference.length > 30) inference.shift();
          consecutiveErrors = 0;
          hands = res.landmarks.map((lm, i) => ({
            landmarks: lm,
            score: res.handedness[i]?.[0]?.score ?? 0,
            handedness: res.handedness[i]?.[0]?.categoryName,
          }));
        } catch (err) {
          consecutiveErrors++;
          useGestureStore.getState().set({ frameErrors: useGestureStore.getState().frameErrors + 1 });
          console.warn("[se7enx] hand tracking frame failed", err);
          if (consecutiveErrors >= MAX_FRAME_ERRORS) void switchToCpu(t("gesture.diag.noteErrors"));
          return;
        }

        const gs = useGestureStore.getState();
        const settings = useSettings.getState().gesture;
        const prof = getActiveProfile();
        const heightMode = usesHeight(prof);
        const recognizer = recognizerRef.current!;
        const poseUpd: RecognizerUpdate = recognizer.update({ t: now, hands, aspect });
        let upd: GestureUpdate | null = heightMode ? engineRef.current!.update({ t: now, hands, aspect }) : null;

        // ---- calibration state machine (height profile; suppresses triggers while running)
        const phase = gs.calibration.phase;
        if (phase !== cal.phase) {
          cal.phase = phase;
          cal.since = now;
          if (phase === "get-low") {
            cal.low = [];
            cal.high = [];
          }
        }
        const calibrating = phase !== "idle" && phase !== "done" && phase !== "failed";
        if (calibrating) {
          const h = upd ?? engineRef.current!.update({ t: now, hands, aspect });
          upd = { ...h, trigger: null };
          const elapsed = now - cal.since;
          const valid = h.rawHeight !== null && h.open && h.status !== "low-confidence" && h.status !== "no-hand";
          if (phase === "get-low" && elapsed > CAL_PREP_MS) gs.set({ calibration: { phase: "low", message: null, progress: 0 } });
          else if (phase === "low") {
            if (valid) cal.low.push(h.rawHeight!);
            if (elapsed > CAL_SAMPLE_MS) gs.set({ calibration: { phase: "get-high", message: null, progress: 0 } });
            else gs.set({ calibration: { phase, message: null, progress: elapsed / CAL_SAMPLE_MS } });
          } else if (phase === "get-high" && elapsed > CAL_PREP_MS) gs.set({ calibration: { phase: "high", message: null, progress: 0 } });
          else if (phase === "high") {
            if (valid) cal.high.push(h.rawHeight!);
            if (elapsed > CAL_SAMPLE_MS) {
              const r = computeCalibration(cal.low, cal.high);
              if (r.ok) {
                useSettings.getState().setGesture({ onThreshold: r.onThreshold, offThreshold: r.offThreshold });
                engineRef.current!.reset();
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
        } else {
          if (poseUpd.trigger) void runGesture(poseUpd.trigger);
          if (upd?.trigger) void runGesture(upd.trigger === "on" ? "raise" : "lower");
        }

        // ---- draw overlay
        if (ctx) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.round(canvas.clientWidth * dpr);
          const h = Math.round(canvas.clientHeight * dpr);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          const mirror = (gs.streamInfo?.facingMode ?? settings.facing) !== "environment";
          const lms = hands.map((x) => x.landmarks);
          if (heightMode || calibrating) {
            drawOverlay(ctx, w, h, lms, upd, { onThreshold: settings.onThreshold, offThreshold: settings.offThreshold, showLandmarks: settings.showLandmarks, mirror, dpr });
          } else {
            drawPoseOverlay(ctx, w, h, lms, poseUpd, { showLandmarks: settings.showLandmarks, mirror, dpr });
          }
        }

        // ---- metrics + automatic delegate switch (auto mode only)
        frames++;
        if (now - fpsWindow > 1000) {
          const fps = Math.round((frames * 1000) / (now - fpsWindow));
          const sorted = [...inference].sort((a, b) => a - b);
          const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]!) : null;
          gs.set({ fps, inferenceMs: median });
          frames = 0;
          fpsWindow = now;
          if (settings.delegate === "auto" && handle.delegate === "GPU" && now - runningSince > WARMUP_MS && fps < SLOW_GPU_FPS) {
            void switchToCpu(t("gesture.diag.noteSlow", { fps }));
          }
        }
        const status = `${poseUpd.status}:${poseUpd.pose}:${upd?.status ?? ""}`;
        if (poseUpd.trigger || upd?.trigger || status !== lastStatus || now - lastPublish > 100) {
          lastStatus = status;
          lastPublish = now;
          gs.set({ pose: poseUpd, update: upd });
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
      if (document.hidden) {
        engineRef.current?.reset();
        recognizerRef.current?.reset();
      }
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

  const heightMode = usesHeight(profile);
  const statusText =
    cameraStatus === "loading-model"
      ? tr("gesture.overlay.loading")
      : cameraStatus === "starting"
        ? tr("gesture.overlay.starting")
        : heightMode
          ? update
            ? tr(`gesture.status.${update.status}`)
            : tr("gesture.showHand")
          : pose
            ? pose.pose
              ? `${tr(`gesture.pose.${pose.pose}`)} · ${tr(`gesture.rstatus.${pose.status}`)}`
              : tr(`gesture.rstatus.${pose.status}`)
            : tr("gesture.showHand");
  const mirror = useSettings.getState().gesture.facing !== "environment";

  return (
    <div
      className={cn(
        "pointer-events-auto fixed bottom-3 end-3 z-40 overflow-hidden rounded-2xl border border-ink-500/80 bg-ink-950 shadow-[var(--shadow-glow)] transition-[width] duration-300",
        previewLarge ? "w-[min(92vw,26rem)]" : "w-[min(46vw,13.5rem)]",
      )}
      data-testid="camera-dock"
    >
      <div className="relative aspect-[4/3]">
        <video
          ref={videoRef}
          className={cn("absolute inset-0 h-full w-full object-cover opacity-80", mirror && "-scale-x-100")}
          muted
          playsInline
          aria-label={tr("gesture.overlay.preview")}
        />
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
      <div className="space-y-0.5 border-t border-ink-700 px-2.5 py-1.5 text-[11px] text-ink-200" aria-live="polite">
        <p className="truncate" data-testid="camera-dock-status">
          {statusText}
        </p>
        {lastTrigger ? (
          <p className={cn("truncate", lastTrigger.ok ? "text-ok" : "text-warn")} data-testid="camera-dock-last" title={lastTrigger.message}>
            {tr(`gesture.pose.${lastTrigger.gesture}`)} → {lastTrigger.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
