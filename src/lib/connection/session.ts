"use client";

/**
 * Tracks the active real backend session and stores the bridge pairing token
 * in sessionStorage only (cleared when the tab closes; never localStorage).
 */
import type { Auth } from "home-assistant-js-websocket";
import type { BridgeClient } from "@/lib/bridge/client";
import { revokeAuth } from "@/lib/ha/oauth";

const BRIDGE_KEY = "se7enx.bridge.session";

export interface StoredBridgeSession {
  baseUrl: string;
  token: string;
  expiresAt: string;
}

export function saveBridgeSession(s: StoredBridgeSession): void {
  try {
    sessionStorage.setItem(BRIDGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — token stays in memory */
  }
}

export function loadBridgeSession(baseUrl: string): StoredBridgeSession | null {
  try {
    const raw = sessionStorage.getItem(BRIDGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredBridgeSession;
    if (s.baseUrl !== baseUrl || !s.token || Date.parse(s.expiresAt) <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function peekBridgeSession(): StoredBridgeSession | null {
  try {
    const raw = sessionStorage.getItem(BRIDGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredBridgeSession;
    return Date.parse(s.expiresAt) > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function clearBridgeSession(): void {
  try {
    sessionStorage.removeItem(BRIDGE_KEY);
  } catch {
    /* ignore */
  }
}

type ActiveBackend = { kind: "bridge"; client: BridgeClient } | { kind: "homeassistant"; auth: Auth } | null;
let active: ActiveBackend = null;

export function setActiveBackend(b: ActiveBackend): void {
  active = b;
}

export function getActiveBackend(): ActiveBackend {
  return active;
}

/** Revoke the current session (bridge token / HA tokens). The caller switches the store back to simulation. */
export async function disconnectActiveBackend(): Promise<void> {
  const b = active;
  active = null;
  if (!b) return;
  if (b.kind === "bridge") {
    try {
      await b.client.revoke();
    } catch {
      /* bridge may be offline — the token expires on its own */
    }
    clearBridgeSession();
  } else {
    await revokeAuth(b.auth);
  }
}
