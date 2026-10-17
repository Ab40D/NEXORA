import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * - connect-src must allow user-supplied endpoints (the SE7ENX Bridge on the
 *   user's LAN / tailnet, or their Home Assistant instance), so it permits
 *   https:/wss: plus http:/ws: (browsers still apply mixed-content and Local
 *   Network Access rules on top of this). The deployment itself never proxies
 *   requests into private networks.
 * - 'wasm-unsafe-eval' is required by the in-browser MediaPipe WASM runtime.
 * - frame-ancestors defaults to 'none' (clickjacking protection for an app
 *   that can operate physical devices). Set SE7ENX_FRAME_ANCESTORS to allow
 *   embedding (e.g. "'self' https://preview.example").
 */
const isDev = process.env.NODE_ENV !== "production";
const frameAncestors = process.env.SE7ENX_FRAME_ANCESTORS?.trim() || "'none'";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: http: ws: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${frameAncestors}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(frameAncestors === "'none'" ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
];

/**
 * DEVELOPMENT / DEMO ONLY: same-origin rewrite to ONE fixed, operator-configured
 * bridge URL (e.g. a local demo stack behind a preview proxy that cannot expose a
 * second host). Off unless SE7ENX_DEV_BRIDGE_REWRITE is set at build time. The
 * target is never taken from the client, so this is not an open proxy. Do not
 * use it to reach a customer LAN — serverless platforms cannot reach private
 * networks anyway.
 */
const devBridgeRewrite = process.env.SE7ENX_DEV_BRIDGE_REWRITE?.trim().replace(/\/+$/, "");

/**
 * Build targets:
 * - default (Vercel / `next start`): server build with the headers and optional demo rewrite below.
 * - SE7ENX_BUILD_TARGET=appliance: static export (`out/`) served by the local SE7ENX hub on the
 *   same origin as its API. The hub sets the security headers (connect-src 'self'); the
 *   Vercel-only /api/health route handler is excluded via pageExtensions.
 */
const appliance = process.env.SE7ENX_BUILD_TARGET === "appliance";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(appliance ? { output: "export" as const, pageExtensions: ["tsx", "jsx"], images: { unoptimized: true } } : {}),
  allowedDevOrigins: process.env.SE7ENX_ALLOWED_DEV_ORIGINS
    ? process.env.SE7ENX_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined,
  // Server builds only: a static export cannot apply headers or rewrites (the hub sets the headers).
  ...(appliance
    ? {}
    : {
        async rewrites() {
          if (!devBridgeRewrite) return [];
          return [{ source: "/demo-bridge/:path*", destination: `${devBridgeRewrite}/:path*` }];
        },
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders },
            {
              source: "/mediapipe/:path*",
              headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
            },
            {
              source: "/models/:path*",
              headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
            },
          ];
        },
      }),
};

export default nextConfig;
