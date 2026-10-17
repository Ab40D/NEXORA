#!/usr/bin/env node
/**
 * Audit probe: what does the browser persist after connecting a bridge, and
 * does "Disconnect" really revoke the session on the bridge?
 *
 * Requires the web app (AUDIT_BASE_URL) and the bridge dev stack (AUDIT_BRIDGE_URL,
 * fake KNX interface, pairing code AUDIT_PAIRING_CODE). Token values are masked.
 *
 *   bridge/.venv/bin/python bridge/tools/dev_stack.py --port 8799 --pairing-code AUDIT-0001 --origin http://127.0.0.1:3100
 *   AUDIT_BASE_URL=http://127.0.0.1:3100 node audit/storage-and-revocation.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:3100";
const BRIDGE = process.env.AUDIT_BRIDGE_URL ?? "http://127.0.0.1:8799";
const CODE = process.env.AUDIT_PAIRING_CODE ?? "AUDIT-0001";
const mask = (v) => (typeof v === "string" && v.length > 8 ? `${v.slice(0, 4)}…(${v.length} chars)` : v);

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Connect KNX" }).click();
await page.getByTestId("mode-bridge").click();
await page.getByTestId("wizard-next").click();
await page.getByLabel("Bridge URL").fill(BRIDGE);
await page.getByRole("button", { name: "Check bridge" }).click();
await page.getByLabel("Pairing code").fill(CODE);
await page.getByRole("button", { name: "Pair" }).click();
await page.getByText("KNX interface", { exact: true }).waitFor();
await page.getByTestId("wizard-next").click();
await page.getByTestId("checks").getByText("Interface responds").waitFor({ timeout: 15000 });
await page.getByTestId("wizard-next").click();
await page.getByLabel("Light group address (switching)").fill("0/0/1");
await page.getByTestId("wizard-next").click();
await page.getByLabel(/Status \/ feedback group address/).fill("0/0/2");
await page.getByTestId("wizard-next").click();
await page.getByText("This operates real equipment").waitFor();
await page.getByRole("button", { name: "Skip test" }).click();
await page.getByRole("button", { name: "Done" }).click();

const dump = () =>
  page.evaluate(() => {
    const read = (s) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
    return { session: read(sessionStorage), local: read(localStorage), cookies: document.cookie };
  });

const before = await dump();
console.log("=== sessionStorage keys after pairing:", Object.keys(before.session));
const bridgeSession = JSON.parse(before.session["se7enx.bridge.session"] ?? "null");
console.log("  se7enx.bridge.session =", bridgeSession && { ...bridgeSession, token: mask(bridgeSession.token) });
console.log("=== localStorage keys:", Object.keys(before.local));
const settings = JSON.parse(before.local["se7enx.settings.v1"] ?? "{}");
console.log("  se7enx.settings.v1.connection =", JSON.stringify(settings?.state?.connection));
console.log("=== cookies:", JSON.stringify(before.cookies));

const token = bridgeSession?.token;
const probe = async () =>
  (await fetch(`${BRIDGE}/api/v1/session`, { headers: { Authorization: `Bearer ${token}`, Origin: new URL(BASE).origin } })).status;
console.log("bridge accepts stored token before Disconnect:", await probe());

await page.getByRole("button", { name: "Disconnect" }).click();
await page.getByTestId("lamp-label").filter({ hasText: "SIMULATION" }).waitFor();
const after = await dump();
console.log("=== after Disconnect — sessionStorage keys:", Object.keys(after.session));
console.log("bridge response to the old token after Disconnect:", await probe(), "(401 = revoked server-side)");
await browser.close();
