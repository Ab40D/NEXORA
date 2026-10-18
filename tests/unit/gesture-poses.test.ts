import { beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "@/lib/gesture/__fixtures__/poses.json";
import { computeHandFeatures, type Landmark } from "@/lib/gesture/hand-features";
import { classifyPose, type Pose } from "@/lib/gesture/pose-classifier";
import { BUILTIN_PROFILES, GestureProfileSchema, validateProfile, type GestureProfile } from "@/lib/gesture/profiles";
import { PoseRecognizer } from "@/lib/gesture/recognizer";

type Frame = { pose: string; landmarks: number[][]; score: number };
const FRAMES = (fixtures as { aspect: number; frames: Frame[] }).frames;
const ASPECT = (fixtures as { aspect: number }).aspect;

const toLm = (pts: number[][]): Landmark[] => pts.map(([x, y, z]) => ({ x: x!, y: y!, z: z! }));
const mirror = (lm: Landmark[]): Landmark[] => lm.map((p) => ({ ...p, x: 1 - p.x }));
/** rotate around the wrist in aspect-corrected space by `deg` degrees */
function rotate(lm: Landmark[], deg: number, aspect = ASPECT): Landmark[] {
  const r = (deg * Math.PI) / 180;
  const w = lm[0]!;
  return lm.map((p) => {
    const dx = (p.x - w.x) * aspect;
    const dy = p.y - w.y;
    return { ...p, x: w.x + (dx * Math.cos(r) - dy * Math.sin(r)) / aspect, y: w.y + dx * Math.sin(r) + dy * Math.cos(r) };
  });
}
function scale(lm: Landmark[], k: number): Landmark[] {
  const w = lm[0]!;
  return lm.map((p) => ({ x: w.x + (p.x - w.x) * k, y: w.y + (p.y - w.y) * k, z: (p.z ?? 0) * k }));
}
function sample(pose: Pose): Landmark[] {
  const f = FRAMES.find((x) => x.pose === pose);
  if (!f) throw new Error(`no fixture for ${pose}`);
  return toLm(f.landmarks);
}

describe("pose classifier on real MediaPipe landmarks", () => {
  it("classifies every captured frame correctly with high confidence", () => {
    expect(FRAMES.length).toBeGreaterThanOrEqual(16);
    for (const f of FRAMES) {
      const feat = computeHandFeatures(toLm(f.landmarks), ASPECT)!;
      const r = classifyPose(feat);
      expect(r.pose, `frame of ${f.pose}`).toBe(f.pose);
      expect(r.confidence).toBeGreaterThan(0.8);
    }
  });

  it("is independent of handedness / mirroring", () => {
    for (const p of ["open_palm", "fist", "thumb_up", "victory"] as Pose[]) {
      expect(classifyPose(computeHandFeatures(mirror(sample(p)), ASPECT)!).pose).toBe(p);
    }
  });

  it("tolerates moderate tilt and distance changes", () => {
    for (const p of ["open_palm", "fist", "victory"] as Pose[]) {
      for (const deg of [-25, 25]) expect(classifyPose(computeHandFeatures(rotate(sample(p), deg), ASPECT)!).pose).toBe(p);
      for (const k of [0.6, 1.4]) expect(classifyPose(computeHandFeatures(scale(sample(p), k), ASPECT)!).pose).toBe(p);
    }
    // a thumb tilted 25° is still "up"
    expect(classifyPose(computeHandFeatures(rotate(sample("thumb_up"), 25), ASPECT)!).pose).toBe("thumb_up");
  });

  it("derives thumb down from an upside-down thumb up", () => {
    const down = rotate(sample("thumb_up"), 180);
    expect(classifyPose(computeHandFeatures(down, ASPECT)!).pose).toBe("thumb_down");
  });

  it("does not guess when the hand is turned sideways (thumb horizontal)", () => {
    const sideways = rotate(sample("thumb_up"), 90);
    const r = classifyPose(computeHandFeatures(sideways, ASPECT)!);
    expect(r.pose).not.toBe("thumb_up");
    expect(r.pose).not.toBe("thumb_down");
  });

  it("keeps the legacy open/closed features consistent", () => {
    expect(computeHandFeatures(sample("open_palm"), ASPECT)!.open).toBe(true);
    expect(computeHandFeatures(sample("fist"), ASPECT)!.open).toBe(false);
    expect(computeHandFeatures(sample("fist"), ASPECT)!.extendedFingers).toBe(0);
  });
});

describe("pose recognizer (temporal)", () => {
  const hand = (pose: Pose, score = 0.95) => [{ landmarks: sample(pose), score }];
  function feed(r: PoseRecognizer, from: number, to: number, pose: Pose | null, dt: number, score = 0.95) {
    const triggers: Array<{ t: number; pose: Pose }> = [];
    for (let t = from; t <= to; t += dt) {
      const u = r.update({ t, hands: pose ? hand(pose, score) : [], aspect: ASPECT });
      if (u.trigger) triggers.push({ t, pose: u.trigger });
    }
    return triggers;
  }

  it("fires once after the hold time and never repeats while the pose is held", () => {
    const r = new PoseRecognizer(["thumb_up"], { holdMs: 500 });
    const tr = feed(r, 0, 5000, "thumb_up", 33);
    expect(tr).toHaveLength(1);
    expect(tr[0]!.t).toBeGreaterThanOrEqual(500);
    expect(tr[0]!.t).toBeLessThan(600);
  });

  it("works at 2 fps (software WebGL), where the old 300 ms gap reset broke everything", () => {
    const r = new PoseRecognizer(["thumb_up"], { holdMs: 500 });
    expect(feed(r, 0, 2000, "thumb_up", 500)).toHaveLength(1);
  });

  it("re-arms only after the pose was released", () => {
    const r = new PoseRecognizer(["thumb_up"], { holdMs: 300, cooldownMs: 300, releaseMs: 200 });
    expect(feed(r, 0, 1000, "thumb_up", 50)).toHaveLength(1);
    expect(feed(r, 1050, 1150, null, 50)).toHaveLength(0); // released for only 100 ms
    expect(feed(r, 1200, 2000, "thumb_up", 50)).toHaveLength(0); // not re-armed yet
    expect(feed(r, 2050, 2400, null, 50)).toHaveLength(0); // released long enough
    expect(feed(r, 2450, 3200, "thumb_up", 50)).toHaveLength(1);
  });

  it("switching directly to another pose triggers that pose after its hold", () => {
    const r = new PoseRecognizer(["thumb_up", "thumb_down"], { holdMs: 300, globalCooldownMs: 500 });
    const a = feed(r, 0, 800, "thumb_up", 50);
    const downHand = [{ landmarks: rotate(sample("thumb_up"), 180), score: 0.95 }];
    const b: number[] = [];
    for (let t = 850; t <= 2000; t += 50) if (r.update({ t, hands: downHand, aspect: ASPECT }).trigger === "thumb_down") b.push(t);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]! - a[0]!.t).toBeGreaterThanOrEqual(500); // global cooldown respected
  });

  it("never fires for poses without a binding", () => {
    const r = new PoseRecognizer(["thumb_up"]);
    expect(feed(r, 0, 3000, "fist", 33)).toHaveLength(0);
    expect(r.update({ t: 3100, hands: hand("fist"), aspect: ASPECT }).status).toBe("unbound");
  });

  it("does not infer anything at low tracking confidence", () => {
    const r = new PoseRecognizer(["thumb_up"], { minConfidence: 0.5 });
    expect(feed(r, 0, 3000, "thumb_up", 33, 0.3)).toHaveLength(0);
    expect(r.update({ t: 3100, hands: hand("thumb_up", 0.3), aspect: ASPECT }).status).toBe("low-quality");
  });

  it("does not carry a hold across a camera stall", () => {
    const r = new PoseRecognizer(["thumb_up"], { holdMs: 500, maxFrameGapMs: 1200 });
    r.update({ t: 0, hands: hand("thumb_up"), aspect: ASPECT });
    r.update({ t: 400, hands: hand("thumb_up"), aspect: ASPECT });
    // 2 s gap: the hold restarts, so this frame alone must not fire
    expect(r.update({ t: 2400, hands: hand("thumb_up"), aspect: ASPECT }).trigger).toBeNull();
  });

  it("treats a missing hand as no hand (never assumes one is visible)", () => {
    const r = new PoseRecognizer(["thumb_up"]);
    const u = r.update({ t: 0, hands: [] });
    expect(u.status).toBe("no-hand");
    expect(u.pose).toBeNull();
  });
});

