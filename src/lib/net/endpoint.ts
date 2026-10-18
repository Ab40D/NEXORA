/**
 * Validation of user-supplied backend URLs (SE7ENX Bridge / Home Assistant).
 *
 * All URLs typed by the user are untrusted. They are only ever used by the
 * user's own browser — the Vercel deployment never connects to them, so there
 * is no server-side proxy into private networks.
 *
 * Browser rules encoded here:
 *  - An HTTPS page may not fetch http:// resources (mixed content), EXCEPT
 *    loopback (http://127.0.0.1 / localhost) in Chromium & Firefox, and — in
 *    Chromium 142+ after the user grants "Local network access" — private IP
 *    literals / *.local hosts when fetch() is annotated with targetAddressSpace.
 *  - Safari blocks http:// loopback and private addresses from HTTPS pages.
 *  - WebSockets (used by Home Assistant) get no mixed-content exemption.
 */

export type AddressSpace = "loopback" | "local" | "public";
export type EndpointKind = "bridge" | "homeassistant";

export interface EndpointCheck {
  ok: boolean;
  /** normalized base URL without trailing slash */
  url?: string;
  origin?: string;
  host?: string;
  addressSpace?: AddressSpace;
  /** value for fetch({ targetAddressSpace }) when an http:// local request needs the LNA exemption */
  targetAddressSpace?: "loopback" | "local";
  error?: string;
  warnings: string[];
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

export function classifyHost(hostname: string): AddressSpace {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback";

  const v4 = parseIPv4(host) ?? (host.startsWith("::ffff:") ? parseIPv4(host.slice(7)) : null);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return "loopback";
    if (a === 10) return "local";
    if (a === 172 && b >= 16 && b <= 31) return "local";
    if (a === 192 && b === 168) return "local";
    if (a === 169 && b === 254) return "local";
    if (a === 100 && b >= 64 && b <= 127) return "local"; // CGNAT / Tailscale range
    return "public";
  }
  if (host.includes(":")) {
    // IPv6 literal
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return "local"; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return "local"; // fe80::/10 link local
    return "public";
  }
  if (host.endsWith(".local")) return "local";
  return "public";
}

export function checkEndpointUrl(
  input: string,
  opts: { pageProtocol: string; kind: EndpointKind },
): EndpointCheck {
  const warnings: string[] = [];
  const value = (input ?? "").trim();
  if (!value) return { ok: false, error: "Enter a URL.", warnings };
  if (value.length > 300) return { ok: false, error: "URL is too long.", warnings };
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, error: "Include the scheme, e.g. https://bridge.example or http://127.0.0.1:8787.", warnings };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "This is not a valid URL.", warnings };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported.", warnings };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Do not put credentials in the URL.", warnings };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Remove query parameters and fragments from the URL.", warnings };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (opts.kind === "homeassistant" && path !== "") {
    return { ok: false, error: "Enter the Home Assistant base URL only (no path), e.g. https://home.example.com.", warnings };
  }

  const space = classifyHost(url.hostname);
  const base = `${url.protocol}//${url.host}${path}`;
  const result: EndpointCheck = {
    ok: true,
    url: base,
    origin: url.origin,
    host: url.host,
    addressSpace: space,
    warnings,
  };

  if (opts.kind === "bridge" && url.port === "3671") {
    // A common mix-up: the KNX interface's address instead of the bridge's.
    warnings.push(
      "Port 3671 is the KNXnet/IP port of KNX interfaces, not the SE7ENX Bridge. Enter the bridge's own address — it prints it when it starts (default port 8787).",
    );
  }

  const pageIsHttps = opts.pageProtocol === "https:";
  if (url.protocol === "http:" && pageIsHttps) {
    if (opts.kind === "homeassistant") {
      if (space !== "loopback") {
        return {
          ok: false,
          error:
            "Home Assistant must be reachable over https:// from this HTTPS page (browsers block insecure WebSockets). Use your HTTPS remote URL (e.g. Nabu Casa or your own domain).",
          warnings,
        };
      }
      warnings.push("Plain-HTTP localhost works in Chrome, Edge and Firefox, but Safari blocks it from HTTPS pages.");
      result.targetAddressSpace = "loopback";
      return result;
    }
    if (space === "loopback") {
      warnings.push("Plain-HTTP loopback works in Chrome, Edge and Firefox. Safari blocks it — use HTTPS for Safari/iOS.");
      result.targetAddressSpace = "loopback";
      return result;
    }
    if (space === "local") {
      warnings.push(
        "Plain-HTTP LAN addresses only work in Chromium-based browsers (Chrome/Edge 142+) after you allow “local network access”. Safari and Firefox block it as mixed content — use HTTPS (e.g. Tailscale Serve) for phones.",
      );
      result.targetAddressSpace = "local";
      return result;
    }
    return {
      ok: false,
      error: "Browsers block http:// requests to public hosts from this HTTPS page (mixed content). Use https://.",
      warnings,
    };
  }

  if (url.protocol === "https:" && space === "public" && opts.kind === "bridge") {
    warnings.push(
      "This bridge is reachable via a public hostname. Make sure it is protected (pairing is required, but prefer a private tailnet / access policy).",
    );
  }
  return result;
}
