import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeMessage, parseIntent, wordsToDigits } from "@/lib/assistant/intent";

type Case = [text: string, kind: string, value?: number, lang?: string | null];

const check = (cases: Case[], hint: "en" | "fr" | "ar" | "dz" = "en") => {
  for (const [text, kind, value, lang] of cases) {
    const r = parseIntent(text, hint);
    expect({ text, kind: r.kind, value: r.value }).toEqual({ text, kind, value });
    if (lang !== undefined) expect({ text, lang: r.lang }).toEqual({ text, lang });
  }
};

describe("intent engine — examples from the specification", () => {
  it("dimming, absolute and relative, in 4 languages", () => {
    check([
      ["Set the brightness to 60%", "set_brightness", 60, "en"],
      ["Mets la luminosité à 60 %", "set_brightness", 60, "fr"],
      ["خلي الضو على 60 بالمية", "set_brightness", 60, "dz"],
      ["Increase brightness by 10%", "adjust_brightness", 10, "en"],
      ["نقصلي الضوء بـ 20 بالمية", "adjust_brightness", -20, "dz"],
      ["زيد الضو شوية", "adjust_brightness", 10, "dz"],
    ]);
  });

  it("conversational examples", () => {
    check([
      ["خويا شعل الضو", "turn_on", undefined, "dz"],
      ["خويا راه شاعل، زيدلي الضو شوية", "adjust_brightness", 10, "dz"],
      ["خليها على النص", "set_brightness", 50, "dz"],
      ["طفّي الضو", "turn_off", undefined, "dz"],
      ["Allume la lumière", "turn_on", undefined, "fr"],
      ["Éteins-la", "turn_off", undefined, "fr"],
      ["Mets la lumière à 40 %", "set_brightness", 40, "fr"],
    ]);
  });
});

describe("intent engine — Modern Standard Arabic is told apart from Darija", () => {
  it("MSA commands", () => {
    check([
      ["شغّل الإضاءة", "turn_on", undefined, "ar"],
      ["أطفئ الضوء", "turn_off", undefined, "ar"],
      ["اضبط السطوع على ٧٠٪", "set_brightness", 70, "ar"],
      ["ارفع السطوع قليلًا", "adjust_brightness", 10, "ar"],
      ["خفض السطوع بمقدار 30", "adjust_brightness", -30, "ar"],
      ["هل الإضاءة مشغلة؟", "query_state", undefined, "ar"],
      ["مرحبا", "greeting", undefined, "ar"],
      ["شكرا", "thanks", undefined, "ar"],
    ]);
  });

  it("Darija extras", () => {
    check([
      ["واش الضو شاعل؟", "query_state", undefined, "dz"],
      ["واش الضو شاعل", "query_state", undefined, "dz"],
      ["واش تقدر تشعل الضو", "turn_on", undefined, "dz"],
      ["زيد بزاف", "adjust_brightness", 30, "dz"],
      ["خلي الضو على خمسة وسبعين بالمية", "set_brightness", 75, "dz"],
      ["نقصلي الضو بـ20", "adjust_brightness", -20, "dz"],
      ["طفيلي الضو خويا", "turn_off", undefined, "dz"],
      ["صحيت", "thanks", undefined, "dz"],
      ["واش راك", "greeting", undefined, "dz"],
      ["chaal dow", "turn_on", undefined, "dz"],
      ["tfi dow", "turn_off", undefined, "dz"],
    ]);
  });
});

