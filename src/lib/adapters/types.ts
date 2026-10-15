import type { CommandSource, HistoryTone, LinkStatus, Mode, OnOff, ReportVia } from "@/lib/state/types";

export interface CommandContext {
  requestId: string;
  source: CommandSource;
}

/** What the backend could truthfully confirm about a command. */
export interface CommandOutcome {
  phase: "simulated" | "accepted" | "bus_confirmed";
  detail: string;
}

export type AdapterEvent =
  | { type: "link"; status: LinkStatus; message?: string | null }
  | { type: "state"; value: OnOff | "unknown"; via: ReportVia; at: number; detail?: string }
  | { type: "note"; title: string; detail?: string; tone?: HistoryTone };

export type AdapterListener = (event: AdapterEvent) => void;

/**
 * A backend that can operate the light. Implementations must never report a
 * phase they cannot back up with evidence from the backend.
 */
export interface LightAdapter {
  readonly mode: Mode;
  /** human readable backend description shown in the UI */
  readonly label: string;
  /** true if the backend can report actual device state */
  readonly feedbackAvailable: boolean;
  send(value: OnOff, ctx: CommandContext): Promise<CommandOutcome>;
  /** request a state read (GroupValueRead); results arrive as "state" events */
  refreshState(): Promise<void>;
  subscribe(listener: AdapterListener): () => void;
  /** begin streaming/link supervision (optional) */
  start?(): void | Promise<void>;
  dispose(): Promise<void>;
}

/** Error with a stable machine-readable code and an actionable hint. */
export class AdapterError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number | undefined;

  constructor(code: string, message: string, opts: { hint?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AdapterError";
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
  }
}

export function describeError(err: unknown): { code: string; message: string; hint?: string } {
  if (err instanceof AdapterError) return { code: err.code, message: err.message, hint: err.hint };
  if (err instanceof Error) return { code: "UNEXPECTED", message: err.message };
  return { code: "UNEXPECTED", message: String(err) };
}

/** Small typed event emitter used by adapters. */
export class AdapterEmitter {
  private listeners = new Set<AdapterListener>();

  subscribe(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AdapterEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error("[se7enx] adapter listener failed", err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
