"use client";
/**
 * React side of localization: persisted locale store, `useT()` hook, document lang/dir sync.
 *
 * The page is prerendered in English; the stored locale is applied right after hydration
 * (`skipHydration` + `rehydrate()` in <I18nDocumentSync/>) so server and client markup match.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { formatPercent, interpolate, isLocale, LOCALE_META, lookup, type Locale, type MessageKey, type Messages, type Vars } from "./core";
import { ar } from "./messages/ar";
import { dz } from "./messages/dz";
import { en } from "./messages/en";
import { fr } from "./messages/fr";

export * from "./core";

export const DICTIONARIES: Record<Locale, Messages> = { en, fr, ar, dz };

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = lookup(DICTIONARIES[locale], key) ?? lookup(DICTIONARIES.en, key) ?? key;
  return interpolate(template, vars, LOCALE_META[locale].dir);
}

/** Best guess for a first visit: browser language (Algerian Arabic → Darija). */
export function detectLocale(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const tag = raw.toLowerCase();
    if (tag === "ar-dz") return "dz";
    if (tag.startsWith("ar")) return "ar";
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

interface I18nStore {
  locale: Locale;
  /** true once the user picked a language explicitly */
  chosen: boolean;
  setLocale: (locale: Locale) => void;
}

export const useI18n = create<I18nStore>()(
  persist(
    (set) => ({
      locale: "en",
      chosen: false,
      setLocale: (locale) => set({ locale, chosen: true }),
    }),
    {
      name: "se7enx.locale.v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ locale: s.locale, chosen: s.chosen }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<I18nStore>;
        return { ...current, locale: isLocale(p.locale) ? p.locale : current.locale, chosen: p.chosen === true };
      },
    },
  ),
);

/** Translate outside React (controllers, stores) using the current locale. */
export function t(key: MessageKey, vars?: Vars, locale: Locale = useI18n.getState().locale): string {
  return translate(locale, key, vars);
}

/** Intl tags with Latin digits forced (also for Arabic) — the app always shows 0-9. */
const INTL_TAG: Record<Locale, string> = { en: "en", fr: "fr", ar: "ar-u-nu-latn", dz: "ar-DZ-u-nu-latn" };

export function formatClock(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleTimeString(INTL_TAG[locale], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "just now" / "12 s ago" / "3 min ago", then a clock time — from the dictionary (Darija included). */
export function formatAgo(ms: number, now: number, locale: Locale): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return translate(locale, "time.now");
  if (s < 60) return translate(locale, "time.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return translate(locale, "time.minutes", { n: m });
  return formatClock(ms, locale);
}

export function useT() {
  const locale = useI18n((s) => s.locale);
  const meta = LOCALE_META[locale];
  return {
    locale,
    dir: meta.dir,
    t: (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    pct: (value: number) => formatPercent(value, locale),
    ago: (ms: number, now: number) => formatAgo(ms, now, locale),
    clock: (ms: number) => formatClock(ms, locale),
  };
}

/** Applies the stored locale after hydration and keeps <html lang dir> in sync. */
export function I18nDocumentSync() {
  const locale = useI18n((s) => s.locale);
  useEffect(() => {
    void Promise.resolve(useI18n.persist.rehydrate()).then(() => {
      const s = useI18n.getState();
      if (!s.chosen && typeof navigator !== "undefined") {
        const guess = detectLocale(navigator.languages ?? [navigator.language]);
        if (guess !== s.locale) useI18n.setState({ locale: guess });
      }
    });
  }, []);
  useEffect(() => {
    const meta = LOCALE_META[locale];
    document.documentElement.lang = meta.htmlLang;
    document.documentElement.dir = meta.dir;
  }, [locale]);
  return null;
}
