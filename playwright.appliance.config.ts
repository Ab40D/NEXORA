import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against a RUNNING appliance container (deploy/appliance/compose.yaml).
 *   APPLIANCE_URL=http://127.0.0.1:8787 APPLIANCE_PAIRING_CODE=XXXX npx playwright test -c playwright.appliance.config.ts
 * The container must be started with SE7ENX_SAMPLE_DEVICES=true.
 */
export default defineConfig({
  testDir: "tests/e2e-appliance",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: process.env.APPLIANCE_URL ?? "http://127.0.0.1:8787",
    trace: "retain-on-failure",
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
