/**
 * fetch() helpers with timeouts and Local Network Access support.
 */

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Chromium LNA hint; only set for http:// requests to loopback / LAN hosts */
  targetAddressSpace?: "loopback" | "local";
}

export class NetworkError extends Error {
  readonly kind: "timeout" | "network" | "aborted";
  constructor(kind: "timeout" | "network" | "aborted", message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "NetworkError";
    this.kind = kind;
  }
}

/** Link an external AbortSignal with an internal timeout. */
export function timeoutSignal(timeoutMs: number, external?: AbortSignal | null): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeout,
  };
}

export async function fetchWithTimeout(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 8000, targetAddressSpace, signal, ...init } = opts;
  const t = timeoutSignal(timeoutMs, signal);
  const finalInit: RequestInit & { targetAddressSpace?: string } = { ...init, signal: t.signal };
  if (targetAddressSpace) finalInit.targetAddressSpace = targetAddressSpace;
  try {
    return await fetch(url, finalInit);
  } catch (err) {
    if (t.timedOut()) throw new NetworkError("timeout", `No response within ${Math.round(timeoutMs / 1000)}s`, err);
    if (signal?.aborted) throw new NetworkError("aborted", "Request aborted", err);
    throw new NetworkError("network", err instanceof Error ? err.message : "Network request failed", err);
  } finally {
    t.cancel();
  }
}
