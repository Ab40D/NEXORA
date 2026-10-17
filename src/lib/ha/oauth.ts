/**
 * Home Assistant sign-in via HA's built-in OAuth2 / IndieAuth flow.
 *
 * No long-lived access token is ever typed into or stored by SE7ENX:
 *  - the user signs in on THEIR Home Assistant login page,
 *  - HA redirects back with a one-time authorization code,
 *  - the browser exchanges it for a short-lived access token (+ refresh token),
 *  - tokens live only in sessionStorage of this tab and are revoked on disconnect.
 *
 * A random `state` nonce (stored in sessionStorage) protects the callback
 * against login-CSRF / forged callbacks.
 */
import { Auth, getAuth, type AuthData } from "home-assistant-js-websocket";
import { AdapterError } from "@/lib/adapters/types";

const PENDING_KEY = "se7enx.ha.pending";
const TOKENS_KEY = "se7enx.ha.tokens";
const CALLBACK_PARAM = "se7enx_ha_callback";
const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

export interface PendingHaLogin<W = unknown> {
  state: string;
  hassUrl: string;
  createdAt: number;
  wizard: W;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function haClientId(): string {
  return `${location.origin}/`;
}

export function haRedirectUri(): string {
  return `${location.origin}/?${CALLBACK_PARAM}=1`;
}

export function buildAuthorizeUrl(hassUrl: string, state: string, clientId = haClientId(), redirectUri = haRedirectUri()): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${hassUrl.replace(/\/+$/, "")}/auth/authorize?${params.toString()}`;
}

/** Navigate to the Home Assistant login page. Does not return. */
export function beginHaLogin<W>(hassUrl: string, wizard: W): void {
  const pending: PendingHaLogin<W> = { state: randomState(), hassUrl, createdAt: Date.now(), wizard };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  location.assign(buildAuthorizeUrl(hassUrl, pending.state));
}

export function hasHaCallback(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has(CALLBACK_PARAM);
}

export function peekPendingLogin<W = unknown>(): PendingHaLogin<W> | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingHaLogin<W>) : null;
  } catch {
    return null;
  }
}

function cleanCallbackFromUrl(): void {
  const url = new URL(location.href);
  for (const p of [CALLBACK_PARAM, "code", "state", "auth_callback"]) url.searchParams.delete(p);
  history.replaceState(history.state, "", url.pathname + (url.search ? url.search : "") + url.hash);
}

/**
 * Home Assistant OAuth tokens are kept IN MEMORY ONLY (never in sessionStorage/localStorage): the
 * refresh token is long-lived and carries the HA user's full rights (audit SE7-01). A page reload
 * therefore requires signing in again. For a permanent connection use the hub's server-side
 * Home Assistant integration, where the browser never sees a token.
 */
let memoryTokens: AuthData | null = null;

function saveTokens(data: AuthData | null): void {
  memoryTokens = data;
}

// Remove tokens persisted by older versions of SE7ENX.
try {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(TOKENS_KEY);
} catch {
  /* storage unavailable */
}

/** Complete the OAuth callback. Throws AdapterError on any mismatch. */
export async function completeHaLogin<W = unknown>(): Promise<{ auth: Auth; hassUrl: string; wizard: W | null }> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const pending = peekPendingLogin<W>();
  cleanCallbackFromUrl();
  sessionStorage.removeItem(PENDING_KEY);

  if (error) {
    throw new AdapterError("HA_LOGIN_REJECTED", `Home Assistant sign-in was not completed (${error}).`, { hint: "Try signing in again." });
  }
  if (!pending || !state || pending.state !== state) {
    throw new AdapterError("HA_OAUTH_STATE", "The sign-in response did not match a login started in this tab.", {
      hint: "For your security the response was ignored. Start the Home Assistant sign-in again from the wizard.",
    });
  }
  if (Date.now() - pending.createdAt > MAX_PENDING_AGE_MS) {
    throw new AdapterError("HA_OAUTH_EXPIRED", "The sign-in attempt expired.", { hint: "Start the Home Assistant sign-in again." });
  }
  if (!code) throw new AdapterError("HA_OAUTH_CODE", "Home Assistant did not return an authorization code.");

  try {
    const auth = await getAuth({ hassUrl: pending.hassUrl, clientId: haClientId(), authCode: code, saveTokens });
    return { auth, hassUrl: pending.hassUrl, wizard: pending.wizard };
  } catch (err) {
    throw new AdapterError("HA_TOKEN_EXCHANGE", "Could not exchange the Home Assistant authorization code.", {
      hint: "Check that Home Assistant is reachable from this device over HTTPS and try again.",
      cause: err,
    });
  }
}

export function loadStoredAuth(hassUrl: string): Auth | null {
  const data = memoryTokens;
  if (!data || data.hassUrl !== hassUrl.replace(/\/+$/, "")) return null;
  return new Auth(data, saveTokens);
}

export async function revokeAuth(auth: Auth | null): Promise<void> {
  try {
    await auth?.revoke();
  } catch {
    /* best effort */
  }
  saveTokens(null);
}