describe("gesture profiles", () => {
  it("built-in profiles are valid", () => {
    for (const p of BUILTIN_PROFILES) expect(GestureProfileSchema.safeParse(p).success).toBe(true);
  });

  it("rejects invalid profiles", () => {
    const base = { ...BUILTIN_PROFILES[0]!, builtin: false, id: "custom-a" };
    expect(validateProfile({ ...base, bindings: {} }).ok).toBe(false);
    expect(validateProfile({ ...base, holdMs: 50 }).ok).toBe(false);
    expect(validateProfile({ ...base, bindings: { thumb_up: "rm -rf" } }).ok).toBe(false);
    expect(validateProfile({ ...base, bindings: { wave: "turn_on" } }).ok).toBe(false);
    expect(validateProfile({ ...base, target: { type: "url", url: "http://x" } }).ok).toBe(false);
    expect(validateProfile(base).ok).toBe(true);
  });
});

describe("gesture dispatch", () => {
  beforeEach(() => {
    vi.resetModules();
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
  });

  async function load() {
    const [{ dispatchGesture }, { useHub }, { useExperience }, { useAppStore }] = await Promise.all([
      import("@/lib/gesture/dispatch"),
      import("@/lib/hub/hub-store"),
      import("@/lib/experience/store"),
      import("@/lib/state/store"),
    ]);
    return { dispatchGesture, useHub, useExperience, useAppStore };
  }
  const device = (id: string, roomId: string, commands: string[]) => ({
    id,
    name: id.toUpperCase(),
    type: "light",
    integration: "simulated",
    simulated: true,
    capabilities: [],
    commands,
    controlEnabled: true,
    controlAllowed: true,
    hidden: false,
    metadata: { roomId },
    connection: { status: "online", lastSeen: null, lastError: null },
    state: { reported: {}, reportedAt: null, source: null, requested: null, requestedAt: null, pending: false },
    config: {},
    credentialsStored: false,
    diagnostics: {},
  });

  it("routes a room target to every capable device and reports per-device results", async () => {
    const { dispatchGesture, useHub } = await load();
    const command = vi.fn(async (id: string, _command: string, _params: unknown, _source: string) => ({ ok: true, outcome: "simulated", text: `${id} on`, at: 0 }));
    useHub.setState({
      status: "ready",
      safety: { active: false },
      devices: { a: device("a", "room-1", ["turn_on"]), b: device("b", "room-1", ["turn_on"]), c: device("c", "room-2", ["turn_on"]), d: device("d", "room-1", ["open"]) } as never,
      command: command as never,
    });
    const profile: GestureProfile = { id: "p", name: "p", builtin: false, target: { type: "room", roomId: "room-1" }, holdMs: 500, cooldownMs: 1000, bindings: { thumb_up: "turn_on" } };
    const r = await dispatchGesture("thumb_up", profile, { gesturesEnabled: true }, () => "Living room");
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    expect(command.mock.calls[0]![3]).toBe("gesture");
    expect(r!.ok).toBe(true);
    expect(r!.outcome).toBe("simulated");
    expect(r!.target).toBe("Living room");
  });

  it("refuses when the emergency stop or the hub safety stop is active, without calling the hub", async () => {
    const { dispatchGesture, useHub, useAppStore } = await load();
    const command = vi.fn();
    useHub.setState({ status: "ready", safety: { active: false }, devices: { a: device("a", "r", ["turn_on"]) } as never, command: command as never });
    const profile: GestureProfile = { id: "p", name: "p", builtin: false, target: { type: "device", deviceId: "a" }, holdMs: 500, cooldownMs: 1000, bindings: { thumb_up: "turn_on", open_palm: "pause_hands_free" } };
    useAppStore.getState().setPaused(true);
    expect((await dispatchGesture("thumb_up", profile, { gesturesEnabled: true }))!.outcome).toBe("blocked");
    useAppStore.getState().setPaused(false);
    useHub.setState({ safety: { active: true } });
    expect((await dispatchGesture("thumb_up", profile, { gesturesEnabled: true }))!.outcome).toBe("blocked");
    expect((await dispatchGesture("thumb_up", { ...profile }, { gesturesEnabled: false }))!.outcome).toBe("blocked");
    expect(command).not.toHaveBeenCalled();
    // the pause gesture always works (it only ever makes the system safer)
    expect((await dispatchGesture("open_palm", profile, { gesturesEnabled: false }))!.outcome).toBe("confirmed");
    expect(useAppStore.getState().light.dispatchPaused).toBe(true);
  });

  it("reports unsupported actions and hub refusals honestly", async () => {
    const { dispatchGesture, useHub } = await load();
    const command = vi.fn(async () => ({ ok: false, text: "You do not have permission", status: 403, at: 0 }));
    useHub.setState({ status: "ready", safety: { active: false }, devices: { a: device("a", "r", ["turn_on"]) } as never, command: command as never });
    const profile: GestureProfile = { id: "p", name: "p", builtin: false, target: { type: "device", deviceId: "a" }, holdMs: 500, cooldownMs: 1000, bindings: { thumb_up: "turn_on", thumb_down: "close" } };
    const unsupported = await dispatchGesture("thumb_down", profile, { gesturesEnabled: true });
    expect(unsupported!.ok).toBe(false);
    expect(command).not.toHaveBeenCalled();
    const denied = await dispatchGesture("thumb_up", profile, { gesturesEnabled: true });
    expect(denied!.outcome).toBe("blocked");
    expect(denied!.message).toContain("permission");
  });

  it("drives the simulated Experience light through the Experience pipeline", async () => {
    const { dispatchGesture, useExperience } = await load();
    useExperience.setState({ target: "sim" } as never);
    const profile = BUILTIN_PROFILES[0]!;
    const r = await dispatchGesture("thumb_up", profile, { gesturesEnabled: true });
    expect(r!.outcome === "simulated" || r!.outcome === "already").toBe(true);
    expect(useExperience.getState().sim.on).toBe(true);
  });
});
