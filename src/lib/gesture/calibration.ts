import { MIN_THRESHOLD_GAP } from "./gesture-engine";

export const MIN_CALIBRATION_SAMPLES = 8;
export const MIN_CALIBRATION_RANGE = 0.2;

/** machine-readable failure reason (localized in the UI) */
export type CalibrationFailure = "few_samples" | "invalid" | "too_close" | "too_narrow";

export type CalibrationResult =
  | { ok: true; onThreshold: number; offThreshold: number; low: number; high: number }
  | { ok: false; reason: string; code: CalibrationFailure };

export function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Derive ON/OFF thresholds from palm heights sampled while the user held the
 * hand LOW and then HIGH. Thresholds sit at 30 % / 70 % of the user's range.
 */
export function computeCalibration(lowSamples: number[], highSamples: number[]): CalibrationResult {
  if (lowSamples.length < MIN_CALIBRATION_SAMPLES || highSamples.length < MIN_CALIBRATION_SAMPLES) {
    return { ok: false, code: "few_samples", reason: "Not enough tracked frames. Keep your open hand visible during each step." };
  }
  const low = median(lowSamples);
  const high = median(highSamples);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { ok: false, code: "invalid", reason: "Invalid samples." };
  const range = high - low;
  if (range < MIN_CALIBRATION_RANGE) {
    return {
      ok: false,
      code: "too_close",
      reason: "Your low and high positions are too close. Move your hand further down and higher up.",
    };
  }
  let off = low + range * 0.3;
  let on = low + range * 0.7;
  off = Math.min(0.85, Math.max(0.08, off));
  on = Math.min(0.92, Math.max(0.15, on));
  if (on - off < MIN_THRESHOLD_GAP) {
    return { ok: false, code: "too_narrow", reason: "Calibrated range is too narrow for reliable detection. Try again with larger movements." };
  }
  return { ok: true, onThreshold: round2(on), offThreshold: round2(off), low: round2(low), high: round2(high) };
}
