#!/usr/bin/env node
/**
 * Audit probe: which network requests does the SE7ENX web app make, and to whom?
 *
 * Loads the app, uses simulation, then enables the camera (Chromium fake device)
 * and keeps hand tracking running for AUDIT_CAMERA_SECONDS. Every request that
 * leaves the app's origin is RECORDED AND ABORTED — nothing is delivered to a
 * third party during the audit.
 *
 *   AUDIT_BASE_URL=http://127.0.0.1:3100 AUDIT_CAMERA_SECONDS=75 node audit/network-egress.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:3100";
const CAMERA_SECONDS = Number(process.env.AUDIT_CAMERA_SECONDS ?? 75);
const origin = new URL(BASE).origin;

function printableStrings(buf, min = 4) {
  const out = [];
  let cur = "";
  for (const b of buf) {
    if (b >= 32 && b < 127) cur += String.fromCharCode(b);
    else {
      if (cur.length >= min) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(["camera", "microphone"], { origin });

const sameOrigin = new Map();
const offOrigin = [];
await context.route("**/*", async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
  if (u.origin === origin) {
    const key = u.pathname.split("/").slice(0, 3).join("/") || "/";
    sameOrigin.set(key, (sameOrigin.get(key) ?? 0) + 1);
    return route.continue();
  }
  const body = req.postDataBuffer();
  offOrigin.push({
    at: new Date().toISOString(),
    method: req.method(),
    url: `${u.origin}${u.pathname}`,
    resourceType: req.resourceType(),
    headerNames: Object.keys(req.headers()).sort(),
    bodyBytes: body?.length ?? 0,
    bodyStrings: body ? printableStrings(body).slice(0, 25) : [],
  });
  return route.abort("blockedbyclient");
});

const page = await context.newPage();
const t0 = Date.now();
const phase = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

await page.goto(BASE, { waitUntil: "networkidle" });
phase("page loaded (simulation)");
await page.getByTestId("manual-on").click();
await page.waitForTimeout(1000);
phase("simulated ON");
await page.getByRole("tab", { name: /Gesture/ }).click();
await page.getByTestId("enable-camera").click();
await page.getByText("No hand detected").first().waitFor({ timeout: 90_000 });
phase(`hand tracking running — keeping camera on for ${CAMERA_SECONDS}s`);
await page.waitForTimeout(CAMERA_SECONDS * 1000);
await page.getByRole("button", { name: "Turn camera off" }).first().click();
await page.waitForTimeout(2000);
phase("camera off");
await browser.close();

console.log("\n=== same-origin requests (path prefix → count)");
for (const [k, v] of [...sameOrigin.entries()].sort()) console.log(`  ${k.padEnd(28)} ${v}`);
console.log(`\n=== off-origin requests: ${offOrigin.length} (all aborted)`);
for (const r of offOrigin) {
  console.log(`  ${r.at} ${r.method} ${r.url} [${r.resourceType}] body=${r.bodyBytes}B`);
  console.log(`    header names: ${r.headerNames.join(", ")}`);
  if (r.bodyStrings.length) console.log(`    printable strings in body: ${JSON.stringify(r.bodyStrings)}`);
}
