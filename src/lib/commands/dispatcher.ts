/**
 * Command dispatcher: the single path through which every ON/OFF request
 * (manual, lamp tap, keyboard, gesture, voice, wizard test) reaches a backend.
 */
import { describeError, type LightAdapter } from "@/lib/adapters/types";
import type { LightEvent } from "@/lib/state/light-machine";
import type { BlockReason, LightState } from "@/lib/state/types";
import { DEFAULT_POLICY, evaluateCommand, type CommandRequest, type PolicyConfig } from "./policy";

export const COMMAND_TIMEOUT_MS = 10_000;

export type DispatchResult =
  | { status: "blocked"; reason: BlockReason }
  | { status: "done"; id: string; phase: "simulated" | "accepted" | "bus_confirmed"; detail: string }
  | { status: "failed"; id: string; code: string; message: string; hint?: string };

export interface DispatcherDeps {
  getState: () => LightState;
  dispatch: (event: LightEvent) => void;
  getAdapter: () => LightAdapter | null;
  now?: () => number;
  genId?: () => string;
  policy?: PolicyConfig;
  timeoutMs?: number;
}

let counter = 0;
export function defaultId(): string {
  counter += 1;
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `cmd-${Date.now().toString(36)}-${counter}-${rnd}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`No answer from backend within ${ms / 1000}s`), { code: "TIMEOUT" })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function dispatchCommand(deps: DispatcherDeps, req: CommandRequest): Promise<DispatchResult> {
  const now = deps.now ?? Date.now;
  const genId = deps.genId ?? defaultId;
  const state = deps.getState();
  const verdict = evaluateCommand(state, req, now(), deps.policy ?? DEFAULT_POLICY);

  if (!verdict.ok) {
    // Duplicate gesture suppressions are expected while a hand is held; keep them out of history.
    if (verdict.reason !== "duplicate") {
      deps.dispatch({ type: "COMMAND_BLOCKED", value: req.value, source: req.source, reason: verdict.reason, at: now() });
    }
    return { status: "blocked", reason: verdict.reason };
  }

  const adapter = deps.getAdapter();
  const id = genId();
  deps.dispatch({ type: "COMMAND_REQUESTED", id, value: req.value, source: req.source, at: now() });

  if (!adapter || adapter.mode !== state.mode) {
    const message = "No active backend for the current mode.";
    deps.dispatch({ type: "COMMAND_SETTLED", id, phase: "failed", errorCode: "NO_ADAPTER", detail: message, at: now() });
    return { status: "failed", id, code: "NO_ADAPTER", message };
  }

  try {
    const outcome = await withTimeout(adapter.send(req.value, { requestId: id, source: req.source }), deps.timeoutMs ?? COMMAND_TIMEOUT_MS);
    deps.dispatch({ type: "COMMAND_SETTLED", id, phase: outcome.phase, detail: outcome.detail, at: now() });
    return { status: "done", id, phase: outcome.phase, detail: outcome.detail };
  } catch (err) {
    const d = describeError(err);
    const code = (err as { code?: string })?.code === "TIMEOUT" ? "TIMEOUT" : d.code;
    const detail = d.hint ? `${d.message} — ${d.hint}` : d.message;
    deps.dispatch({ type: "COMMAND_SETTLED", id, phase: "failed", errorCode: code, detail, at: now() });
    return { status: "failed", id, code, message: d.message, hint: d.hint };
  }
}
