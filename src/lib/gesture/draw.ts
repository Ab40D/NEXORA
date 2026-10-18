import type { GestureUpdate } from "./gesture-engine";
import type { Landmark } from "./hand-features";
import type { RecognizerUpdate } from "./recognizer";

const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface OverlayOptions {
  onThreshold: number;
  offThreshold: number;
  showLandmarks: boolean;
  /** mirror x so the overlay matches a selfie-mirrored video */
  mirror: boolean;
  dpr: number;
}

/** Draw thresholds, hand skeleton and dwell progress on the preview canvas. */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hands: Landmark[][],
  update: GestureUpdate | null,
  opts: OverlayOptions,
): void {
  const { dpr } = opts;
  ctx.clearRect(0, 0, width, height);
  const yOn = (1 - opts.onThreshold) * height;
  const yOff = (1 - opts.offThreshold) * height;

  // zones
  ctx.fillStyle = update?.zone === "on" ? "rgba(56,217,245,0.16)" : "rgba(56,217,245,0.06)";
  ctx.fillRect(0, 0, width, yOn);
  ctx.fillStyle = update?.zone === "off" ? "rgba(245,184,75,0.16)" : "rgba(245,184,75,0.05)";
  ctx.fillRect(0, yOff, width, height - yOff);

  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([6 * dpr, 6 * dpr]);
  ctx.strokeStyle = "rgba(56,217,245,0.9)";
  ctx.beginPath();
  ctx.moveTo(0, yOn);
  ctx.lineTo(width, yOn);
  ctx.stroke();
  ctx.strokeStyle = "rgba(245,184,75,0.9)";
  ctx.beginPath();
  ctx.moveTo(0, yOff);
  ctx.lineTo(width, yOff);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `600 ${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(56,217,245,0.95)";
  ctx.fillText("ON ▲", 8 * dpr, yOn - 6 * dpr);
  ctx.fillStyle = "rgba(245,184,75,0.95)";
  ctx.fillText("OFF ▼", 8 * dpr, yOff + 16 * dpr);

  if (!opts.showLandmarks) return;

  const px = (l: Landmark) => (opts.mirror ? 1 - l.x : l.x) * width;
  const py = (l: Landmark) => l.y * height;
  const lowConf = update?.status === "low-confidence";

  for (const lm of hands) {
    if (lm.length < 21) continue;
    ctx.strokeStyle = lowConf ? "rgba(133,147,166,0.7)" : "rgba(230,250,255,0.85)";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const la = lm[a];
      const lb = lm[b];
      if (!la || !lb) continue;
      ctx.moveTo(px(la), py(la));
      ctx.lineTo(px(lb), py(lb));
    }
    ctx.stroke();
    ctx.fillStyle = lowConf ? "rgba(133,147,166,0.9)" : "rgba(56,217,245,1)";
    for (const l of lm) {
      ctx.beginPath();
      ctx.arc(px(l), py(l), 2.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // palm centre + dwell progress
    if (update && update.height !== null) {
      const cx = ([0, 5, 9, 13, 17].reduce((s, i) => s + px(lm[i]!), 0) / 5);
      const cy = (1 - update.height) * height;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 16 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      if (update.progress > 0) {
        ctx.strokeStyle = update.zone === "off" ? "rgba(245,184,75,1)" : "rgba(56,217,245,1)";
        ctx.beginPath();
        ctx.arc(cx, cy, 16 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * update.progress);
        ctx.stroke();
      }
    }
  }
}

export interface PoseOverlayOptions {
  showLandmarks: boolean;
  mirror: boolean;
  dpr: number;
}

/** Hand skeleton + hold progress for the static-pose profiles. */
export function drawPoseOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hands: Landmark[][],
  update: RecognizerUpdate | null,
  opts: PoseOverlayOptions,
): void {
  const { dpr } = opts;
  ctx.clearRect(0, 0, width, height);
  if (!opts.showLandmarks) return;
  const px = (l: Landmark) => (opts.mirror ? 1 - l.x : l.x) * width;
  const py = (l: Landmark) => l.y * height;
  const good = update?.status === "holding" || update?.status === "fired";
  const weak = update?.status === "low-quality" || update?.status === "no-pose";
  for (const lm of hands) {
    if (lm.length < 21) continue;
    ctx.strokeStyle = weak ? "rgba(150,150,150,0.65)" : good ? "rgba(255,255,255,0.95)" : "rgba(220,220,220,0.8)";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const la = lm[a];
      const lb = lm[b];
      if (!la || !lb) continue;
      ctx.moveTo(px(la), py(la));
      ctx.lineTo(px(lb), py(lb));
    }
    ctx.stroke();
    ctx.fillStyle = weak ? "rgba(150,150,150,0.9)" : "rgba(255,255,255,1)";
    for (const l of lm) {
      ctx.beginPath();
      ctx.arc(px(l), py(l), 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (update && update.progress > 0) {
      const cx = [0, 5, 9, 13, 17].reduce((s, i) => s + px(lm[i]!), 0) / 5;
      const cy = [0, 5, 9, 13, 17].reduce((s, i) => s + py(lm[i]!), 0) / 5;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 18 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = update.status === "fired" ? "rgba(74,222,128,1)" : "rgba(255,255,255,1)";
      ctx.beginPath();
      ctx.arc(cx, cy, 18 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * update.progress);
      ctx.stroke();
    }
  }
}
