import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** Deterministic stand-in for the browser speech service. */
async function installFakeSpeech(page: Page) {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "en-US";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      start() {
        (window as unknown as { __lastLang: string }).__lastLang = this.lang;
        setTimeout(() => this.onstart?.(), 10);
        setTimeout(() => {
          const text = (window as unknown as { __nextTranscript?: string }).__nextTranscript ?? "";
          const alt = { transcript: text, confidence: 0.9 };
          const result = Object.assign([alt], { isFinal: true });
          this.onresult?.({ resultIndex: 0, results: Object.assign([result], {}) });
          this.onend?.();
        }, 120);
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    // Chrome exposes both names; replace both so the real service is never used.
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  });
}

async function say(page: Page, text: string) {
  await page.evaluate((t) => ((window as unknown as { __nextTranscript: string }).__nextTranscript = t), text);
  await page.getByTestId("voice-listen").click();
}

test.describe("voice commands", () => {
  test("allowlisted phrases switch the lamp; other speech is ignored", async ({ page, context }) => {
    await context.grantPermissions(["microphone"]);
    await installFakeSpeech(page);
    await page.goto("/");
    await page.getByRole("tab", { name: /Voice/ }).click();
    await page.getByTestId("enable-voice").click();

    await say(page, "Turn the light on");
    await expect(page.getByTestId("voice-result")).toContainText("ON · executed");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");

    await page.waitForTimeout(600);
    await say(page, "don't turn the light off");
    await expect(page.getByTestId("voice-result")).toContainText("ignored");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · ON");

    await page.getByLabel("Recognition language").selectOption("fr-FR");
    await say(page, "Éteins la lumière");
    await expect(page.getByTestId("voice-result")).toContainText("OFF · executed");
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · OFF");
    expect(await page.evaluate(() => (window as unknown as { __lastLang: string }).__lastLang)).toBe("fr-FR");
  });

  test("emergency stop blocks voice commands", async ({ page, context }) => {
    await context.grantPermissions(["microphone"]);
    await installFakeSpeech(page);
    await page.goto("/");
    await page.getByRole("tab", { name: /Voice/ }).click();
    await page.getByTestId("enable-voice").click();
    await page.getByTestId("emergency-stop").click();
    await expect(page.getByTestId("voice-listen")).toBeDisabled();
  });

  test("unsupported browsers get a clear message and manual fallback", async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });
    await page.goto("/");
    await page.getByRole("tab", { name: /Voice/ }).click();
    await expect(page.getByText("Voice commands not available")).toBeVisible();
  });
});

test.describe("gesture camera", () => {
  test("camera starts only on click and the local hand tracker runs", async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["camera"]);
    await page.goto("/");
    await expect(page.locator("video")).toHaveCount(0); // no camera before explicit action
    await page.getByRole("tab", { name: /Gesture/ }).click();
    await page.getByTestId("enable-camera").click();
    await expect(page.locator("video")).toHaveCount(1);
    // Chromium's fake camera shows no hand: the tracker must report that instead of guessing.
    await expect(page.getByTestId("gesture-pose")).toContainText("No hand", { timeout: 90_000 });
    await expect(page.getByTestId("camera-dock")).toBeVisible(); // global dock, visible on every page
    await page.getByRole("button", { name: "Turn camera off" }).first().click();
    await expect(page.locator("video")).toHaveCount(0);
  });

  test("denied camera permission shows an actionable error", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    await page.goto("/");
    await page.getByRole("tab", { name: /Gesture/ }).click();
    await page.getByTestId("enable-camera").click();
    await expect(page.getByText(/Camera permission was denied/)).toBeVisible();
    await expect(page.getByTestId("manual-on")).toHaveCount(0); // still on gesture tab
  });
});
