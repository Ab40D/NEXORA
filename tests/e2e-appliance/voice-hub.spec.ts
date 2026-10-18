/**
 * Local speech end to end (no browser speech service involved): Chromium's fake microphone plays a
 * spoken command once → the app records it with MediaRecorder → POST /api/v1/assistant/transcribe
 * on the hub → the hub's local speech service (SE7ENX_STT_URL, faster-whisper) → transcript →
 * allowlisted command → the hub's simulated light.
 *
 * Needs a running hub with SE7ENX_STT_URL set and a speech WAV:
 *   VOICE_WAV=/path/turn_on_the_light.wav APPLIANCE_URL=... APPLIANCE_PAIRING_CODE=... \
 *   npx playwright test -c playwright.appliance.config.ts voice-hub
 * Skipped when VOICE_WAV is not set.
 */
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const WAV = process.env.VOICE_WAV ?? "";
const CODE = process.env.APPLIANCE_PAIRING_CODE ?? "";
const OWNER = { name: "Amina B.", username: "amina", password: "violet tram sings at dawn 42" };

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}%noloop`],
  },
});

async function signInOwner(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("se7enx.intro.v1", "seen");
  });
  await page.goto("/");
  const setup = page.getByTestId("setup-form");
  const signin = page.getByTestId("signin-form");
  await expect(setup.or(signin)).toBeVisible();
  if (await setup.isVisible()) {
    await page.getByLabel("Setup code").fill(CODE);
    await page.getByLabel("Your name").fill(OWNER.name);
    await page.getByLabel("Username", { exact: true }).fill(OWNER.username);
    await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await page.getByLabel("Repeat the password").fill(OWNER.password);
    await page.getByTestId("setup-submit").click();
  } else {
    await page.getByLabel("Username or e-mail").fill(OWNER.username);
    await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await page.getByTestId("signin-submit").click();
  }
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await page.getByTestId("language-switcher").selectOption("en");
}

test.describe("voice via the hub's local speech service", () => {
  test.skip(!WAV || !existsSync(WAV), "set VOICE_WAV to a recorded command (e.g. 'Turn on the light')");

  test("a spoken command is transcribed on the hub and switches the light", async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["microphone"]);
    await signInOwner(page);

    // make sure the light starts off, then select it as the target
    await page.getByTestId("header-connect").click();
    await page.getByTestId("use-sim-living-light").click();
    await page.getByRole("tab", { name: /Voice/ }).click();
    await expect(page.getByTestId("voice-active-engine")).toHaveAttribute("data-engine", "hub");
    await page.getByTestId("enable-voice").click();
    await page.getByTestId("voice-listen").click();

    await expect(page.getByTestId("voice-heard")).toContainText(/turn on the light/i, { timeout: 60_000 });
    await expect(page.getByTestId("voice-result")).toContainText("executed", { timeout: 30_000 });
  });
});
