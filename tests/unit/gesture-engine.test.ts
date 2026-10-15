import { describe, expect, it } from "vitest";
import { computeCalibration } from "@/lib/gesture/calibration";
import { DEFAULT_GESTURE_CONFIG, GestureEngine, validateGestureConfig, type GestureUpdate } from "@/lib/gesture/gesture-engine";
import { computeHandFeatures, type Landmark } from "@/lib/gesture/hand-features";

/**
 * Synthetic hand: palm centred at (cx, cy) in image coordinates (y down).
 * open=true extends all fingers upwards; open=false curls them into a fist.
 */
function hand(cy: number, open = true, cx = 0.5, scale = 0.18): Landmark[] {
  const s = scale;
  const lm: Landmark[] = new Array(21);
  const wrist = { x: cx, y: cy + s * 0.55 };
  lm[0] = wrist;
  // thumb
  lm[1] = { x: cx - s * 0.25, y: cy + s * 0.4 };
  lm[2] = { x: cx - s * 0.4, y: cy + s * 0.25 };
  lm[3] = { x: cx - s * 0.5, y: cy + s * 0.1 };
  lm[4] = open ? { x: cx - s * 0.62, y: cy - s * 0.05 } : { x: cx - s * 0.15, y: cy + s * 0.15 };
  const columns = [-0.22, -0.07, 0.08, 0.22];
  columns.forEach((dx, f) => {
    const base = 5 + f * 4;
    const x = cx + dx * s;
    const mcpY = cy;
    lm[base] = { x, y: mcpY }; // MCP
    if (open) {
      lm[base + 1] = { x, y: mcpY - s * 0.3 }; // PIP
      lm[base + 2] = { x, y: mcpY - s * 0.5 }; // DIP
      lm[base + 3] = { x, y: mcpY - s * 0.68 }; // TIP
    } else {
      lm[base + 1] = { x, y: mcpY - s * 0.18 };
      lm[base + 2] = { x, y: mcpY - s * 0.05 };
      lm[base + 3] = { x, y: mcpY + s * 0.08 }; // curled back towards palm
    }
  });
  return lm;
}

/** palm height h (0 bottom .. 1 top) → image y of the palm centre used by `hand` */
function yForHeight(h: number): number {
  // palm centre = mean(wrist, MCPs) = cy + s*0.55/5
  return 1 - h - 0.18 * 0.11;
}

function frame(t: number, h: number | null, opts: { open?: boolean; score?: number } = {}) {
  return {
    t,
    hands: h === null ? [] : [{ landmarks: hand(yForHeight(h), opts.open ?? true), score: opts.score ?? 0.95 }],
  };
}

function run(engine: GestureEngine, steps: Array<[number, number | null, { open?: boolean; score?: number }?]>): GestureUpdate[] {
  return steps.map(([t, h, o]) => engine.update(frame(t, h, o ?? {})));
}

function triggers(updates: GestureUpdate[]) {
  return updates.filter((u) => u.trigger).map((u) => u.trigger);
}

/** generate frames every `dt` ms from t0 to t1 at constant height */
function hold(t0: number, t1: number, h: number | null, o: { open?: boolean; score?: number } = {}, dt = 33) {
  const out: Array<[number, number | null, { open?: boolean; score?: number }]> = [];
  for (let t = t0; t <= t1; t += dt) out.push([t, h, o]);
  return out;
}

describe("hand features", () => {
  it("detects an open hand and its height", () => {
    const f = computeHandFeatures(hand(yForHeight(0.7)));
    expect(f).not.toBeNull();
    expect(f!.open).toBe(true);
    expect(f!.extendedFingers).toBe(4);
    expect(f!.height).toBeCloseTo(0.7, 2);
  });

  it("detects a fist as not open", () => {
    const f = computeHandFeatures(hand(0.5, false));
    expect(f!.open).toBe(false);
    expect(f!.extendedFingers).toBeLessThan(3);
  });

  it("rejects incomplete or invalid landmark sets", () => {
    expect(computeHandFeatures(hand(0.5).slice(0, 10))).toBeNull();
    const broken = hand(0.5);
    broken[8] = { x: Number.NaN, y: 0.2 };
    expect(computeHandFeatures(broken)).toBeNull();
  });
});

