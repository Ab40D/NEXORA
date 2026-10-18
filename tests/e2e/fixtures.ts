/**
 * Shared Playwright fixtures.
 *
 * The welcome intro opens on a visitor's first visit. Feature tests start as a returning
 * visitor (intro already seen) in English unless they opt in with `test.use({ showIntro: true })`
 * or choose another language themselves.
 */
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export async function asReturningVisitor(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    try {
      localStorage.setItem("se7enx.intro.v1", "seen");
      if (!localStorage.getItem("se7enx.locale.v1")) {
        localStorage.setItem("se7enx.locale.v1", JSON.stringify({ state: { locale: "en", chosen: true }, version: 1 }));
      }
    } catch {
      /* storage unavailable */
    }
  });
}

export const test = base.extend<{ showIntro: boolean }>({
  showIntro: [false, { option: true }],
  // Playwright's fixture callback is conventionally named `use`; it is renamed here so the React
  // hooks lint rule does not mistake it for React's `use()` hook.
  page: async ({ page, showIntro }, provide) => {
    if (!showIntro) await asReturningVisitor(page);
    await provide(page);
  },
});

/** The original single-light controls live on the "Classic" tab. */
export async function openClassic(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /Classic/ }).click();
}

export { expect };
