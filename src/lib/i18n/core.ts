/**
 * Localization core (no React): locales, typed message keys, interpolation, number formatting.
 *
 * - English (`en`) is the source dictionary; every other dictionary is typed against it, so a
 *   missing or extra key is a compile error (and a unit test checks placeholders too).
 * - Algerian Darija (`dz`) and Modern Standard Arabic (`ar`) are separate locales.
 * - Interpolated values are wrapped in Unicode bidi isolates in RTL locales so IDs, IP addresses
 *   and percentages render correctly inside Arabic text.
 * - Digits are always Latin (0-9), which is also the common usage in Algeria.
 */
import { en } from "./messages/en";

export const LOCALES = ["en", "fr", "ar", "dz"] as const;
export type Locale = (typeof LOCALES)[number];

export interface LocaleMeta {
  /** name of the language in that language */
  native: string;
  dir: "ltr" | "rtl";
  /** value for <html lang> */
  htmlLang: string;
  /** BCP-47 tag used for speech recognition */
  recognition: string;
  /** BCP-47 tags acceptable for speech synthesis, best first */
  synthesis: string[];
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { native: "English", dir: "ltr", htmlLang: "en", recognition: "en-US", synthesis: ["en-US", "en-GB", "en"] },
  fr: { native: "Français", dir: "ltr", htmlLang: "fr", recognition: "fr-FR", synthesis: ["fr-FR", "fr-CA", "fr"] },
  ar: { native: "العربية", dir: "rtl", htmlLang: "ar", recognition: "ar-SA", synthesis: ["ar-SA", "ar-EG", "ar"] },
  dz: { native: "الدارجة", dir: "rtl", htmlLang: "ar-DZ", recognition: "ar-DZ", synthesis: ["ar-DZ"] },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
/** Shape every dictionary must have (the English tree with string leaves). */
export type Messages = Widen<typeof en>;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Every valid translation key, e.g. "intro.title". */
export type MessageKey = Leaves<typeof en>;

export type Vars = Record<string, string | number>;

const FSI = "\u2068"; // first strong isolate
const PDI = "\u2069"; // pop directional isolate

export function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, vars: Vars | undefined, dir: "ltr" | "rtl"): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in vars)) return match;
    const value = String(vars[name]);
    return dir === "rtl" ? `${FSI}${value}${PDI}` : value;
  });
}

/**
 * "60%" (en), "60 %" (fr, narrow no-break space), "60%" (ar/dz). Always Latin digits.
 * In right-to-left locales the value is wrapped in a left-to-right isolate: after Arabic letters the
 * bidi algorithm would otherwise display "50%" as "%50".
 */
export function formatPercent(value: number, locale: Locale): string {
  const n = Math.round(value);
  if (locale === "fr") return `${n}\u202F%`;
  return LOCALE_META[locale].dir === "rtl" ? `\u2066${n}%\u2069` : `${n}%`;
}

/** Remove bidi isolates (used by tests and when sending text to speech synthesis). */
export function stripBidi(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, "");
}
