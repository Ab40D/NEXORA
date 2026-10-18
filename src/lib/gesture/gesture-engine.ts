/**
 * Debounced hand-height gesture recognizer.
 *
 *   raise an OPEN hand above `onThreshold`  and hold for `dwellMs` → "on"
 *   lower the hand below   `offThreshold`   and hold for `dwellMs` → "off"
 *
 * Stability measures:
 *  - separate ON/OFF thresholds with a neutral band in between (hysteresis)
 *  - exponential smoothing of the palm height
 *  - dwell time: the condition must hold continuously before triggering
 *  - cooldown after every trigger
 *  - re-arm: after triggering, the hand must leave the zone (by `rearmMargin`)
 *    or disappear before the same gesture can fire again → no repeats per frame
 *  - confidence gating: no inference while the hand is missing, too small,
 *    partially out of frame, or tracked with low confidence
 */
import { computeHandFeatures, pickPrimaryHand, type HandObservation } from "./hand-features";

export interface GestureConfig {
  onThreshold: number;
  offThreshold: number;
  dwellMs: number;
  cooldownMs: number;
  /** EMA factor 0..1 — higher reacts faster, lower is smoother */
  smoothing: number;
  minConfidence: number;
  /** min hand bounding-box height (fraction of frame) */
  minHandSize: number;
  /** min fraction of landmarks inside the frame */
  minInFrame: number;
  requireOpenForOff: boolean;
  /** frames further apart than this reset smoothing and dwell */
  maxFrameGapMs: number;
  rearmMargin: number;
  /** hand must be absent this long before both gestures re-arm */
  lostResetMs: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  onThreshold: 0.6,
  offThreshold: 0.3,
  dwellMs: 450,
  cooldownMs: 1500,
  smoothing: 0.35,
  minConfidence: 0.6,
  minHandSize: 0.1,
  // 0.6: a raised hand often has its fingertips above the frame; the palm decides the height.
  minInFrame: 0.6,
  requireOpenForOff: true,
  // 1000 ms: still works at ~1-2 fps (software WebGL, busy phones). 300 ms made every frame on a
  // 2 fps stream reset the dwell, so gestures could never trigger there.
  maxFrameGapMs: 1000,
  rearmMargin: 0.05,
  lostResetMs: 600,
};

export const MIN_THRESHOLD_GAP = 0.1;

export type GestureStatus =
  | "no-hand"
  | "low-confidence"
  | "not-open"
  | "neutral"
  | "arming-on"
  | "arming-off"
  | "holding"
  | "cooldown";

export type GestureZone = "on" | "off" | "neutral";

export interface GestureUpdate {
  status: GestureStatus;
  zone: GestureZone | null;
  rawHeight: number | null;
  height: number | null;
  progress: number;
  open: boolean;
  extendedFingers: number;
  confidence: number;
  trigger: "on" | "off" | null;
  cooldownRemainingMs: number;
}

export interface HandFrame {
  /** timestamp in ms (monotonic) */
  t: number;
  hands: HandObservation[];
  /** video width / height (landmarks are normalized per axis) */
  aspect?: number;
}

export function validateGestureConfig(cfg: GestureConfig): string | null {
  const inRange = (v: number) => Number.isFinite(v) && v > 0 && v < 1;
  if (!inRange(cfg.onThreshold) || !inRange(cfg.offThreshold)) return "Thresholds must be between 0 and 1.";
  if (cfg.onThreshold - cfg.offThreshold < MIN_THRESHOLD_GAP) {
    return `The ON threshold must be at least ${Math.round(MIN_THRESHOLD_GAP * 100)}% above the OFF threshold.`;
  }
  if (cfg.dwellMs < 100 || cfg.dwellMs > 3000) return "Hold time must be between 100 and 3000 ms.";
  if (cfg.cooldownMs < 300 || cfg.cooldownMs > 10000) return "Cooldown must be between 300 and 10000 ms.";
  if (!(cfg.smoothing > 0 && cfg.smoothing <= 1)) return "Smoothing must be in (0, 1].";
  return null;
}

export class GestureEngine {
  private cfg: GestureConfig;
  private ema: number | null = null;
  private lastFrameAt: number | null = null;
  private lostSince: number | null = null;
  private zone: GestureZone | null = null;
  private qualifiedSince: number | null = null;
  private armedOn = true;
  private armedOff = true;
  private cooldownUntil = 0;

