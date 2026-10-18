import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/fixtures";

/**
 * Runs against a REAL hub serving the appliance UI (same origin), started with SE7ENX_SAMPLE_DEVICES=true and a fixed
 * setup code (APPLIANCE_PAIRING_CODE). The first test to run creates the owner account; later tests sign in.
 */
const CODE = process.env.APPLIANCE_PAIRING_CODE ?? "";
const OWNER = { name: "Amina B.", username: "amina", password: "violet tram sings at dawn 42" };
const TECH = { name: "Karim T.", username: "karim", password: "brass lantern hums near quiet docks" };

/** Owner setup on first run, otherwise sign-in (the hub keeps its accounts between tests). */
async function signInOwner(page: Page) {
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
  // The language follows the account (it may have been changed in an earlier session): pin English for the assertions.
  await page.getByTestId("language-switcher").selectOption("en");
}

async function signOut(page: Page) {
  await page.getByTestId("account-menu").click();
  await page.getByTestId("account-signout").click();
  await expect(page.getByTestId("signin-form")).toBeVisible();
}

test("appliance: owner setup, control simulated devices, add/remove, hub emergency stop", async ({ page, baseURL }) => {
  test.skip(!CODE, "APPLIANCE_PAIRING_CODE not set");
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) offOrigin.push(r.url());
  });

  await signInOwner(page);
  await expect(page).toHaveTitle(/SE7ENX/);
  await page.getByRole("tab", { name: /Devices/ }).click();
  await expect(page.getByTestId("devices-panel")).toBeVisible();

  // simulated sample devices, clearly labelled
  const light = page.getByTestId("device-sim-living-light");
  await expect(light).toBeVisible();
  await expect(light.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(page.getByTestId("device-sim-hall-temperature").getByText("Read-only sensor.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Integrations" })).toContainText("Shelly");

  // known starting point: earlier sessions may have left the light on (then "On" is truthfully "already", nothing sent)
  await light.getByRole("button", { name: "Off" }).click();
  await expect(light).toContainText("Reported: Off");
  await page.waitForTimeout(400); // hub per-device minimum interval
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
  await signInOwner(page);
  await page.getByTestId("header-connect").click();
  await expect(page.getByTestId("hub-ready")).toBeVisible();
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

test("appliance: building from a template, device placement, user with a one-time code, role limits enforced", async ({ page, baseURL }) => {
  test.skip(!CODE, "APPLIANCE_PAIRING_CODE not set");
  await signInOwner(page);

  // building model: template → rooms; place the simulated living light in the Living room
  await page.getByRole("tab", { name: /Building/ }).click();
  const panel = page.getByTestId("building-panel");
  await expect(panel).toBeVisible();
  if (await page.getByTestId("building-empty").isVisible()) await page.getByTestId("template-apartment").click();
  await expect(panel.getByText("Living room", { exact: true }).first()).toBeVisible();
  const livingId = await panel.locator('[data-testid^="room-"]', { hasText: "Living room" }).first().getAttribute("data-testid");
  const place = page.getByTestId("place-sim-living-light");
  await place.selectOption({ label: "Ground floor · Living room" });
  await expect(page.locator(`[data-testid="${livingId}"]`).getByTestId("placed-sim-living-light")).toBeVisible();

  // a technician account created without a password gets a single-use setup code
  await page.getByRole("tab", { name: /Settings/ }).click();
  if ((await page.getByTestId(`user-${TECH.username}`).count()) === 0) {
    const form = page.getByTestId("add-user-form");
    await form.getByLabel("Name", { exact: true }).fill(TECH.name);
    await form.getByLabel("Username", { exact: true }).fill(TECH.username);
    await form.getByLabel("Role").selectOption("technician");
    await page.getByTestId("add-user-submit").click();
  } else {
    await page.getByTestId(`user-${TECH.username}`).getByRole("button", { name: "Reset code" }).click();
  }
  const code = (await page.getByTestId("one-time-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  await expect(page.getByTestId("roles-matrix")).toBeVisible();

  // the ledger shows what happened, through which interface
  await page.getByRole("tab", { name: /Activity/ }).click();
  await expect(page.getByTestId("activity-list")).toContainText("placed a device");
  await signOut(page);

  // the technician redeems the code and chooses their own password
  await page.getByTestId("to-reset").click();
  await page.getByLabel("Reset code").fill(code);
  await page.getByLabel("Password", { exact: true }).fill(TECH.password);
  await page.getByLabel("Repeat the password").fill(TECH.password);
  await page.getByTestId("reset-submit").click();
  await expect(page.getByTestId("account-menu")).toBeVisible();

  // technician: building is read-only, no user management, devices can be operated
  await page.getByRole("tab", { name: /Building/ }).click();
  await expect(page.getByText(/Changing it needs the/)).toBeVisible();
  await expect(page.getByTestId("place-sim-living-light")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add room" })).toHaveCount(0);
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("users-list")).toHaveCount(0);

  // the server enforces it too, whatever the UI shows (cookie session + same-origin request)
  const api = page.request;
  const headers = { Origin: baseURL!, "Content-Type": "application/json" };
  const rename = await api.patch("/api/v1/devices/sim-living-light", { headers, data: { name: "Hacked" } });
  expect(rename.status()).toBe(403);
  expect((await rename.json()).error.code).toBe("FORBIDDEN");
  const cmd = await api.post("/api/v1/devices/sim-living-light/commands", { headers, data: { command: "turn_on", requestId: `e2e-${Date.now()}`, source: "manual" } });
  expect(cmd.status()).toBe(200);
  expect((await cmd.json()).outcome).toBe("simulated");
  const csrf = await api.post("/api/v1/safety/stop", { headers: { "Content-Type": "application/json" }, data: {} });
  expect(csrf.status(), "cookie-authenticated POST without a same-origin Origin is refused").toBe(403);
  await signOut(page);
});

test("appliance: guests explore the simulation without seeing the building; sign-in errors are localized", async ({ page }) => {
  test.skip(!CODE, "APPLIANCE_PAIRING_CODE not set");
  await page.goto("/");
  await expect(page.getByTestId("signin-form")).toBeVisible();

  // wrong password: one generic, localized message (French)
  await page.getByTestId("language-switcher").selectOption("fr");
  await page.getByLabel("Nom d’utilisateur ou e-mail").fill(OWNER.username);
  await page.getByLabel("Mot de passe", { exact: true }).fill("not the right passphrase");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("auth-error")).toHaveText("Le nom d’utilisateur ou le mot de passe est incorrect.");

  // guest: simulation only, no building data, a quiet banner, no repeated prompts
  await page.getByTestId("continue-guest").click();
  await expect(page.getByTestId("guest-banner")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Bâtiment/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /Appareils/ }).click();
  await expect(page.getByTestId("hub-signin")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("guest-banner")).toBeVisible(); // the choice is remembered
  await expect(page.getByTestId("signin-form")).toHaveCount(0);
});
