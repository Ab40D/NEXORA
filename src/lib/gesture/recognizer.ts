/**
 * Temporal recognizer for static hand poses (thumb up, fist, open palm, ...).
 *
 *  - A pose must be shown continuously for `holdMs` (time-based, so it works from ~1 fps up)
 *    and seen in at least `minFrames` frames before it triggers.
 *  - Each trigger fires exactly once: the same pose re-arms only after the hand has shown a
 *    different pose (or no hand) for `releaseMs`. Holding a pose never repeats a command.
 *  - Cooldowns: `cooldownMs` for the same pose, `globalCooldownMs` between any two triggers.
 *  - Quality gating: no inference when the hand is missing, too small, mostly out of frame or
 *    tracked with low confidence; an unclear pose is "no pose", never a guess.
 *  - Only poses in `active` can trigger (poses without a binding are shown but never fire).
 */
import { computeHandFeatures, pickPrimaryHand, type HandFeatures, type HandObservation } from "./hand-features";
import { classifyPose, MIN_POSE_SCORE, type Pose } from "./pose-classifier";

export interface RecognizerConfig {
  holdMs: number;
  minFrames: number;
  cooldownMs: number;
  globalCooldownMs: number;
  releaseMs: number;
  minConfidence: number;
  minPoseScore: number;
  minHandSize: number;
  minInFrame: number;
  /** frames further apart than this restart the hold (tab throttled, camera stalled) */
  maxFrameGapMs: number;
}

export const DEFAULT_RECOGNIZER_CONFIG: RecognizerConfig = {
  holdMs: 500,
  minFrames: 2,
  cooldownMs: 1200,
  globalCooldownMs: 700,
  releaseMs: 250,
  minConfidence: 0.5,
  minPoseScore: MIN_POSE_SCORE,
  minHandSize: 0.08,
  minInFrame: 0.7,
  maxFrameGapMs: 1200,
};

export type QualityIssue = "low-score" | "too-small" | "out-of-frame" | "invalid";
export type RecognizerStatus = "no-hand" | "low-quality" | "no-pose" | "unbound" | "holding" | "fired" | "cooldown";

export interface RecognizerUpdate {
  status: RecognizerStatus;
  pose: Pose | null;
  poseConfidence: number;
  trackerConfidence: number;
  /** progress of the current hold, 0..1 */
  progress: number;
  trigger: Pose | null;
  issue: QualityIssue | null;
  features: HandFeatures | null;
}

export interface RecognizerFrame {
  t: number;
  hands: HandObservation[];
  aspect?: number;
}

export class PoseRecognizer {
  private cfg: RecognizerConfig;
  private active: Set<Pose>;
  private lastFrameAt: number | null = null;
  private candidate: Pose | null = null;
  private candidateSince = 0;
  private candidateFrames = 0;
  private lastFired: { pose: Pose; at: number } | null = null;
  private armed = true;
  private releaseSince: number | null = null;
  private lastTriggerAt = -Infinity;

  constructor(active: Iterable<Pose>, cfg: Partial<RecognizerConfig> = {}) {
    this.cfg = { ...DEFAULT_RECOGNIZER_CONFIG, ...cfg };
    this.active = new Set(active);
  }

  get config(): RecognizerConfig {
    return this.cfg;
  }

  configure(active: Iterable<Pose>, cfg: Partial<RecognizerConfig> = {}): void {
    this.active = new Set(active);
    this.cfg = { ...this.cfg, ...cfg };
    this.resetCandidate();
  }

  /** Forget tracking state (camera restarted, tab hidden). Cooldowns are preserved. */
  reset(): void {
    this.lastFrameAt = null;
    this.resetCandidate();
    this.armed = true;
    this.releaseSince = null;
  }

  private resetCandidate(): void {
    this.candidate = null;
    this.candidateSince = 0;
    this.candidateFrames = 0;
  }

  /** Re-arm once the last fired pose has been absent for releaseMs. */
  private trackRelease(current: Pose | null, t: number): void {
    if (this.armed || !this.lastFired) return;
    if (current === this.lastFired.pose) {
      this.releaseSince = null;
      return;
    }
    if (this.releaseSince === null) this.releaseSince = t;
    if (t - this.releaseSince >= this.cfg.releaseMs) {
      this.armed = true;
      this.releaseSince = null;
    }
  }

  update(frame: RecognizerFrame): RecognizerUpdate {
    const { t } = frame;
    const cfg = this.cfg;
    const base: RecognizerUpdate = {
      status: "no-hand",
      pose: null,
      poseConfidence: 0,
      trackerConfidence: 0,
      progress: 0,
      trigger: null,
      issue: null,
      features: null,
    };
    if (this.lastFrameAt !== null && t - this.lastFrameAt > cfg.maxFrameGapMs) this.resetCandidate();
    this.lastFrameAt = t;

    const hand = pickPrimaryHand(frame.hands);
    if (!hand) {
      this.resetCandidate();
      this.trackRelease(null, t);
      return base;
    }
    const trackerConfidence = Number.isFinite(hand.score) ? hand.score : 0;
    const features = computeHandFeatures(hand.landmarks, frame.aspect);
    const issue: QualityIssue | null = !features
      ? "invalid"
      : trackerConfidence < cfg.minConfidence
        ? "low-score"
        : features.size < cfg.minHandSize
          ? "too-small"
          : features.inFrame < cfg.minInFrame
            ? "out-of-frame"
            : null;
    if (issue || !features) {
      this.resetCandidate(); // never carry a hold across frames we cannot trust
      return { ...base, status: "low-quality", trackerConfidence, issue, features };
    }

    const { pose, confidence } = classifyPose(features, cfg.minPoseScore);
    this.trackRelease(pose, t);
    const info = { ...base, pose, poseConfidence: confidence, trackerConfidence, features };
    if (!pose) {
      this.resetCandidate();
      return { ...info, status: "no-pose" };
    }
    if (!this.active.has(pose)) {
      this.resetCandidate();
      return { ...info, status: "unbound" };
    }
    if (!this.armed && this.lastFired?.pose === pose) {
      this.resetCandidate();
      return { ...info, status: "fired", progress: 1 };
    }
    const sameCooldown = this.lastFired?.pose === pose && t - this.lastFired.at < cfg.cooldownMs;
    if (t - this.lastTriggerAt < cfg.globalCooldownMs || sameCooldown) {
      this.resetCandidate();
      return { ...info, status: "cooldown" };
    }
    if (pose !== this.candidate) {
      this.candidate = pose;
      this.candidateSince = t;
      this.candidateFrames = 0;
    }
    this.candidateFrames++;
    const held = t - this.candidateSince;
    const progress = Math.min(1, held / cfg.holdMs);
    if (held >= cfg.holdMs && this.candidateFrames >= cfg.minFrames) {
      this.lastFired = { pose, at: t };
      this.lastTriggerAt = t;
      this.armed = false;
      this.releaseSince = null;
      this.resetCandidate();
      return { ...info, status: "fired", progress: 1, trigger: pose };
    }
    return { ...info, status: "holding", progress };
  }
}
