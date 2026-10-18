"use client";

import { create } from "zustand";
import type { GestureDispatchResult } from "./dispatch";
import type { GestureUpdate } from "./gesture-engine";
import type { Delegate, TrackerHandle } from "./hand-tracker";
import type { RecognizerUpdate } from "./recognizer";

export type CameraStatus = "off" | "requesting" | "starting" | "loading-model" | "running" | "error";
export type CalibrationPhase = "idle" | "get-low" | "low" | "get-high" | "high" | "done" | "failed";

export interface StreamInfo {
  label: string;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  facingMode: string | null;
}

interface GestureStore {
  cameraStatus: CameraStatus;
  error: { code: string; message: string } | null;
  stream: MediaStream | null;
  streamInfo: StreamInfo | null;
  /** whether recognised gestures are dispatched as commands */
  gesturesEnabled: boolean;
  /** height engine state (classic raise/lower profile) */
  update: GestureUpdate | null;
  /** static pose recognizer state */
  pose: RecognizerUpdate | null;
  fps: number;
  /** median inference time per frame (ms) */
  inferenceMs: number | null;
  delegate: Delegate | null;
  delegateReason: TrackerHandle["reason"] | null;
  modelLoadMs: number | null;
  frameErrors: number;
  /** last automatic delegate switch, for diagnostics */
  delegateNote: string | null;
  lastTrigger: GestureDispatchResult | null;
  calibration: { phase: CalibrationPhase; message: string | null; progress: number };
  previewLarge: boolean;
  set: (patch: Partial<Omit<GestureStore, "set">>) => void;
}

export const useGestureStore = create<GestureStore>((set) => ({
  cameraStatus: "off",
  error: null,
  stream: null,
  streamInfo: null,
  gesturesEnabled: true,
  update: null,
  pose: null,
  fps: 0,
  inferenceMs: null,
  delegate: null,
  delegateReason: null,
  modelLoadMs: null,
  frameErrors: 0,
  delegateNote: null,
  lastTrigger: null,
  calibration: { phase: "idle", message: null, progress: 0 },
  previewLarge: false,
  set: (patch) => set(patch),
}));

const CAMERA_ERRORS: Record<string, string> = {
  NotAllowedError:
    "Camera permission was denied. Allow camera access for this site in your browser settings, then click Enable camera again.",
  SecurityError: "The camera is blocked in this context. It requires HTTPS (or localhost) and must not be disabled by policy.",
  NotFoundError: "No camera was found on this device.",
  OverconstrainedError: "No camera matches the required settings.",
  NotReadableError: "The camera is in use by another application or could not be started.",
  AbortError: "Starting the camera was interrupted. Try again.",
};

function describeTrack(track: MediaStreamTrack | undefined): StreamInfo | null {
  if (!track) return null;
  const s = track.getSettings?.() ?? {};
  return {
    label: track.label || "camera",
    width: s.width ?? null,
    height: s.height ?? null,
    frameRate: s.frameRate ? Math.round(s.frameRate) : null,
    facingMode: s.facingMode ?? null,
  };
}

/**
 * Request the camera. MUST be called from an explicit user action
 * ("Enable camera"). Video frames stay in the browser — they are processed
 * locally by MediaPipe and never uploaded.
 */
export async function startCamera(facing: "user" | "environment" = "user"): Promise<void> {
  const store = useGestureStore.getState();
  if (store.stream || store.cameraStatus === "requesting") return;
  // Check the secure context first: on http://<LAN-IP> browsers hide navigator.mediaDevices
  // entirely, which used to be reported as an unsupported browser.
  if (typeof window !== "undefined" && !window.isSecureContext) {
    store.set({ cameraStatus: "error", error: { code: "insecure", message: "Camera access requires HTTPS (or localhost)." } });
    return;
  }
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    store.set({
      cameraStatus: "error",
      error: { code: "unsupported", message: "This browser does not provide camera access." },
    });
    return;
  }
  store.set({ cameraStatus: "requesting", error: null, frameErrors: 0, delegateNote: null });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    });
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      const s = useGestureStore.getState();
      if (s.stream === stream) {
        s.set({ stream: null, streamInfo: null, cameraStatus: "error", update: null, pose: null, error: { code: "ended", message: "The camera was disconnected or stopped by the system." } });
      }
    });
    useGestureStore.getState().set({ stream, streamInfo: describeTrack(track), cameraStatus: "starting" });
  } catch (err) {
    const name = (err as DOMException)?.name ?? "Error";
    useGestureStore.getState().set({
      cameraStatus: "error",
      error: { code: name, message: CAMERA_ERRORS[name] ?? `Could not start the camera (${name}).` },
    });
  }
}

export function stopCamera(): void {
  const { stream, set } = useGestureStore.getState();
  stream?.getTracks().forEach((t) => t.stop());
  set({ stream: null, streamInfo: null, cameraStatus: "off", update: null, pose: null, fps: 0, inferenceMs: null, calibration: { phase: "idle", message: null, progress: 0 } });
}

export function startCalibration(): void {
  useGestureStore.getState().set({ calibration: { phase: "get-low", message: null, progress: 0 } });
}

export function cancelCalibration(): void {
  useGestureStore.getState().set({ calibration: { phase: "idle", message: null, progress: 0 } });
}
