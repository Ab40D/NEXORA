/**
 * Contract test: the web app's typed BridgeClient against the REAL Python
 * SE7ENX Bridge (xknx), which tunnels over KNXnet/IP UDP to the fake KNX
 * interface. Verifies that every response conforms to the zod contract.
 *
 * Requires the bridge virtualenv (bridge/.venv). Skipped otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeAdapter } from "@/lib/adapters/bridge-adapter";
import type { AdapterEvent } from "@/lib/adapters/types";
import { BridgeClient } from "@/lib/bridge/client";

const root = path.resolve(import.meta.dirname, "../..");
const python = path.join(root, "bridge/.venv/bin/python");
const available = existsSync(python);
const ORIGIN = "http://localhost:3000";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function waitForLine(proc: ChildProcess, re: RegExp, ms = 15000): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${re} — output:\n${buf}`)), ms);
    const on = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    proc.stdout?.on("data", on);
    proc.stderr?.on("data", on);
  });
}

describe.skipIf(!available)("contract: web client ↔ real SE7ENX Bridge ↔ fake KNXnet/IP interface", () => {
  let fake: ChildProcess;
  let bridge: ChildProcess;
  let baseUrl = "";

  beforeAll(async () => {
    const fakePort = await freePort();
    fake = spawn(python, ["tools/fake_knx_interface.py", "--port", String(fakePort), "--switch", "0/0/1", "--status", "0/0/2"], {
      cwd: path.join(root, "bridge"),
    });
    await waitForLine(fake, /listening on/);
    const port = await freePort();
    bridge = spawn(python, ["-m", "se7enx_bridge"], {
      cwd: path.join(root, "bridge"),
      env: {
        ...process.env,
        SE7ENX_PORT: String(port),
        SE7ENX_ALLOWED_ORIGINS: ORIGIN,
        SE7ENX_PAIRING_CODE: "CONTRACT1",
        SE7ENX_ALLOWED_GROUP_ADDRESSES: "0/0/1-9",
        SE7ENX_KNX_GATEWAY_IP: "127.0.0.1",
        SE7ENX_KNX_GATEWAY_PORT: String(fakePort),
        SE7ENX_KNX_LOCAL_IP: "127.0.0.1",
      },
    });
    await waitForLine(bridge, /KNX connected/);
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(() => {
    bridge?.kill("SIGTERM");
    fake?.kill("SIGTERM");
  });

  it("speaks contract v1 end to end", async () => {
    const client = new BridgeClient({ baseUrl, appOrigin: ORIGIN });
    const health = await client.health();
    expect(health).toMatchObject({ service: "se7enx-bridge", apiVersion: 1, pairingRequired: true });

    await expect(client.pair("WRONG-000", "vitest")).rejects.toMatchObject({ code: "PAIRING_FAILED" });
    await client.pair("contract-1", "vitest contract");
    const session = await client.session();
    expect(session.knx.state).toBe("connected");
    expect(session.knx.gateway?.name).toContain("FAKE");
    expect(session.policy.allowedGroupAddresses).toEqual(["0/0/1-9"]);

    const test = await client.test("0/0/2");
    expect(test.checks.find((c) => c.id === "interface")?.ok).toBe(true);

    await expect(client.putLight("primary", { switchAddress: "1/1/1", statusAddress: null, dpt: "1.001", onLevel: 100 })).rejects.toMatchObject({
      code: "GA_NOT_ALLOWED",
    });
    const reg = await client.putLight("primary", { switchAddress: "0/0/1", statusAddress: "0/0/2", dpt: "1.001", onLevel: 100 });
    expect(reg.light).toEqual({ id: "primary", switchAddress: "0/0/1", statusAddress: "0/0/2", dpt: "1.001", onLevel: 100 });

    const adapter = new BridgeAdapter(client, reg.light, await client.knxStatus());
    const events: AdapterEvent[] = [];
    adapter.subscribe((e) => events.push(e));
    adapter.start();
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () =>
        events.some((e) => e.type === "link" && e.status === "connected") ? resolve() : Date.now() - t0 > 5000 ? reject(new Error("no hello")) : setTimeout(tick, 20);
      tick();
    });

    const outcome = await adapter.send("on", { requestId: "contract-on", source: "test" });
    expect(outcome.phase).toBe("bus_confirmed");
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () =>
        events.some((e) => e.type === "state" && e.value === "on" && e.via === "status_address")
          ? resolve()
          : Date.now() - t0 > 5000
            ? reject(new Error("no status feedback event"))
            : setTimeout(tick, 20);
      tick();
    });

    const refreshed = await client.lightState("primary", true);
    expect(refreshed).toMatchObject({ value: "on", via: "read_response" });

    await adapter.dispose();
    await client.revoke();
    await expect(client.session()).rejects.toMatchObject({ code: "NOT_PAIRED" });
  }, 30_000);
});
