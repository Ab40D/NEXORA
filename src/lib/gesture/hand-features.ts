/**
 * Geometric features computed from MediaPipe hand landmarks (21 points,
 * normalized image coordinates: x,y in [0,1], y grows downwards, z = relative depth
 * on roughly the same scale as x).
 *
 * Landmark indices: 0 wrist · 1-4 thumb · 5-8 index · 9-12 middle ·
 * 13-16 ring · 17-20 pinky  (CMC/MCP, PIP/MCP, DIP/IP, TIP per finger).
 *
 * Finger extension combines two rotation-invariant cues, measured on real MediaPipe output
 * (src/lib/gesture/__fixtures__/poses.json):
 *   - curl: sum of the bend angles at the PIP and DIP joints (straight ≈ 5-15°, curled ≥ 120°)
 *   - reach: distance tip→wrist divided by MCP→wrist (straight ≈ 1.8-1.9, curled ≤ 0.95)
 * Coordinates are aspect-corrected first (x and z are scaled by width/height), otherwise
 * angles are distorted on 16:9 cameras.
 */

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export interface HandObservation {
  landmarks: Landmark[];
  /** handedness classification score from the tracker (0..1) */
  score: number;
  handedness?: string;
}

export const FINGERS = ["thumb", "index", "middle", "ring", "pinky"] as const;
export type FingerName = (typeof FINGERS)[number];

export interface HandFeatures {
  /** palm centre height in the frame: 0 = bottom edge, 1 = top edge */
  height: number;
  /** palm centre x in the (unmirrored) camera image: 0 = left, 1 = right */
  x: number;
  /** number of extended fingers among index, middle, ring, pinky (0..4) */
  extendedFingers: number;
  thumbExtended: boolean;
  open: boolean;
  /** bounding box height relative to frame height */
  size: number;
  /** fraction of landmarks inside the frame */
  inFrame: number;
  /** per-finger extension score: 0 = fully curled … 1 = straight */
  extension: Record<FingerName, number>;
  /** thumb direction (MCP→tip) in degrees from image-up: 0 = up, ±180 = down */
  thumbAngle: number;
  /** index finger direction (MCP→tip) in degrees from image-up */
  indexAngle: number;
}

const PALM = [0, 5, 9, 13, 17];
const CHAINS: Record<FingerName, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};
export const EXTENDED_AT = 0.6;
export const CURLED_AT = 0.4;

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
function angle(u: V3, v: V3): number {
  const d = len(u) * len(v);
  if (d < 1e-9) return 0;
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / d;
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}
/** Linear ramp: 0 at `from`, 1 at `to` (works in both directions), clamped. */
export function ramp(v: number, from: number, to: number): number {
  const t = (v - from) / (to - from);
  return Math.max(0, Math.min(1, t));
}
/** Degrees from image-up of the 2D direction a→b (y grows downwards). */
function upAngle(a: V3, b: V3): number {
  return (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
}

function isFiniteLandmark(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

/**
 * Returns null if the landmark set is incomplete or invalid.
 * @param aspect video width / height (landmarks are normalized per axis)
 */
export function computeHandFeatures(landmarks: Landmark[], aspect = 4 / 3): HandFeatures | null {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  for (let i = 0; i < 21; i++) if (!isFiniteLandmark(landmarks[i])) return null;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const p: V3[] = landmarks.slice(0, 21).map((l) => [l.x * a, l.y, (Number.isFinite(l.z) ? l.z! : 0) * a]);
  const P = (i: number): V3 => p[i]!;
  const wrist = P(0);

  const extension = {} as Record<FingerName, number>;
  for (const name of FINGERS) {
    const [m, j1, j2, tip] = CHAINS[name];
    const M = P(m);
    const A = P(j1);
    const B = P(j2);
    const T = P(tip);
    const curl = angle(sub(A, M), sub(B, A)) + angle(sub(B, A), sub(T, B));
    if (name === "thumb") {
      // The thumb's base sits next to the wrist, so "reach" is not informative; use the distance
      // of the tip from the index knuckle, relative to the palm width.
      const palmWidth = len(sub(P(5), P(17))) || len(sub(P(0), P(9))) * 0.6 || 1e-6;
      const spread = len(sub(T, P(5))) / palmWidth;
      extension.thumb = 0.5 * ramp(curl, 70, 30) + 0.5 * ramp(spread, 0.6, 1.0);
    } else {
      const reach = len(sub(T, wrist)) / (len(sub(M, wrist)) || 1e-6);
      extension[name] = 0.5 * ramp(curl, 110, 40) + 0.5 * ramp(reach, 1.1, 1.5);
    }
  }

  let px = 0;
  let py = 0;
  for (const i of PALM) {
    px += landmarks[i]!.x;
    py += landmarks[i]!.y;
  }
  px /= PALM.length;
  py /= PALM.length;

  let minY = Infinity;
  let maxY = -Infinity;
  let inside = 0;
  for (let i = 0; i < 21; i++) {
    const l = landmarks[i]!;
    minY = Math.min(minY, l.y);
    maxY = Math.max(maxY, l.y);
    if (l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1) inside++;
  }

  const four: FingerName[] = ["index", "middle", "ring", "pinky"];
  const extendedFingers = four.filter((f) => extension[f] >= EXTENDED_AT).length;
  const thumbExtended = extension.thumb >= EXTENDED_AT;
  return {
    height: 1 - py,
    x: px,
    extendedFingers,
    thumbExtended,
    open: extendedFingers >= 4 || (extendedFingers >= 3 && thumbExtended),
    size: maxY - minY,
    inFrame: inside / 21,
    extension,
    thumbAngle: upAngle(P(2), P(4)),
    indexAngle: upAngle(P(5), P(8)),
  };
}

/** Choose the most confident hand observation. */
export function pickPrimaryHand(hands: HandObservation[]): HandObservation | null {
  let best: HandObservation | null = null;
  for (const h of hands) {
    if (!best || h.score > best.score) best = h;
  }
  return best;
}
