/**
 * Health endpoint of the web deployment (Vercel).
 *
 * Deliberately has NO KNX capabilities: serverless functions cannot reach a
 * customer's private LAN, broadcast KNXnet/IP UDP or hold a persistent tunnel.
 * Real KNX traffic goes browser → SE7ENX Bridge (on the LAN) or browser →
 * Home Assistant, never through this deployment.
 */
import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "se7enx-web",
      version: pkg.version,
      time: new Date().toISOString(),
      knx: {
        handledHere: false,
        note: "This deployment serves the UI only. KNX is reached through the SE7ENX Bridge on your LAN or your Home Assistant instance.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
