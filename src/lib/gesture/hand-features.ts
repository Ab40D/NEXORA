/**
 * Geometric features computed from MediaPipe hand landmarks (21 points,
 * normalized image coordinates: x,y in [0,1], y grows downwards).
 *
 * Landmark indices: 0 wrist · 1-4 thumb · 5-8 index · 9-12 middle ·
 * 13-16 ring · 17-20 pinky  (MCP, PIP, DIP, TIP per finger).
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

export interface HandFeatures {
  /** palm centre height in the frame: 0 = bottom edge, 1 = top edge */
  height: number;
  /** number of extended fingers among index, middle, ring, pinky (0..4) */
  extendedFingers: number;
  thumbExtended: boolean;
  open: boolean;
  /** bounding box height relative to frame height */
  size: number;
  /** fraction of landmarks inside the frame */
  inFrame: number;
}

const WRIST = 0;
const PALM = [0, 5, 9, 13, 17];
const FINGERS: Array<{ mcp: number; pip: number; tip: number }> = [
  { mcp: 5, pip: 6, tip: 8 },
  { mcp: 9, pip: 10, tip: 12 },
  { mcp: 13, pip: 14, tip: 16 },
  { mcp: 17, pip: 18, tip: 20 },
];

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFiniteLandmark(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

/** Returns null if the landmark set is incomplete or invalid. */
export function computeHandFeatures(landmarks: Landmark[]): HandFeatures | null {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  for (let i = 0; i < 21; i++) if (!isFiniteLandmark(landmarks[i])) return null;
  const lm = landmarks as Required<Landmark>[];
  const wrist = lm[WRIST]!;

  let px = 0;
  let py = 0;
  for (const i of PALM) {
    px += lm[i]!.x;
    py += lm[i]!.y;
  }
  py /= PALM.length;
  px /= PALM.length;
  void px;

  let extended = 0;
  for (const f of FINGERS) {
    const tip = lm[f.tip]!;
    const pip = lm[f.pip]!;
    const mcp = lm[f.mcp]!;
    // Finger is extended when its tip is clearly farther from the wrist than its PIP joint
    // and the finger segment is not folded back towards the palm.
    if (dist(wrist, tip) > dist(wrist, pip) * 1.12 && dist(tip, mcp) > dist(pip, mcp) * 1.25) extended++;
  }

  const thumbTip = lm[4]!;
  const thumbIp = lm[3]!;
  const indexMcp = lm[5]!;
  const pinkyMcp = lm[17]!;
  const thumbExtended = dist(thumbTip, pinkyMcp) > dist(thumbIp, pinkyMcp) * 1.05 && dist(thumbTip, indexMcp) > dist(indexMcp, pinkyMcp) * 0.45;

  let minY = Infinity;
  let maxY = -Infinity;
  let inside = 0;
  for (let i = 0; i < 21; i++) {
    const p = lm[i]!;
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) inside++;
  }

  return {
    height: 1 - py,
    extendedFingers: extended,
    thumbExtended,
    open: extended >= 4 || (extended >= 3 && thumbExtended),
    size: maxY - minY,
    inFrame: inside / 21,
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
