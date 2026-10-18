"use client";

/**
 * Who is using SE7ENX right now: nobody yet, a guest (simulation only), or a signed-in account.
 *
 * - Appliance (UI served by the hub): the hub's HttpOnly session cookie authenticates every request; this store
 *   never sees a token. First run shows the owner setup (console setup code), afterwards sign-in.
 * - Remote web app (e.g. Vercel): visitors are guests (simulation) by default. Signing in to a hub returns a bearer
 *   token kept in this tab's sessionStorage only (OWASP: no long-lived tokens in Web Storage).
 *
 * Permissions shown here only hide controls; the hub enforces every permission on the server.
 */
import { create } from "zustand";
import { AdapterError, describeError } from "@/lib/adapters/types";
import { BridgeClient } from "@/lib/bridge/client";
import { clearBridgeSession, peekBridgeSession, saveBridgeSession } from "@/lib/connection/session";
import type { Me, Permission, Preferences, Registration, SignInResult } from "@/lib/core/contract";
import { APPLIANCE, setHubAuthLostHandler, useHub } from "@/lib/hub/hub-store";
import { checkEndpointUrl } from "@/lib/net/endpoint";

export type AuthStatus = "unknown" | "checking" | "setup" | "signed_out" | "signed_in" | "pairing" | "no_hub" | "error";

export interface AuthFailure {
  code: string;
  message: string;
  hint?: string;
  retryAfter?: number;
}

const GUEST_KEY = "se7enx.guest.v1";

function readGuest(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    return false;
  }
}

function writeGuest(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_KEY, "1");
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function clientLabel(): string {
  if (typeof navigator === "undefined") return "SE7ENX web";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `SE7ENX web · ${browser}${os ? ` on ${os}` : ""}`;
}

export function toFailure(err: unknown): AuthFailure {
  const d = describeError(err);
  return { code: d.code, message: d.message, hint: d.hint };
}

let client: BridgeClient | null = null;

/** The client for the hub the current account belongs to (null when no hub). */
export function coreClient(): BridgeClient {
  if (!client) throw new AdapterError("HUB_NOT_CONNECTED", "Not connected to a SE7ENX hub.");
  return client;
}

function makeClient(baseUrl: string, token: string | null): BridgeClient {
  const check = typeof window !== "undefined" ? checkEndpointUrl(baseUrl, { pageProtocol: window.location.protocol, kind: "bridge" }) : null;
  return new BridgeClient({
    baseUrl,
    token,
    cookieAuth: APPLIANCE,
    targetAddressSpace: check && check.ok ? check.targetAddressSpace : undefined,
    appOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
  });
}

