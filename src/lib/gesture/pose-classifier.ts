/**
 * Static hand-pose classification from geometric features (no extra ML model).
 *
 * Each pose is a fuzzy AND (minimum) of finger memberships, so the score says how clearly
 * the pose is shown. Poses that are not shown clearly enough return `pose: null`: the
 * recognizer never guesses.
 */
import { ramp, type HandFeatures } from "./hand-features";

export const POSES = ["open_palm", "fist", "thumb_up", "thumb_down", "pointing_up", "victory"] as const;
export type Pose = (typeof POSES)[number];

export interface PoseResult {
  pose: Pose | null;
  confidence: number;
  scores: Record<Pose, number>;
}

export const MIN_POSE_SCORE = 0.6;

/** 1 when the direction is within `tol` degrees of image-up, 0 beyond tol+20. */
function up(angleDeg: number, tol = 50): number {
  return ramp(Math.abs(angleDeg), tol + 20, tol);
}
function down(angleDeg: number, tol = 50): number {
  return ramp(180 - Math.abs(angleDeg), tol + 20, tol);
}

export function classifyPose(f: HandFeatures, minScore = MIN_POSE_SCORE): PoseResult {
  const E = f.extension;
  const C = { thumb: 1 - E.thumb, index: 1 - E.index, middle: 1 - E.middle, ring: 1 - E.ring, pinky: 1 - E.pinky };
  const fourCurled = Math.min(C.index, C.middle, C.ring, C.pinky);
  const scores: Record<Pose, number> = {
    open_palm: Math.min(E.index, E.middle, E.ring, E.pinky),
    victory: Math.min(E.index, E.middle, C.ring, C.pinky),
    pointing_up: Math.min(E.index, C.middle, C.ring, C.pinky, up(f.indexAngle, 45)),
    thumb_up: Math.min(fourCurled, E.thumb, up(f.thumbAngle)),
    thumb_down: Math.min(fourCurled, E.thumb, down(f.thumbAngle)),
    fist: Math.min(fourCurled, C.thumb),
  };
  let best: Pose | null = null;
  let bestScore = 0;
  for (const p of POSES) {
    if (scores[p] > bestScore) {
      best = p;
      bestScore = scores[p];
    }
  }
  return bestScore >= minScore ? { pose: best, confidence: bestScore, scores } : { pose: null, confidence: bestScore, scores };
}
