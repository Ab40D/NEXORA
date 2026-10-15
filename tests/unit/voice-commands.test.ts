import { describe, expect, it } from "vitest";
import { languageFamily, normalizeArabic, parseVoiceCommand, resolveAlternatives } from "@/lib/voice/commands";

describe("voice command allowlist — English", () => {
  it.each([
    ["Light on", "on"],
    ["Turn the light on", "on"],
    ["turn on the lights", "on"],
    ["Please switch the lamp on.", "on"],
    ["Light off", "off"],
    ["Turn the light off", "off"],
    ["turn off the light please", "off"],
    ["Hey SE7ENX, lights off!", "off"],
    ["Could you turn the light off", "off"],
  ])("%s → %s", (text, expected) => {
    expect(parseVoiceCommand(text, "en").command).toBe(expected);
  });

  it.each([
    "don't turn the light on",
    "do not turn off the light",
    "turn the light on and off",
    "what is the light status",
    "connect to the gateway 192.168.1.10",
    "set group address one two three",
    "light",
    "on",
    "turn on the television",
    "lights on in the kitchen and bathroom",
  ])("ignores %j", (text) => {
    expect(parseVoiceCommand(text, "en").command).toBeNull();
  });
});

describe("voice command allowlist — French", () => {
  it.each([
    ["Allume la lumière", "on"],
    ["allumer la lumière s'il te plaît", "on"],
    ["Ouvre la lumière", "on"],
    ["Éteins la lumière", "off"],
    ["éteint la lampe", "off"],
    ["Ferme la lumière", "off"],
    ["Est-ce que tu peux éteindre la lumière", "off"],
  ])("%s → %s", (text, expected) => {
    expect(parseVoiceCommand(text, "fr").command).toBe(expected);
  });

  it("ignores negations and unrelated sentences", () => {
    expect(parseVoiceCommand("n'allume pas la lumière", "fr").command).toBeNull();
    expect(parseVoiceCommand("ferme la porte", "fr").command).toBeNull();
  });
});

describe("voice command allowlist — Arabic (MSA & Algerian Darija)", () => {
  it.each([
    ["شغّل الضوء", "on"],
    ["أشعل النور", "on"],
    ["افتح الضوء من فضلك", "on"],
    ["شعّل الضو", "on"],
    ["أطفئ الضوء", "off"],
    ["طفّي الضو", "off"],
    ["اطفي النور عافاك", "off"],
    ["أغلق المصباح", "off"],
  ])("%s → %s", (text, expected) => {
    expect(parseVoiceCommand(text, "ar").command).toBe(expected);
  });

  it("ignores negation", () => {
    expect(parseVoiceCommand("لا تشغل الضوء", "ar").command).toBeNull();
  });

  it("normalizes diacritics and letter variants", () => {
    expect(normalizeArabic("أَطْفِئ الضَّوْءَ")).toBe("اطفي الضوء");
  });
});

describe("alternatives resolution", () => {
  it("uses the first matching alternative", () => {
    const r = resolveAlternatives([
      { transcript: "like gone", confidence: 0.6 },
      { transcript: "light on", confidence: 0.5 },
    ]);
    expect(r.command).toBe("on");
  });

  it("rejects ambiguous alternatives that disagree", () => {
    const r = resolveAlternatives([
      { transcript: "light on", confidence: 0.5 },
      { transcript: "light off", confidence: 0.45 },
    ]);
    expect(r.command).toBeNull();
    expect(r.reason).toBe("ambiguous");
  });

  it("rejects low-confidence matches but accepts engines that report 0", () => {
    expect(resolveAlternatives([{ transcript: "light on", confidence: 0.1 }]).reason).toBe("low-confidence");
    expect(resolveAlternatives([{ transcript: "light on", confidence: 0 }]).command).toBe("on");
  });

  it("maps BCP-47 tags to command languages", () => {
    expect(languageFamily("fr-FR")).toBe("fr");
    expect(languageFamily("ar-DZ")).toBe("ar");
    expect(languageFamily("en-GB")).toBe("en");
  });
});
