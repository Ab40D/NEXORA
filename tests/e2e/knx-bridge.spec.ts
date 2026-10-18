/**
 * Wizard + real KNX path against the SE7ENX Bridge dev stack
 * (real bridge + xknx → FAKE KNXnet/IP interface; no hardware involved).
 */
import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const BRIDGE = "http://127.0.0.1:8799";
const hasBridge = existsSync("bridge/.venv/bin/python");

/** The original connection wizard is reachable from the Connect workspace ("legacy" link). */
async function openLegacyWizard(page: Page) {
  await page.goto("/");
  await page.getByTestId("header-connect").click();
  await page.getByTestId("legacy-wizard").click();
}

async function openBridgeStep(page: Page) {
  await openLegacyWizard(page);
  await page.getByTestId("mode-bridge").click();
  await page.getByTestId("wizard-next").click();
}

test.describe("wizard validation", () => {
  test("rejects malformed URLs and asks only for relevant fields", async ({ page }) => {
    await openBridgeStep(page);
    const url = page.getByLabel("Bridge URL");
    await url.fill("bridge.local:8787");
    await expect(page.getByText(/Include the scheme/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Check bridge" })).toBeDisabled();
    await url.fill("https://user:pw@bridge.local");
    await expect(page.getByText(/credentials/)).toBeVisible();
    // pairing field only appears after the bridge was found
    await expect(page.getByLabel("Pairing code")).toHaveCount(0);
  });

  test("Home Assistant path asks for an https URL and offers OAuth sign-in (no token field)", async ({ page }) => {
    await openLegacyWizard(page);
    await page.getByTestId("mode-homeassistant").click();
    await page.getByTestId("wizard-next").click();
    await page.getByLabel("Home Assistant URL").fill("https://ha.example.com/lovelace");
    await expect(page.getByText(/base URL only/)).toBeVisible();
    await page.getByLabel("Home Assistant URL").fill("https://ha.example.com");
    await expect(page.getByRole("button", { name: "Sign in with Home Assistant" })).toBeEnabled();
    await expect(page.getByLabel(/token/i)).toHaveCount(0);
  });

  test("unreachable bridge produces an actionable error", async ({ page }) => {
    await openBridgeStep(page);
    // Nothing listens here over HTTP, just like the dev stack's internal fake-KNX UDP port that
    // users mistook for the bridge URL ("Cannot reach the SE7ENX Bridge at http://127.0.0.1:57096").
    await page.getByLabel("Bridge URL").fill("http://127.0.0.1:9");
    await page.getByRole("button", { name: "Check bridge" }).click();
    await expect(page.getByText(/Cannot reach the SE7ENX Bridge at http:\/\/127\.0\.0\.1:9/)).toBeVisible({ timeout: 15_000 });
    const origin = new URL(page.url()).origin;
    const hint = page.getByText(/SE7ENX_ALLOWED_ORIGINS/);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("default port 8787");
    await expect(hint).toContainText("“Bridge URL” line");
    await expect(hint).toContainText("UDP port 3671");
    await expect(hint).toContainText(`Rejected request from origin '${origin}'`);
  });

  test("warns when the KNX interface port is entered instead of the bridge", async ({ page }) => {
    await openBridgeStep(page);
    await page.getByLabel("Bridge URL").fill("http://192.168.1.20:3671");
    await expect(page.getByText(/Port 3671 is the KNXnet\/IP port of KNX interfaces/)).toBeVisible();
    await page.getByLabel("Bridge URL").fill("http://192.168.1.20:8787");
    await expect(page.getByText(/Port 3671 is the KNXnet\/IP port/)).toHaveCount(0);
  });
});

test.describe("real KNX path via the bridge (fake interface)", () => {
  test.skip(!hasBridge, "bridge virtualenv not available");

  test("pair, test, configure, confirm and control", async ({ page }) => {
    await openBridgeStep(page);
    await page.getByLabel("Bridge URL").fill(BRIDGE);
    await page.getByRole("button", { name: "Check bridge" }).click();
    await page.getByLabel("Pairing code").fill("WRONG-0000");
    await page.getByRole("button", { name: "Pair" }).click();
    await expect(page.getByText(/pairing code is wrong/i)).toBeVisible();
    await page.getByLabel("Pairing code").fill("e2e-test1");
    await page.getByRole("button", { name: "Pair" }).click();
    await expect(page.getByText("KNX interface", { exact: true })).toBeVisible();

    await page.getByTestId("wizard-next").click(); // → connectivity test
    await expect(page.getByTestId("checks").getByText("Interface responds")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("wizard-next").click(); // → address

    const ga = page.getByLabel("Light group address (switching)");
    await ga.fill("1/2/3");
    await expect(page.getByText(/does not permit/)).toBeVisible();
    await expect(page.getByTestId("wizard-next")).toBeDisabled();
    await ga.fill("32/0/1");
    await expect(page.getByText(/Main group must be between 0 and 31/)).toBeVisible();
    await ga.fill("0/0/1");
    await expect(page.getByText(/does not prove/)).toBeVisible();
    await page.getByTestId("wizard-next").click(); // → status

    await page.getByLabel(/Status \/ feedback group address/).fill("0/0/2");
    await page.getByTestId("wizard-next").click(); // activate → test command
    await expect(page.getByText("This operates real equipment")).toBeVisible();
    await expect(page.getByTestId("test-on")).toBeDisabled(); // needs explicit acknowledgement
    await page.getByLabel(/I understand/).check();
    await page.getByTestId("test-on").click();
    await expect(page.getByText(/ON: The KNX interface confirmed transmission/)).toBeVisible();
    await page.getByTestId("wizard-next").click();
    await page.getByRole("button", { name: "Done" }).click();

    await expect(page.getByTestId("mode-badge")).toHaveText("Live KNX · Bridge");
    await expect(page.getByTestId("lamp-label")).toHaveText("ON");
    await expect(page.getByText("Confirmed by actuator status feedback.").first()).toBeVisible();
    await expect(page.getByTestId("confirmed-state")).toHaveText("ON");

    await page.getByTestId("manual-off").click();
    await expect(page.getByTestId("confirmed-state")).toHaveText("OFF");
    await expect(page.getByTestId("lamp-label")).toHaveText("OFF");

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("lamp-label")).toHaveText(/SIMULATION/);
  });
});
