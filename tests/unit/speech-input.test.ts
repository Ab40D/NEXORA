import { describe, expect, it } from "vitest";
import { hubSpeechAvailable, resolveEngine } from "@/lib/voice/speech-input";

const hub = { enabled: true, model: "base", host: "speech", maxSeconds: 15 };

describe("speech engine selection", () => {
  it("prefers local hub speech in auto mode (privacy, works in Firefox)", () => {
    expect(resolveEngine("auto", { browser: true, recorder: true, hub })).toBe("hub");
    expect(resolveEngine("auto", { browser: false, recorder: true, hub })).toBe("hub");
  });

  it("falls back to the browser engine when the hub has no speech service", () => {
    expect(resolveEngine("auto", { browser: true, recorder: true, hub: null })).toBe("browser");
    expect(resolveEngine("auto", { browser: true, recorder: true, hub: { ...hub, enabled: false } })).toBe("browser");
  });

  it("reports no engine instead of pretending (Firefox without hub speech)", () => {
    expect(resolveEngine("auto", { browser: false, recorder: true, hub: null })).toBeNull();
    expect(resolveEngine("hub", { browser: true, recorder: false, hub })).toBeNull(); // cannot record
    expect(resolveEngine("browser", { browser: false, recorder: true, hub })).toBeNull();
  });

  it("honours an explicit choice", () => {
    expect(resolveEngine("browser", { browser: true, recorder: true, hub })).toBe("browser");
    expect(resolveEngine("hub", { browser: true, recorder: true, hub })).toBe("hub");
    expect(hubSpeechAvailable({ recorder: true, hub })).toBe(true);
  });
});
