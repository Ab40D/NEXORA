"use client";

/**
 * MediaPipe Hand Landmarker (runs fully in the browser via WASM/WebGL).
 * The WASM runtime and the model are self-hosted from this deployment.
 */
import type { HandLandmarker } from "@mediapipe/tasks-vision";

export const WASM_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_WASM_BASE || "/mediapipe/wasm";
export const MODEL_URL = process.env.NEXT_PUBLIC_HAND_MODEL_URL || "/models/hand_landmarker.task";

export interface TrackerHandle {
  landmarker: HandLandmarker;
  delegate: "GPU" | "CPU";
}

let pending: Promise<TrackerHandle> | null = null;

async function create(): Promise<TrackerHandle> {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO" as const,
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  try {
    const landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
    return { landmarker, delegate: "GPU" };
  } catch (gpuErr) {
    console.warn("[se7enx] GPU delegate unavailable, falling back to CPU", gpuErr);
    const landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
    return { landmarker, delegate: "CPU" };
  }
}

/** Shared, lazily created tracker. A failed load can be retried. */
export function getHandTracker(): Promise<TrackerHandle> {
  if (!pending) {
    pending = create().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}
