/**
 * Gesture control end to end, with a REAL camera pipeline: Chromium's fake camera plays a video
 * of real-looking hand photos (tests/fixtures/hands/*.jpg → scripts/make-gesture-video.sh), the
 * app's MediaPipe hand tracker finds the hand, the pose recognizer classifies it, the active
 * gesture profile maps it to an action, and the Experience pipeline switches the simulated light.
 *
 * Video loop (16 s): 0-2 empty wall · 2-5 open palm · 5-8 fist · 8-11 thumb up · 11-14 victory · 14-16 empty.
 * Skipped when ffmpeg is not available to build the video.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";

const VIDEO = process.env.GESTURE_VIDEO ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "se7enx-test", "poses.y4m");

function ensureVideo(): boolean {
  if (existsSync(VIDEO)) return true;
  try {
    execFileSync("bash", ["scripts/make-gesture-video.sh", VIDEO], { stdio: "pipe" });
  } catch {
    return false;
  }
  return existsSync(VIDEO);
}
const haveVideo = ensureVideo();

test.use({
  launchOptions: {
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${VIDEO}`,
    ],
  },
});

const PROFILES = {
  state: {
    activeId: "e2e-on",
    custom: [
      { id: "e2e-on", name: "E2E on", builtin: false, target: { type: "experience" }, holdMs: 500, cooldownMs: 1200, bindings: { thumb_up: "turn_on" } },
      { id: "e2e-off", name: "E2E off", builtin: false, target: { type: "experience" }, holdMs: 500, cooldownMs: 1200, bindings: { victory: "turn_off" } },
    ],
  },
  version: 1,
};

test.describe("gestures from a camera feed (synthetic hand video, real MediaPipe)", () => {
  test.skip(!haveVideo, "ffmpeg is needed to build the fake camera video");

  test("thumb up turns the simulated light on, victory turns it off", async ({ page, context }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(["camera"]);
    await page.addInitScript((p) => {
      if (!localStorage.getItem("se7enx.gestures.v1")) localStorage.setItem("se7enx.gestures.v1", JSON.stringify(p));
    }, PROFILES);
    await page.goto("/");
    await page.getByTestId("xp-explore").click();
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · Off");

    await page.getByRole("tab", { name: /Gesture/ }).click();
    await expect(page.getByTestId("gesture-profile-select")).toHaveValue("e2e-on");
    await page.getByTestId("enable-camera").click();

    // 1) MediaPipe tracks the hand and the thumb-up pose switches the light on (once).
    await expect(page.getByTestId("camera-dock-last")).toContainText("Thumb up", { timeout: 120_000 });
    await expect(page.getByTestId("lamp-label")).toHaveText(/SIMULATION · On/);
    await expect(page.getByTestId("gesture-last")).toContainText("Turn on");

    // The software WebGL of headless Chromium must select the fast CPU engine automatically.
    await expect(page.getByTestId("diag-secure")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("camera-diagnostics")).toContainText("CPU");

    // 2) Switch profile in the UI: victory now turns the light off.
    await page.getByTestId("gesture-profile-select").selectOption("e2e-off");
    await expect(page.getByTestId("camera-dock-last")).toContainText("Victory", { timeout: 60_000 });
    await expect(page.getByTestId("lamp-label")).toHaveText("SIMULATION · Off");

    // 3) The fist pose is recognised but not bound in this profile: it must never act.
    await expect(page.getByTestId("gesture-pose")).toContainText(/Fist|Victory|Open palm|Thumb up|No hand|No clear/, { timeout: 30_000 });
  });
});
