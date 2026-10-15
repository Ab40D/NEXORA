import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3100;
const BRIDGE_PORT = 8799;
const hasBridge = existsSync("bridge/.venv/bin/python");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /simulation\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `npx next start -p ${WEB_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    ...(hasBridge
      ? [
          {
            command: `bridge/.venv/bin/python bridge/tools/dev_stack.py --port ${BRIDGE_PORT} --pairing-code E2E-TEST1 --origin http://localhost:${WEB_PORT}`,
            url: `http://127.0.0.1:${BRIDGE_PORT}/api/v1/health`,
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ]
      : []),
  ],
});
