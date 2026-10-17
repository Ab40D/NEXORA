/**
 * Experience pipeline, Digital Twin view and "Talk to SE7ENX" replies.
 * The hub is MOCKED here (useHub.command is replaced); no network and no hardware are involved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory localStorage so the persisted stores work in the node test environment.
vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
});
import { useConversation } from "@/lib/assistant/conversation";
import { executionReply, stateReply } from "@/lib/assistant/respond";
import { experienceLampView } from "@/lib/experience/lamp-view";
import { resolveSim, selectTarget, snapshotOfDevice, useExperience, type Execution } from "@/lib/experience/store";
import type { HubDevice } from "@/lib/hub/contract";
import { useHub, type CommandResultView } from "@/lib/hub/hub-store";
import { stripBidi, translate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";

function device(over: Partial<HubDevice> = {}, reported: Record<string, unknown> = { on: true, brightness: 40 }): HubDevice {
  return {
    id: "dev1",
    name: "Salon",
    type: "light",
    integration: "shelly",
    simulated: false,
    model: null,
    capabilities: ["on_off", "brightness"],
    commands: ["turn_on", "turn_off", "toggle", "set_brightness", "adjust_brightness"],
    controlEnabled: true,
    controlAllowed: true,
    hidden: false,
    metadata: {},
    connection: { status: "online", lastSeen: null, lastError: null },
    state: { reported, reportedAt: "2026-10-17T10:00:00Z", source: "status", requested: null, requestedAt: null, pending: false },
    config: {},
    credentialsStored: false,
    diagnostics: {},
    ...over,
  };
}

const ok = (outcome: CommandResultView["outcome"]): CommandResultView => ({ ok: true, outcome, text: "detail", at: Date.now() });
const fail = (code: string, status: number): CommandResultView => ({ ok: false, code, status, text: "English detail", at: Date.now() });

beforeEach(() => {
  useExperience.setState({ target: "none", deviceId: null, sim: { on: false, brightness: 70 }, exec: null, history: [], busy: false });
  useHub.setState({ devices: {}, order: [], status: "idle", safety: { active: false } });
  useAppStore.getState().setPaused(false);
  useI18n.setState({ locale: "en" });
  useConversation.setState({ messages: [], thinking: false, llm: null, speakReplies: false });
});

describe("simulated light", () => {
  it("resolves commands like a dimmer", () => {
    const off = { on: false, brightness: 70 };
    expect(resolveSim(off, { kind: "turn_on" })).toEqual({ on: true, brightness: 70 });
    expect(resolveSim(off, { kind: "adjust_brightness", delta: 10 })).toEqual({ on: true, brightness: 10 });
    expect(resolveSim({ on: true, brightness: 95 }, { kind: "adjust_brightness", delta: 10 })).toEqual({ on: true, brightness: 100 });
    expect(resolveSim({ on: true, brightness: 5 }, { kind: "adjust_brightness", delta: -20 })).toEqual({ on: false, brightness: 5 });
    expect(resolveSim(off, { kind: "set_brightness", value: 0 })).toEqual(off);
  });

  it("runs the pipeline: simulated, already satisfied, dimming", async () => {
    const xp = useExperience.getState();
    xp.selectSim();
    expect((await xp.execute({ kind: "turn_on" }, "manual")).state).toBe("simulated");
    expect(useExperience.getState().sim).toEqual({ on: true, brightness: 70 });
    expect((await xp.execute({ kind: "turn_on" }, "manual")).state).toBe("already");
    expect((await xp.execute({ kind: "set_brightness", value: 40 }, "manual")).state).toBe("simulated");
    expect((await xp.execute({ kind: "adjust_brightness", delta: 10 }, "manual")).result).toEqual({ on: true, brightness: 50 });
    expect((await xp.execute({ kind: "set_brightness", value: 50 }, "manual")).state).toBe("already");
  });

  it("remembers the selected light, but not the simulated state", () => {
    useExperience.getState().selectSim();
    const saved = JSON.parse(localStorage.getItem("se7enx.experience.v1") ?? "{}") as { state?: Record<string, unknown> };
    expect(saved.state).toEqual({ target: "sim", deviceId: null });
  });

  it("the emergency stop blocks hands-free sources but not manual control", async () => {
    useExperience.getState().selectSim();
    useAppStore.getState().setPaused(true);
    for (const source of ["voice", "gesture", "assistant"] as const) {
      const r = await useExperience.getState().execute({ kind: "turn_on" }, source);
      expect(r.state).toBe("blocked");
    }
    expect(useExperience.getState().sim.on).toBe(false);
    expect((await useExperience.getState().execute({ kind: "turn_on" }, "manual")).state).toBe("simulated");
  });
});

describe("hub device target (mocked hub)", () => {
  const selectDevice = (d: HubDevice, result: CommandResultView | null) => {
    const command = vi.fn().mockResolvedValue(result);
    useHub.setState({ devices: { [d.id]: d }, order: [d.id], status: "ready", command });
    useExperience.getState().selectDevice(d.id);
    return command;
  };

  it.each([
    [ok("confirmed"), "confirmed"],
    [ok("accepted"), "accepted"],
    [ok("simulated"), "simulated"],
    [ok("already_satisfied"), "already"],
    [fail("STATE_UNKNOWN", 409), "unknown"],
    [fail("DEVICE_UNAVAILABLE", 503), "offline"],
    [fail("DEVICE_TIMEOUT", 504), "timeout"],
    [fail("SAFETY_STOP_ACTIVE", 423), "blocked"],
    [fail("CONTROL_NOT_ENABLED", 403), "blocked"],
    [fail("SHELLY_RPC_ERROR", 502), "failed"],
  ] as const)("maps %o to %s", async (result, state) => {
    const command = selectDevice(device(), result);
    const r = await useExperience.getState().execute({ kind: "adjust_brightness", delta: 10 }, "manual");
    expect(r.state).toBe(state);
    expect(command).toHaveBeenCalledWith("dev1", "adjust_brightness", { delta: 10 }, "manual");
  });

  it("never sends brightness commands to an on/off-only device", async () => {
    const command = selectDevice(device({ capabilities: ["on_off"] }), ok("confirmed"));
    const r = await useExperience.getState().execute({ kind: "set_brightness", value: 60 }, "manual");
    expect(r).toMatchObject({ state: "failed", error: "unsupported" });
    expect(command).not.toHaveBeenCalled();
  });

  it("treats a busy device as failed without queueing", async () => {
    selectDevice(device(), null);
    expect(await useExperience.getState().execute({ kind: "turn_on" }, "manual")).toMatchObject({ state: "failed", error: "busy" });
  });

  it("only trusts reliable reported state", () => {
    expect(snapshotOfDevice(device(), false).state).toEqual({ on: true, brightness: 40 });
    expect(snapshotOfDevice(device({ state: { ...device().state, source: "bus_observed" } }), false).state).toBeNull();
    expect(snapshotOfDevice(device({ state: { ...device().state, pending: true } }), false).state).toBeNull();
    expect(snapshotOfDevice(device({ connection: { status: "offline", lastSeen: null, lastError: null } }), false).state).toBeNull();
    expect(snapshotOfDevice(device({}, {}), false).state).toBeNull();
    expect(snapshotOfDevice(device(), true).controlAllowed).toBe(false); // hub emergency stop
  });
});

describe("Digital Twin view", () => {
  it("shows simulation, confirmed, unknown and offline honestly", () => {
    useExperience.getState().selectSim();
    useExperience.setState({ sim: { on: true, brightness: 60 } });
    const sim = selectTarget(useExperience.getState(), useHub.getState());
    expect(sim).not.toBeNull();
    const simView = experienceLampView(sim!, null, "en");
    expect(simView).toMatchObject({ lit: true, certainty: "simulated", tone: "sim" });
    expect(simView.label).toBe("SIMULATION · On · 60%");

    const live = experienceLampView(snapshotOfDevice(device(), false), null, "fr");
    expect(live).toMatchObject({ lit: true, certainty: "confirmed", intensity: 0.4 });
    expect(live.label).toBe("Allumée · 40\u202F%");

    const unknown = experienceLampView(snapshotOfDevice(device({}, {}), false), null, "en");
    expect(unknown).toMatchObject({ lit: false, certainty: "unknown", label: "State unknown" });

    const offline = experienceLampView(snapshotOfDevice(device({ connection: { status: "offline", lastSeen: null, lastError: null } }), false), null, "en");
    expect(offline).toMatchObject({ lit: false, certainty: "stale", tone: "error" });
  });

  it("shows an in-flight command as requested, not as done", () => {
    const exec: Execution = { id: 1, command: { kind: "turn_on" }, source: "manual", state: "executing", requested: { on: true, brightness: 40 }, at: 0 };
    const view = experienceLampView(snapshotOfDevice(device({}, { on: false }), false), exec, "en");
    expect(view).toMatchObject({ lit: false, pending: "on" });
  });
});

describe("assistant replies", () => {
  const pct = (n: number) => `${n}%`;
  const err = () => "error";

  it("state replies never guess", () => {
    expect(stateReply(null, pct).key).toBe("assistant.reply.noTarget");
    expect(stateReply(snapshotOfDevice(device({}, {}), false), pct).key).toBe("assistant.reply.stateUnknown");
    expect(stateReply(snapshotOfDevice(device(), false), pct)).toEqual({ key: "assistant.reply.stateOnLevel", vars: { value: "40%" } });
    expect(stateReply(snapshotOfDevice(device({ connection: { status: "offline", lastSeen: null, lastError: null } }), false), pct).key).toBe(
      "assistant.reply.offline",
    );
  });

  it("execution replies follow the outcome", () => {
    const target = snapshotOfDevice(device(), false);
    const base = { id: 1, source: "assistant" as const, at: 0 };
    const reply = (state: Execution["state"], extra: Partial<Execution> = {}, command: Execution["command"] = { kind: "turn_on" }) =>
      executionReply(command, { ...base, command, state, ...extra }, target, pct, err).key;
    expect(reply("already")).toBe("assistant.reply.alreadyOn");
    expect(reply("accepted")).toBe("assistant.reply.sentUnconfirmed");
    expect(reply("confirmed", { result: { on: true, brightness: 40 } })).toBe("assistant.reply.turnedOn");
    expect(reply("confirmed", { result: null })).toBe("assistant.reply.sentUnconfirmed");
    expect(reply("unknown", {}, { kind: "adjust_brightness", delta: 10 })).toBe("assistant.reply.relativeUnknown");
    expect(reply("blocked", { error: "needsTest" })).toBe("assistant.reply.needsTest");
    expect(reply("failed", { error: "busy", code: "DEVICE_RATE_LIMITED" })).toBe("assistant.reply.rateLimited");
  });
});

describe("conversation (simulation target)", () => {
  const last = () => stripBidi(useConversation.getState().messages.at(-1)?.text ?? "");

  it("answers in the language of the message, with state-aware replies", async () => {
    const chat = useConversation.getState();
    // no target yet → asks which light (never guesses a target)
    await chat.send("خويا شعل الضو");
    expect(last()).toBe(translate("dz", "assistant.reply.noTarget"));
    useExperience.getState().selectSim();
    await chat.send("خويا شعل الضو");
    expect(last()).toBe("الضو راهو شاعل (سيمولاسيون).");
    await chat.send("خويا شعل الضو");
    expect(last()).toBe("خويا، راه شاعل بالفعل.");
    await chat.send("خليها على النص");
    expect(last()).toBe("خلّيت الضو على 50% (سيمولاسيون).");
    await chat.send("Increase brightness by 10%");
    expect(last()).toBe("Brightness set to 60% (simulation).");
    await chat.send("Éteins-la");
    expect(last()).toBe("La lumière est éteinte (simulation).");
    await chat.send("هل الإضاءة مشغلة؟");
    expect(last()).toBe("الإضاءة مطفأة.");
    await chat.send("60");
    expect(last()).toBe("Do you mean brightness 60%?");
  });
});
