import { asReturningVisitor, expect, openClassic, test } from "./fixtures";

test.describe("simulation mode", () => {
  test("opens immediately in simulation and is clearly labelled", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · OFF");
    await expect(page.getByText("Simulated lamp — no real hardware is being controlled.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("confirmed-state")).toHaveText("n/a");
  });

  test("manual control and lamp toggle switch the simulated lamp", async ({ page }) => {
    await page.goto("/");
    await openClassic(page);
    await page.getByTestId("manual-on").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");
    await expect(page.getByTestId("requested-state")).toHaveText("ON");
    await expect(page.getByTestId("simulated-state")).toHaveText("ON");
    await page.waitForTimeout(600); // client-side minimum interval between commands
    await page.getByRole("button", { name: /Toggle light \(simulation/ }).click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · OFF");
  });

  test("history records requested and applied commands", async ({ page, isMobile }) => {
    await page.goto("/");
    await openClassic(page);
    await page.getByTestId("manual-on").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");
    await page.getByRole("tab", { name: isMobile ? /Log/ : /History/ }).click();
    const history = page.getByTestId("history");
    await expect(history.getByText("ON applied to simulation")).toBeVisible();
    await expect(history.getByText("ON requested")).toBeVisible();
  });

  test("emergency stop is always visible and blocks hands-free input", async ({ page }) => {
    await page.goto("/");
    const stop = page.getByTestId("emergency-stop");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.getByText(/Emergency stop active/).first()).toBeVisible();
    await stop.click();
    await expect(page.getByText(/Emergency stop active/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByText(/Emergency stop active/).first()).toBeVisible();
  });

  test("keyboard users can operate the light with visible focus", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard test on desktop");
    await page.goto("/");
    await openClassic(page);
    const on = page.getByTestId("manual-on");
    await on.focus();
    await expect(on).toBeFocused();
    const outline = await on.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");
  });

  test("responsive layout has no horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("falls back to a 2D lamp when WebGL is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, ...a: unknown[]) => unknown;
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          if (/webgl/.test(type)) return null; // simulate a device without WebGL
          return orig.call(this, type, ...rest);
        },
      });
    });
    await page.goto("/");
    await openClassic(page);
    await expect(page.getByText("2D fallback")).toBeVisible();
    await page.getByTestId("manual-on").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");
  });

  test("respects reduced motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await asReturningVisitor(ctx);
    const page = await ctx.newPage();
    await page.goto("/");
    await openClassic(page);
    await page.getByTestId("manual-on").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");
    await ctx.close();
  });
});
