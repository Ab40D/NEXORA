import { expect, test } from "@playwright/test";

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
  await expect(light).toContainText("100 %");

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
  await page.getByRole("button", { name: /Connect KNX/ }).first().click();
  await expect(page.getByTestId("mode-bridge")).toContainText("This SE7ENX hub (KNX)");
  await expect(page.getByTestId("mode-homeassistant")).toHaveCount(0);

  expect(offOrigin, "the appliance UI must not contact any other origin").toEqual([]);
});
