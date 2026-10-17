import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/fixtures";

const CODE = process.env.APPLIANCE_PAIRING_CODE ?? "";

test("appliance: pair, control simulated devices, add/remove, hub emergency stop", async ({ page, baseURL }) => {
  test.skip(!CODE, "APPLIANCE_PAIRING_CODE not set");
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) offOrigin.push(r.url());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/SE7ENX/);
  await page.getByRole("tab", { name: /Devices/ }).click();

  // inline pairing with the hub that served this page
  await expect(page.getByText("Pair with this SE7ENX hub")).toBeVisible();
  await page.getByLabel("Pairing code").fill(CODE);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByTestId("devices-panel")).toBeVisible();

  // simulated sample devices, clearly labelled
  const light = page.getByTestId("device-sim-living-light");
  await expect(light).toBeVisible();
  await expect(light.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(page.getByTestId("device-sim-hall-temperature").getByText("Read-only sensor.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Integrations" })).toContainText("Shelly");

  await light.getByRole("button", { name: "On" }).click();
  await expect(light.getByRole("status")).toContainText("Simulated (no hardware)");
  await expect(light).toContainText("Reported: On");

  // one command when the slider is committed (keyboard: End = 100 %)
  await light.getByRole("slider", { name: "Brightness (absolute)" }).focus();
  await page.keyboard.press("End");
  await expect(light).toContainText("100%");

  // add a simulated device through the dialog
  await page.getByRole("button", { name: "Add device" }).click();
  await page.getByRole("tab", { name: "Simulated" }).click();
  await page.getByLabel("Name").fill("E2E fan (simulated)");
  await page.getByLabel("Device type").selectOption("switch");
  await page.getByRole("button", { name: "Add simulated device" }).click();
  const fan = page.getByTestId("device-e2e-fan-simulated");
  await expect(fan).toBeVisible();

  // hub-wide emergency stop (simulated devices stay usable; real devices would be blocked)
  await page.getByTestId("hub-safety").click();
  await expect(page.getByText(/Hub emergency stop active/)).toBeVisible();
  await page.getByTestId("hub-safety").click();
  await expect(page.getByText(/Hub emergency stop active/)).toHaveCount(0);

  // export downloads a credential-free JSON file
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export configuration/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^se7enx-config-.*\.json$/);

  // remove the test device
  page.once("dialog", (d) => void d.accept());
  await fan.getByRole("button", { name: "Remove" }).click();
  await expect(fan).toHaveCount(0);

  // appliance wizard: no browser-side Home Assistant mode (HA runs server-side in the hub)
  await page.getByTestId("header-connect").click();
  await page.getByTestId("legacy-wizard").click();
  await expect(page.getByTestId("mode-bridge")).toContainText("This SE7ENX hub (KNX)");
  await expect(page.getByTestId("mode-homeassistant")).toHaveCount(0);

  expect(offOrigin, "the appliance UI must not contact any other origin").toEqual([]);
});

async function pairFromWorkspace(page: Page) {
  await page.goto("/");
  await page.getByTestId("header-connect").click();
  await expect(page.getByText("Pair with this SE7ENX hub")).toBeVisible();
  await page.getByLabel("Pairing code").fill(CODE);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByTestId("hub-ready")).toBeVisible();
}

async function chat(page: Page, text: string) {
  const replies = page.locator('[data-testid="chat-log"] [data-role="assistant"]');
  const before = await replies.count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send").click();
  await expect(replies).toHaveCount(before + 1);
  return replies.last();
}

test("appliance: Smart Light Experience drives hub devices through the hub pipeline", async ({ page }) => {
  test.skip(!CODE, "APPLIANCE_PAIRING_CODE not set");
  await pairFromWorkspace(page);
  await expect(page.getByTestId("provider-shelly")).toBeVisible();

  // on/off-only device: no brightness slider is rendered and dimming requests are refused
  await page.getByTestId("use-sim-desk-outlet").click();
  await expect(page.getByTestId("experience-panel")).toBeVisible();
  await expect(page.getByTestId("hw-badge")).toHaveText("SIMULATION"); // hub-simulated device, labelled honestly
  await expect(page.getByTestId("not-dimmable")).toBeVisible();
  await expect(page.getByTestId("brightness-control")).toHaveCount(0);
  await expect(await chat(page, "Set the brightness to 50%")).toContainText("can't be dimmed");

  // dimmable device: absolute + relative dimming resolved by the hub, "already" decided by the hub
  await page.getByTestId("xp-change").click();
  await page.getByTestId("use-sim-living-light").click();
  await page.getByTestId("preset-50").click();
  await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 50%");
  await expect(await chat(page, "Increase brightness by 10%")).toContainText("Brightness set to 60% (simulation).");
  await expect(page.getByTestId("brightness-confirmed")).toHaveText("Confirmed 60%");
  await page.waitForTimeout(400); // hub per-device minimum interval
  await expect(await chat(page, "Turn on the light")).toContainText("The light is already on.");
  await expect(page.getByTestId("exec-status")).toHaveAttribute("data-state", "already");
  await page.waitForTimeout(400);
  await expect(await chat(page, "طفّي الضو")).toContainText("الضو راهو طافي (سيمولاسيون).");
  await expect(page.getByTestId("lamp-label")).toContainText("Off");
});
