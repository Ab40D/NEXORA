"use client";

import { useNow } from "@/lib/device";
import { SOURCE_LABEL } from "@/lib/state/light-machine";
import { useAppStore } from "@/lib/state/store";
import type { CommandPhase } from "@/lib/state/types";
import { cn, formatAgo } from "@/lib/utils";

const PHASE_TEXT: Record<CommandPhase, string> = {
  pending: "sending…",
  simulated: "simulated",
  accepted: "accepted by backend",
  bus_confirmed: "confirmed by KNX interface",
  failed: "failed",
};

function Cell({ label, value, sub, tone, testId }: { label: string; value: string; sub: string; tone: string; testId?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-ink-700/70 bg-ink-850/70 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">{label}</p>
      <p data-testid={testId} className={cn("mt-1 truncate font-mono text-lg font-semibold tracking-wider", tone)}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-300" title={sub}>
        {sub}
      </p>
    </div>
  );
}

/** Keeps the three kinds of state visibly separate: simulated, requested, confirmed. */
export function StateStrip() {
  const light = useAppStore((s) => s.light);
  const now = useNow(1000);
  const cmd = light.lastCommand;
  const isSim = light.mode === "simulation";

  const requested = cmd
    ? {
        value: cmd.value.toUpperCase(),
        sub: `${PHASE_TEXT[cmd.phase]} · ${SOURCE_LABEL[cmd.source]} · ${formatAgo(cmd.createdAt, now)}`,
        tone: cmd.phase === "failed" ? "text-danger" : cmd.phase === "pending" ? "text-accent" : "text-ink-50",
      }
    : { value: "—", sub: "No command yet", tone: "text-ink-400" };

  const rep = light.reported;
  const confirmed = isSim
    ? { value: "n/a", sub: "Simulation has no real device", tone: "text-ink-400" }
    : rep.value !== "unknown" && rep.at
      ? {
          value: rep.value.toUpperCase(),
          sub: `${rep.via === "status_address" ? "status feedback" : rep.via === "read_response" ? "read response" : rep.via === "switch_address" ? "observed on switch address" : "backend"} · ${formatAgo(rep.at, now)}`,
          tone: rep.value === "on" ? "text-warm" : "text-ink-50",
        }
      : {
          value: "UNKNOWN",
          sub: light.feedbackAvailable ? "Waiting for status feedback / read" : "No status feedback configured",
          tone: "text-ink-400",
        };

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Light state details">
      <Cell
        label={isSim ? "Simulated lamp" : "Mode"}
        value={isSim ? light.simulated.toUpperCase() : light.mode === "bridge" ? "LIVE · BRIDGE" : "LIVE · HA"}
        sub={isSim ? "In-browser simulation" : light.backendLabel ?? ""}
        tone={isSim ? "text-sim" : "text-accent"}
        testId="simulated-state"
      />
      <Cell label="Requested" value={requested.value} sub={requested.sub} tone={requested.tone} testId="requested-state" />
      <Cell label="Confirmed device state" value={confirmed.value} sub={confirmed.sub} tone={confirmed.tone} testId="confirmed-state" />
    </div>
  );
}