  constructor(cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE_CONFIG, ...cfg };
  }

  get config(): GestureConfig {
    return this.cfg;
  }

  configure(cfg: Partial<GestureConfig>): void {
    const next = { ...this.cfg, ...cfg };
    const err = validateGestureConfig(next);
    if (err) throw new Error(err);
    this.cfg = next;
    this.qualifiedSince = null;
  }

  /** Forget all tracking state (e.g. camera restarted). Cooldown is preserved. */
  reset(): void {
    this.ema = null;
    this.lastFrameAt = null;
    this.lostSince = null;
    this.zone = null;
    this.qualifiedSince = null;
    this.armedOn = true;
    this.armedOff = true;
  }

  private idle(status: GestureStatus, t: number, extra: Partial<GestureUpdate> = {}): GestureUpdate {
    return {
      status,
      zone: null,
      rawHeight: null,
      height: this.ema,
      progress: 0,
      open: false,
      extendedFingers: 0,
      confidence: 0,
      trigger: null,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - t),
      ...extra,
    };
  }

  update(frame: HandFrame): GestureUpdate {
    const { t } = frame;
    const cfg = this.cfg;

    // Stale stream (tab throttled, camera hiccup): never carry dwell across gaps.
    if (this.lastFrameAt !== null && t - this.lastFrameAt > cfg.maxFrameGapMs) {
      this.ema = null;
      this.qualifiedSince = null;
      this.zone = null;
    }
    this.lastFrameAt = t;

    const hand = pickPrimaryHand(frame.hands);
    if (!hand) {
      this.qualifiedSince = null;
      if (this.lostSince === null) this.lostSince = t;
      if (t - this.lostSince >= cfg.lostResetMs) {
        this.ema = null;
        this.zone = null;
        this.armedOn = true;
        this.armedOff = true;
      }
      return this.idle("no-hand", t);
    }
    this.lostSince = null;

    const features = computeHandFeatures(hand.landmarks, frame.aspect);
    const confidence = Number.isFinite(hand.score) ? hand.score : 0;
    if (
      !features ||
      confidence < cfg.minConfidence ||
      features.size < cfg.minHandSize ||
      features.inFrame < cfg.minInFrame
    ) {
      // Insufficient tracking quality: do not infer anything, restart dwell.
      this.qualifiedSince = null;
      return this.idle("low-confidence", t, {
        confidence,
        rawHeight: features?.height ?? null,
        open: features?.open ?? false,
        extendedFingers: features?.extendedFingers ?? 0,
      });
    }

    const raw = features.height;
    this.ema = this.ema === null ? raw : this.ema + cfg.smoothing * (raw - this.ema);
    const h = this.ema;

    // Re-arm once the hand has clearly left the zone it last triggered in.
    if (!this.armedOn && h < cfg.onThreshold - cfg.rearmMargin) this.armedOn = true;
    if (!this.armedOff && h > cfg.offThreshold + cfg.rearmMargin) this.armedOff = true;

    const zone: GestureZone = h >= cfg.onThreshold ? "on" : h <= cfg.offThreshold ? "off" : "neutral";
    if (zone !== this.zone) {
      this.zone = zone;
      this.qualifiedSince = null;
    }

    const base = {
      zone,
      rawHeight: raw,
      height: h,
      open: features.open,
      extendedFingers: features.extendedFingers,
      confidence,
      trigger: null as "on" | "off" | null,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - t),
      progress: 0,
    };

    if (zone === "neutral") {
      this.qualifiedSince = null;
      return { ...base, status: t < this.cooldownUntil ? "cooldown" : "neutral" };
    }

    const armed = zone === "on" ? this.armedOn : this.armedOff;
    const needsOpen = zone === "on" || cfg.requireOpenForOff;

    if (!armed) {
      this.qualifiedSince = null;
      return { ...base, status: "holding" };
    }
    if (needsOpen && !features.open) {
      this.qualifiedSince = null;
      return { ...base, status: "not-open" };
    }
    if (t < this.cooldownUntil) {
      this.qualifiedSince = null;
      return { ...base, status: "cooldown" };
    }

    if (this.qualifiedSince === null) this.qualifiedSince = t;
    const held = t - this.qualifiedSince;
    const progress = Math.min(1, held / cfg.dwellMs);

    if (held >= cfg.dwellMs) {
      this.qualifiedSince = null;
      this.cooldownUntil = t + cfg.cooldownMs;
      if (zone === "on") {
        this.armedOn = false;
        this.armedOff = true;
      } else {
        this.armedOff = false;
        this.armedOn = true;
      }
      return { ...base, status: "holding", progress: 1, trigger: zone, cooldownRemainingMs: cfg.cooldownMs };
    }

    return { ...base, status: zone === "on" ? "arming-on" : "arming-off", progress };
  }
}
