"use client";

import { create } from "zustand";
import type { OnOff } from "@/lib/state/types";
import type { GestureUpdate } from "./gesture-engine";

export type CameraStatus = "off" | "requesting" | "starting" | "loading-model" | "running" | "error";
export type CalibrationPhase = "idle" | "get-low" | "low" | "get-high" | "high" | "done" | "failed";

export interface GestureTriggerFeedback {
  value: OnOff;
  at: number;
  ok: boolean;
  message: string;
}

interface GestureStore {
  cameraStatus: CameraStatus;
  error: { code: string; message: string } | null;
  stream: MediaStream | null;
  /** whether detected gestures are dispatched as light commands */
  gesturesEnabled: boolean;
  update: GestureUpdate | null;
  fps: number;
  delegate: "GPU" | "CPU" | null;
  lastTrigger: GestureTriggerFeedback | null;
  calibration: { phase: CalibrationPhase; message: string | null; progress: number };
  previewLarge: boolean;
  set: (patch: Partial<Omit<GestureStore, "set">>) => void;
}

export const useGestureStore = create<GestureStore>((set) => ({
  cameraStatus: "off",
  error: null,
  stream: null,
  gesturesEnabled: true,
  update: null,
  fps: 0,
  delegate: null,
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

/**
 * Request the camera. MUST be called from an explicit user action
 * ("Enable camera"). Video frames stay in the browser — they are processed
 * locally by MediaPipe and never uploaded.
 */
export async function startCamera(): Promise<void> {
  const store = useGestureStore.getState();
  if (store.stream || store.cameraStatus === "requesting") return;
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    store.set({
      cameraStatus: "error",
      error: { code: "unsupported", message: "This browser does not provide camera access (a secure HTTPS context and a modern browser are required)." },
    });
    return;
  }
  if (!window.isSecureContext) {
    store.set({ cameraStatus: "error", error: { code: "insecure", message: "Camera access requires HTTPS (or localhost)." } });
    return;
  }
  store.set({ cameraStatus: "requesting", error: null });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    });
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      const s = useGestureStore.getState();
      if (s.stream === stream) {
        s.set({ stream: null, cameraStatus: "error", update: null, error: { code: "ended", message: "The camera was disconnected or stopped by the system." } });
      }
    });
    useGestureStore.getState().set({ stream, cameraStatus: "starting" });
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
  set({ stream: null, cameraStatus: "off", update: null, fps: 0, calibration: { phase: "idle", message: null, progress: 0 } });
}

export function startCalibration(): void {
  useGestureStore.getState().set({ calibration: { phase: "get-low", message: null, progress: 0 } });
}

export function cancelCalibration(): void {
  useGestureStore.getState().set({ calibration: { phase: "idle", message: null, progress: 0 } });
}