describe("GestureEngine debouncing", () => {
  it("triggers ON exactly once after the dwell time while the hand stays raised", () => {
    const e = new GestureEngine();
    const updates = run(e, hold(0, 3000, 0.8));
    expect(triggers(updates)).toEqual(["on"]);
    const first = updates.findIndex((u) => u.trigger === "on");
    // dwell 450 ms at ~33 ms/frame → no trigger before ~450 ms
    expect(updates[first]!.status).toBe("holding");
    expect(first * 33).toBeGreaterThanOrEqual(DEFAULT_GESTURE_CONFIG.dwellMs - 40);
  });

  it("never triggers per frame: a held hand produces a single command", () => {
    const e = new GestureEngine({ cooldownMs: 300 });
    const updates = run(e, hold(0, 10000, 0.85));
    expect(triggers(updates)).toEqual(["on"]);
  });

  it("does not trigger when the hand leaves the zone before the dwell time", () => {
    const e = new GestureEngine();
    const steps = [...hold(0, 300, 0.8), ...hold(333, 1500, 0.5)];
    expect(triggers(run(e, steps))).toEqual([]);
  });

  it("requires an open hand for ON", () => {
    const e = new GestureEngine();
    const updates = run(e, hold(0, 2000, 0.8, { open: false }));
    expect(triggers(updates)).toEqual([]);
    expect(updates.at(-1)!.status).toBe("not-open");
  });

  it("triggers OFF when lowered below the OFF threshold, then ON again after re-arming", () => {
    const e = new GestureEngine({ cooldownMs: 500 });
    const steps = [...hold(0, 1200, 0.8), ...hold(1233, 2600, 0.15), ...hold(2633, 4200, 0.82)];
    expect(triggers(run(e, steps))).toEqual(["on", "off", "on"]);
  });

  it("respects the cooldown between opposite gestures", () => {
    const e = new GestureEngine({ cooldownMs: 2000, smoothing: 1 });
    // ON at ~450 ms; drop immediately → OFF must wait until cooldown ends (~2450 ms)
    const updates = run(e, [...hold(0, 500, 0.8), ...hold(533, 3500, 0.1)]);
    const offIdx = updates.findIndex((u) => u.trigger === "off");
    const onIdx = updates.findIndex((u) => u.trigger === "on");
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(offIdx).toBeGreaterThan(onIdx);
    const tOn = onIdx * 33;
    const tOff = 533 + (offIdx - hold(0, 500, 0.8).length) * 33;
    expect(tOff - tOn).toBeGreaterThanOrEqual(2000);
  });

  it("does not infer gestures at low tracking confidence", () => {
    const e = new GestureEngine();
    const updates = run(e, hold(0, 2000, 0.85, { score: 0.3 }));
    expect(triggers(updates)).toEqual([]);
    expect(updates.every((u) => u.status === "low-confidence")).toBe(true);
  });

  it("restarts the dwell when confidence drops mid-gesture", () => {
    const e = new GestureEngine({ dwellMs: 450 });
    const steps = [...hold(0, 330, 0.8), [363, 0.8, { score: 0.2 }] as [number, number, { score: number }], ...hold(396, 700, 0.8)];
    const updates = run(e, steps);
    // the 330 ms before the drop must not count: 396 → 700 is only ~300 ms
    expect(triggers(updates)).toEqual([]);
  });

  it("resets when the hand disappears and does not assume a hand is visible", () => {
    const e = new GestureEngine();
    const updates = run(e, [...hold(0, 300, 0.8), ...hold(333, 1500, null)]);
    expect(triggers(updates)).toEqual([]);
    expect(updates.at(-1)!.status).toBe("no-hand");
  });

  it("ignores frame gaps (throttled tab) instead of counting them as dwell", () => {
    const e = new GestureEngine({ maxFrameGapMs: 300 });
    const updates = run(e, [[0, 0.8], [100, 0.8], [2000, 0.8], [2100, 0.8]]);
    expect(triggers(updates)).toEqual([]);
  });

  it("does not re-trigger ON after the hand drops out briefly and returns in the same zone", () => {
    const e = new GestureEngine({ lostResetMs: 600, cooldownMs: 300 });
    const steps = [...hold(0, 1000, 0.8), ...hold(1033, 1200, null), ...hold(1233, 2500, 0.8)];
    expect(triggers(run(e, steps))).toEqual(["on"]);
  });

  it("smooths jitter around the threshold (no flapping)", () => {
    const e = new GestureEngine({ cooldownMs: 300 });
    const steps: Array<[number, number]> = [];
    for (let i = 0; i < 120; i++) steps.push([i * 33, i % 2 ? 0.63 : 0.55]); // oscillates around ON=0.60
    const updates = run(e, steps);
    expect(triggers(updates).length).toBeLessThanOrEqual(1);
  });
});

describe("gesture configuration & calibration", () => {
  it("validates threshold ordering and gap", () => {
    expect(validateGestureConfig({ ...DEFAULT_GESTURE_CONFIG })).toBeNull();
    expect(validateGestureConfig({ ...DEFAULT_GESTURE_CONFIG, onThreshold: 0.4, offThreshold: 0.35 })).toMatch(/at least/);
    expect(() => new GestureEngine().configure({ onThreshold: 0.2, offThreshold: 0.5 })).toThrow();
  });

  it("computes thresholds at 30%/70% of the calibrated range", () => {
    const low = Array.from({ length: 12 }, (_, i) => 0.2 + (i % 3) * 0.01);
    const high = Array.from({ length: 12 }, (_, i) => 0.8 - (i % 3) * 0.01);
    const r = computeCalibration(low, high);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.offThreshold).toBeCloseTo(0.38, 2);
      expect(r.onThreshold).toBeCloseTo(0.62, 2);
    }
  });

  it("rejects calibration with too few samples or too small a range", () => {
    expect(computeCalibration([0.3], [0.7]).ok).toBe(false);
    const r = computeCalibration(new Array(10).fill(0.45), new Array(10).fill(0.55));
    expect(r.ok).toBe(false);
  });
});