interface AuthStore {
  status: AuthStatus;
  me: Me | null;
  hubUrl: string | null;
  registration: Registration;
  passwordMinLength: number;
  guest: boolean;
  error: AuthFailure | null;
  init: () => Promise<void>;
  setup: (input: { setupCode: string; username: string; displayName: string; password: string; email?: string; remember: boolean }) => Promise<void>;
  login: (input: { login: string; password: string; remember: boolean; hubUrl?: string }) => Promise<void>;
  register: (input: { inviteCode?: string; username: string; displayName: string; password: string; email?: string; remember: boolean }) => Promise<void>;
  redeemReset: (input: { code: string; newPassword: string; remember: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  updatePreferences: (prefs: Preferences) => Promise<void>;
  updateProfile: (body: { displayName?: string; email?: string | null }) => Promise<void>;
  continueAsGuest: () => void;
  stopGuest: () => void;
  can: (permission: Permission) => boolean;
}

export const useAuth = create<AuthStore>((set, get) => {
  const applySignIn = async (res: SignInResult, baseUrl: string): Promise<void> => {
    if (res.token) saveBridgeSession({ baseUrl, token: res.token, expiresAt: res.session?.expiresAt ?? new Date(Date.now() + 12 * 3600e3).toISOString() });
    writeGuest(false);
    set({ status: "signed_in", me: { user: res.user, permissions: res.permissions, preferences: res.preferences, session: res.session }, hubUrl: baseUrl, guest: false, error: null });
    useHub.getState().disconnect();
    await useHub.getState().connect();
  };

  return {
    status: "unknown",
    me: null,
    hubUrl: null,
    registration: "disabled",
    passwordMinLength: 15,
    guest: false,
    error: null,

    init: async () => {
      if (get().status === "checking") return;
      const guest = readGuest();
      const stored = peekBridgeSession();
      const baseUrl = APPLIANCE && typeof window !== "undefined" ? window.location.origin : (stored?.baseUrl ?? null);
      if (!baseUrl) {
        set({ status: "no_hub", guest: true, hubUrl: null });
        return;
      }
      set({ status: "checking", guest, hubUrl: baseUrl });
      client = makeClient(baseUrl, APPLIANCE ? null : (stored?.token ?? null));
      try {
        const st = await client.authStatus();
        set({ registration: st.registration, passwordMinLength: st.passwordMinLength });
        if (st.mode === "pairing") {
          // Hub without accounts yet. Appliance: owner setup. Remote: legacy pairing session (wizard).
          set({ status: APPLIANCE ? "setup" : stored ? "pairing" : "no_hub", me: null });
          if (!APPLIANCE && stored) await useHub.getState().connect();
          return;
        }
        if (st.me) {
          set({ status: "signed_in", me: st.me, guest: false });
          await useHub.getState().connect();
          return;
        }
        if (!APPLIANCE) clearBridgeSession();
        set({ status: APPLIANCE ? "signed_out" : "no_hub", me: null, guest: APPLIANCE ? guest : true });
      } catch (err) {
        set({ status: "error", error: toFailure(err) });
      }
    },

    setup: async (input) => {
      const baseUrl = get().hubUrl ?? window.location.origin;
      client = makeClient(baseUrl, null);
      const res = await client.setupOwner({ ...input, email: input.email || undefined, clientName: clientLabel() });
      await applySignIn(res, baseUrl);
    },

    login: async ({ login, password, remember, hubUrl }) => {
      const baseUrl = (APPLIANCE ? window.location.origin : (hubUrl ?? get().hubUrl)) ?? null;
      if (!baseUrl) throw new AdapterError("HUB_URL_UNKNOWN", "Enter the address of your SE7ENX hub.");
      client = makeClient(baseUrl, null);
      const res = await client.login({ login, password, remember, clientName: clientLabel() });
      await applySignIn(res, baseUrl);
    },

    register: async (input) => {
      const baseUrl = get().hubUrl ?? window.location.origin;
      client = makeClient(baseUrl, null);
      const res = await client.register({ ...input, inviteCode: input.inviteCode || undefined, email: input.email || undefined, clientName: clientLabel() });
      await applySignIn(res, baseUrl);
    },

    redeemReset: async ({ code, newPassword, remember }) => {
      const baseUrl = get().hubUrl ?? window.location.origin;
      client = makeClient(baseUrl, null);
      const res = await client.redeemResetCode({ code, newPassword, remember, clientName: clientLabel() });
      await applySignIn(res, baseUrl);
    },

    logout: async () => {
      try {
        await client?.logout();
      } catch {
        /* the hub may be offline; the session expires on its own */
      }
      clearBridgeSession();
      useHub.getState().disconnect();
      set({ status: APPLIANCE ? "signed_out" : "no_hub", me: null, guest: !APPLIANCE });
    },

    refreshMe: async () => {
      if (get().status !== "signed_in" || !client) return;
      try {
        set({ me: await client.me() });
      } catch (err) {
        if (err instanceof AdapterError && err.status === 401) {
          clearBridgeSession();
          set({ status: APPLIANCE ? "signed_out" : "no_hub", me: null });
        }
      }
    },

    updatePreferences: async (prefs) => {
      if (get().status !== "signed_in" || !client) return;
      const merged = { ...(get().me?.preferences ?? {}), ...prefs };
      set({ me: await client.updateMe({ preferences: merged }) });
    },

    updateProfile: async (body) => {
      if (!client) return;
      set({ me: await client.updateMe(body) });
    },

    continueAsGuest: () => {
      writeGuest(true);
      set({ guest: true });
    },

    stopGuest: () => {
      writeGuest(false);
      set({ guest: false });
    },

    can: (permission) => {
      const s = get();
      if (s.status === "pairing") return true; // legacy paired bridge: the hub grants full rights until accounts exist
      return s.status === "signed_in" && (s.me?.permissions.includes(permission) ?? false);
    },
  };
});

/** React hook: does the signed-in user hold this permission? (UI convenience only; the hub enforces.) */
export function useCan(permission: Permission): boolean {
  return useAuth((s) => (s.status === "pairing" ? true : s.status === "signed_in" && (s.me?.permissions.includes(permission) ?? false)));
}

setHubAuthLostHandler(() => {
  const s = useAuth.getState();
  if (s.status === "signed_in") useAuth.setState({ status: APPLIANCE ? "signed_out" : "no_hub", me: null });
});