describe("intent engine — English and French details", () => {
  it("English", () => {
    check([
      ["turn the light off", "turn_off", undefined, "en"],
      ["lights on", "turn_on", undefined, "en"],
      ["is the light on?", "query_state", undefined, "en"],
      ["is the light on", "query_state", undefined, "en"], // voice transcripts have no "?"
      ["can you turn on the light", "turn_on", undefined, "en"],
      ["a little dimmer", "adjust_brightness", -10, "en"],
      ["a little more", "adjust_brightness", 10, "en"],
      ["a bit less", "adjust_brightness", -10, "en"],
      ["a lot more", "adjust_brightness", 30, "en"],
      ["make it brighter", "adjust_brightness", 10, "en"],
      ["make it half", "set_brightness", 50, "en"],
      ["full brightness", "set_brightness", 100, "en"],
      ["dim to 30 percent", "set_brightness", 30, "en"],
      ["increase the brightness to 80%", "set_brightness", 80, "en"],
      ["seventy five percent", "set_brightness", 75, "en"],
      ["set it to 150%", "set_brightness", 100, "en"], // clamped to the device range
      ["hello", "greeting", undefined, "en"],
      ["what can you do", "help", undefined, "en"],
      ["thanks", "thanks", undefined, "en"],
    ]);
  });

  it("French", () => {
    check([
      ["un peu plus fort", "adjust_brightness", 10, "fr"],
      ["un peu moins", "adjust_brightness", -10, "fr"],
      ["baisse la lumière de vingt pour cent", "adjust_brightness", -20, "fr"],
      ["augmente la luminosité à 80 %", "set_brightness", 80, "fr"],
      ["soixante-quinze pour cent", "set_brightness", 75, "fr"],
      ["Allume la lumière à 30 %", "set_brightness", 30, "fr"],
      ["est-ce que la lumière est allumée ?", "query_state", undefined, "fr"],
      ["mets la lumière", "turn_on", undefined, "fr"],
      ["bonjour", "greeting", undefined, "fr"],
      ["merci", "thanks", undefined, "fr"],
    ]);
  });
});

describe("intent engine — never guesses", () => {
  it("clarifies missing or bare values", () => {
    check([
      ["60", "clarify_number", 60, null],
      ["set the brightness", "clarify_value", undefined],
      ["règle la luminosité", "clarify_value", undefined],
      ["60%", "set_brightness", 60, null],
    ]);
  });

  it("refuses negations and contradictions", () => {
    const neg = parseIntent("don't turn on the light");
    expect(neg.kind).toBe("unknown");
    expect(neg.negated).toBe(true);
    expect(parseIntent("n'allume pas la lumière").kind).toBe("unknown");
    expect(parseIntent("لا تشغل الضوء").kind).toBe("unknown");
    expect(parseIntent("ما تطفيش الضو").kind).toBe("unknown");
    expect(parseIntent("allume et éteins la lumière").kind).toBe("ambiguous");
    expect(parseIntent("increase and decrease").kind).toBe("ambiguous");
  });

  it("unrelated text is unknown", () => {
    for (const text of ["open the garage door", "what's the weather", "قداش الساعة", "", "   "]) {
      expect(parseIntent(text).kind).toBe("unknown");
    }
  });
});

describe("normalization helpers", () => {
  it("normalizes digits, diacritics and letter variants", () => {
    expect(normalizeMessage("اضبط السطوع على ٧٠٪")).toBe("اضبط السطوع علي 70 %");
    expect(normalizeMessage("طفّي الضوء")).toBe("طفي الضوء");
    expect(normalizeMessage("Éteins-la !")).toBe("eteins la");
    expect(normalizeMessage("بـ20")).toBe("ب 20");
  });
  it("spells out numbers", () => {
    expect(wordsToDigits("quatre vingt dix")).toBe("90");
    expect(wordsToDigits("twenty five")).toBe("25");
    expect(wordsToDigits("خمسه وعشرين")).toBe("25");
    expect(wordsToDigits("un peu")).toBe("un peu");
  });
  it("detects the message language with a hint for ties", () => {
    expect(detectLanguage(normalizeMessage("Allume la lumière"), "en")).toBe("fr");
    expect(detectLanguage(normalizeMessage("الضوء"), "en")).toBe("ar");
    expect(detectLanguage(normalizeMessage("الضو"), "en")).toBe("dz");
    expect(detectLanguage("60 %", "fr")).toBeNull();
  });
});
