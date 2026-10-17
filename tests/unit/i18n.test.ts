import { describe, expect, it } from "vitest";
import { formatPercent, interpolate, LOCALES, stripBidi } from "@/lib/i18n/core";
import { detectLocale, DICTIONARIES, translate } from "@/lib/i18n";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(path, v);
    else for (const [p, s] of leaves(v, path)) out.set(p, s);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  const en = leaves(DICTIONARIES.en as unknown as Tree);

  it.each(LOCALES)("%s has exactly the English keys, non-empty strings and the same placeholders", (locale) => {
    const dict = leaves(DICTIONARIES[locale] as unknown as Tree);
    expect([...dict.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of dict) {
      expect(text.trim(), key).not.toBe("");
      expect(placeholders(text), key).toEqual(placeholders(en.get(key) ?? ""));
    }
  });

  it("Algerian Darija is a separate translation, not a copy of Modern Standard Arabic", () => {
    const ar = leaves(DICTIONARIES.ar as unknown as Tree);
    const dz = leaves(DICTIONARIES.dz as unknown as Tree);
    const arabic = [...ar.keys()].filter((k) => /[\u0600-\u06FF]/.test(ar.get(k) ?? ""));
    const same = arabic.filter((k) => ar.get(k) === dz.get(k));
    // only short technical labels may coincide (e.g. "اللغة", "تفاصيل تقنية")
    expect(same.length / arabic.length).toBeLessThan(0.1);
  });

  it("contains the state-aware replies required by the specification", () => {
    expect(translate("en", "assistant.reply.alreadyOn")).toBe("The light is already on.");
    expect(translate("fr", "assistant.reply.alreadyOn")).toBe("La lumière est déjà allumée.");
    expect(translate("ar", "assistant.reply.alreadyOn")).toBe("الإضاءة مشغّلة بالفعل.");
    expect(translate("dz", "assistant.reply.alreadyOn")).toBe("خويا، راه شاعل بالفعل.");
    expect(translate("en", "intro.connect")).toBe("Connect Your Real Light");
    expect(translate("en", "intro.explore")).toBe("Explore Simulation");
    expect(translate("en", "intro.support")).toBe(
      "Connect your light and experience intelligent control through voice, hand gestures, and your interactive Digital Twin.",
    );
  });
});

describe("formatting", () => {
  it("isolates interpolated values in right-to-left locales", () => {
    const text = translate("ar", "assistant.reply.brightnessSet", { value: "60%" });
    expect(text).toContain("\u206860%\u2069");
    expect(stripBidi(text)).toBe("تم ضبط السطوع على 60%.");
    expect(interpolate("{a} / {b}", { a: 1 }, "ltr")).toBe("1 / {b}");
  });

  it("formats percentages with Latin digits and French spacing", () => {
    expect(formatPercent(60, "en")).toBe("60%");
    expect(formatPercent(60.4, "fr")).toBe("60\u202F%");
    // right-to-left: isolated so the percent sign stays after the number next to Arabic text
    expect(formatPercent(7, "ar")).toBe("\u20667%\u2069");
    expect(stripBidi(formatPercent(7, "dz"))).toBe("7%");
  });

  it("detects a first-visit locale from the browser languages", () => {
    expect(detectLocale(["ar-DZ", "fr-FR"])).toBe("dz");
    expect(detectLocale(["ar-EG"])).toBe("ar");
    expect(detectLocale(["fr-CA", "en"])).toBe("fr");
    expect(detectLocale(["de-DE"])).toBe("en");
    expect(detectLocale(["de-DE", "en-GB"])).toBe("en");
  });
});
