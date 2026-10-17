"use client";

import { Languages } from "lucide-react";
import { LOCALE_META, LOCALES, isLocale, useI18n, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Manual language selection (native select: accessible on every device and screen reader). */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, locale } = useT();
  const setLocale = useI18n((s) => s.setLocale);
  return (
    <label className={cn("relative inline-flex items-center", className)}>
      <span className="sr-only">{t("common.language")}</span>
      <Languages className="pointer-events-none absolute start-2 h-3.5 w-3.5 text-ink-300" aria-hidden />
      <select
        data-testid="language-switcher"
        value={locale}
        onChange={(e) => {
          if (isLocale(e.target.value)) setLocale(e.target.value);
        }}
        className="h-8 appearance-none rounded-lg border border-ink-600 bg-ink-900/80 pe-2 ps-7 text-xs text-ink-100 hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={LOCALE_META[l].htmlLang} dir={LOCALE_META[l].dir}>
            {LOCALE_META[l].native}
          </option>
        ))}
      </select>
    </label>
  );
}
