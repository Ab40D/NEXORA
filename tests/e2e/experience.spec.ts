/**
 * Phase E journey: welcome intro, connection workspace, Smart Light Experience (simulation),
 * "Talk to SE7ENX" in four languages, right-to-left layout and the emergency stop.
 * Everything here runs against the in-browser SIMULATION — no hub and no hardware.
 */
import type { Page } from "@playwright/test";
import { asReturningVisitor, expect, test } from "./fixtures";

const lastReply = (page: Page) => page.locator('[data-testid="chat-log"] [data-role="assistant"]').last();

async function chat(page: Page, text: string) {
  const replies = page.locator('[data-testid="chat-log"] [data-role="assistant"]');
  const before = await replies.count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  await expect(replies).toHaveCount(before + 1);
}

test.describe("welcome intro (first visit)", () => {
  test.use({ showIntro: true });

  test("plays once, can be skipped, replayed, and Esc does not trigger the emergency stop", async ({ page }) => {
    await page.goto("/");
    const intro = page.getByTestId("welcome-intro");
    await expect(intro).toBeVisible();
    await expect(intro).toHaveAttribute("data-phase", "4", { timeout: 10_000 });
    await expect(intro.getByRole("heading", { name: "Welcome to SE7ENX Smart Light Experience" })).toBeVisible();
    await expect(page.getByTestId("intro-connect")).toHaveText("Connect Your Real Light");
    await expect(page.getByTestId("intro-explore")).toHaveText("Explore Simulation");
    // never claims the welcome was spoken unless the browser really started speaking
    const voice = await page.getByTestId("intro-voice").getAttribute("data-voice");
    if (voice !== "speaking" && voice !== "done") await expect(page.getByText("Speaking…")).toHaveCount(0);

    await page.getByTestId("intro-skip").click();
    await expect(intro).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("experience-empty")).toBeVisible();
    await expect(page.getByTestId("welcome-intro")).toHaveCount(0); // first visit only

    await page.getByTestId("replay-intro").click();
    await expect(page.getByTestId("welcome-intro")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("welcome-intro")).toHaveCount(0);
    await expect(page.getByTestId("emergency-stop")).toHaveAttribute("aria-pressed", "false");
  });

  test("Explore Simulation opens the experience with an honest SIMULATION badge", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("welcome-intro")).toHaveAttribute("data-phase", "4", { timeout: 10_000 });
    await page.getByTestId("intro-explore").click();
    await expect(page.getByTestId("experience-panel")).toBeVisible();
    await expect(page.getByTestId("hw-badge")).toHaveText("SIMULATION");
    await expect(page.getByTestId("target-badge")).toContainText("SIMULATION");
  });

  test("Connect Your Real Light opens the connection workspace", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("welcome-intro")).toHaveAttribute("data-phase", "4", { timeout: 10_000 });
    await page.getByTestId("intro-connect").click();
    const ws = page.getByTestId("connect-workspace");
    await expect(ws).toBeVisible();
    for (const id of ["provider-sim", "provider-ha", "provider-knx", "provider-shelly"]) await expect(page.getByTestId(id)).toBeVisible();
    // without a SE7ENX hub, real providers say so instead of pretending to be configured
    await expect(page.getByTestId("provider-ha-stage")).toHaveAttribute("data-stage", "needsHub");
    await expect(page.getByTestId("provider-sim-stage")).toHaveAttribute("data-stage", "ready");
  });

  test("reduced motion shows the final frame immediately", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("welcome-intro")).toHaveAttribute("data-phase", "4");
    await expect(page.getByTestId("intro-explore")).toBeVisible();
    await ctx.close();
  });
});

test.describe("Smart Light Experience — simulation", () => {
  test("switches and dims; requested and simulated state stay separate", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("xp-explore").click();
    await page.getByTestId("xp-on").click();
    await expect(page.getByTestId("exec-status")).toHaveAttribute("data-state", "simulated");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · On · 70%");

    await page.getByTestId("preset-25").click();
    await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 25%");
    await page.getByTestId("dim-up").click();
    await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 35%");
    await page.getByTestId("dim-down").click();
    await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 25%");

    await page.getByTestId("xp-on").click();
    await expect(page.getByTestId("exec-status")).toHaveAttribute("data-state", "already");

    // keyboard: one command when the value is committed
    await page.getByTestId("xp-brightness-thumb").focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 100%");
    await expect(page.getByTestId("xp-strip-confirmed")).toHaveText("On · 100%");
    await expect(page.getByTestId("xp-strip-requested")).toHaveText("Brightness 100%");

    await page.getByTestId("xp-off").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · Off");
  });

  test("Talk to SE7ENX understands English, French, Arabic and Darija and never guesses", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("xp-explore").click();

    await chat(page, "Turn on the light");
    await expect(lastReply(page)).toContainText("The light is on (simulation).");
    await chat(page, "Turn on the light");
    await expect(lastReply(page)).toContainText("The light is already on.");
    await chat(page, "Mets la luminosité à 60 %");
    await expect(lastReply(page)).toContainText("Luminosité réglée à 60");
    await chat(page, "نقصلي الضوء بـ 20 بالمية");
    await expect(lastReply(page)).toContainText("خلّيت الضو على");
    await expect(lastReply(page)).toContainText("40%");
    await chat(page, "هل الإضاءة مشغلة؟");
    await expect(lastReply(page)).toContainText("الإضاءة مشغّلة بسطوع");
    await chat(page, "خويا شعل الضو");
    await expect(lastReply(page)).toContainText("خويا، راه شاعل بالفعل.");
    await chat(page, "60");
    await expect(lastReply(page)).toContainText("Do you mean brightness 60%?");
    await chat(page, "don't turn off the light");
    await expect(lastReply(page)).toContainText("Sorry, I didn't understand");
    await expect(page.getByTestId("lamp-label")).toHaveText(/On · 40%/);
  });

  test("Arabic and Darija layouts are right-to-left; the choice persists", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("language-switcher").selectOption("dz");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar-DZ");
    expect(await page.getByRole("tablist").first().evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    await page.getByTestId("xp-explore").click();
    await expect(page.getByTestId("hw-badge")).toHaveText("سيمولاسيون");
    await page.getByTestId("preset-50").click();
    await expect(page.getByTestId("brightness-confirmed")).toContainText("50%");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByTestId("language-switcher").selectOption("ar");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("tab", { name: /التجربة/ })).toBeVisible();
    await page.getByTestId("language-switcher").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("the emergency stop blocks assistant commands while manual control keeps working", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("xp-explore").click();
    await page.getByTestId("emergency-stop").click();
    await chat(page, "Turn on the light");
    await expect(lastReply(page)).toContainText("The emergency stop is active");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · Off");
    await page.getByTestId("xp-on").click();
    await expect(page.getByTestId("exec-status")).toHaveAttribute("data-state", "simulated");
    await page.getByTestId("emergency-stop").click();
  });

  test("the selected light is remembered for returning visitors", async ({ browser }) => {
    const ctx = await browser.newContext();
    await asReturningVisitor(ctx);
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByTestId("xp-explore").click();
    await expect(page.getByTestId("experience-panel")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("experience-panel")).toBeVisible();
    await expect(page.getByTestId("target-name")).toHaveText("SE7ENX");
    await ctx.close();
  });
});
