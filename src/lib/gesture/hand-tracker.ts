"use client";

/**
 * MediaPipe Hand Landmarker (runs fully in the browser via WASM, optionally WebGL).
 * The WASM runtime and the model are self-hosted from this deployment; frames never leave
 * the browser.
 *
 * Delegate choice ("auto"): the GPU delegate is only fast with real GPU acceleration. Linux
 * desktops often run WebGL on a software rasterizer (SwiftShader / llvmpipe) where the GPU
 * delegate measured ~2 fps versus ~25 fps on the CPU (XNNPACK) delegate, so software
 * renderers start on CPU. The camera runtime also switches GPU → CPU at runtime when frames
 * keep failing or the GPU path is too slow.
 */
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { isSoftwareRenderer, webglRenderer } from "./diagnostics";

export const WASM_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_WASM_BASE || "/mediapipe/wasm";
export const MODEL_URL = process.env.NEXT_PUBLIC_HAND_MODEL_URL || "/models/hand_landmarker.task";

export type Delegate = "GPU" | "CPU";
export type DelegatePreference = "auto" | Delegate;

export interface TrackerHandle {
  landmarker: HandLandmarker;
  delegate: Delegate;
  /** why this delegate was chosen (for diagnostics) */
  reason: "preferred" | "software-renderer" | "gpu-failed" | "fallback";
  loadMs: number;
}

const cache = new Map<Delegate, Promise<TrackerHandle>>();

async function createWith(delegate: Delegate, reason: TrackerHandle["reason"]): Promise<TrackerHandle> {
  const t0 = performance.now();
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  return { landmarker, delegate, reason, loadMs: Math.round(performance.now() - t0) };
}

function cached(delegate: Delegate, reason: TrackerHandle["reason"]): Promise<TrackerHandle> {
  let p = cache.get(delegate);
  if (!p) {
    p = createWith(delegate, reason).catch((err) => {
      cache.delete(delegate);
      throw err;
    });
    cache.set(delegate, p);
  }
  return p;
}

/** The delegate "auto" would pick on this browser. */
export function autoDelegate(): { delegate: Delegate; reason: TrackerHandle["reason"] } {
  return isSoftwareRenderer(webglRenderer()) ? { delegate: "CPU", reason: "software-renderer" } : { delegate: "GPU", reason: "preferred" };
}

/** Shared, lazily created tracker. A failed load can be retried. */
export async function getHandTracker(pref: DelegatePreference = "auto"): Promise<TrackerHandle> {
  const choice = pref === "auto" ? autoDelegate() : { delegate: pref, reason: "preferred" as const };
  if (choice.delegate === "CPU") return cached("CPU", choice.reason);
  try {
    return await cached("GPU", choice.reason);
  } catch (gpuErr) {
    console.warn("[se7enx] GPU delegate unavailable, falling back to CPU", gpuErr);
    return cached("CPU", "gpu-failed");
  }
}

/** Drop a broken tracker (e.g. lost WebGL context) and get a CPU one instead. */
export async function fallbackToCpu(broken: TrackerHandle): Promise<TrackerHandle> {
  if (broken.delegate === "GPU") {
    cache.delete("GPU");
    try {
      broken.landmarker.close();
    } catch {
      /* already unusable */
    }
  }
  return cached("CPU", "fallback");
}
