"use client";

import { Ban, CircleAlert, CircleCheck, Info, Radio, ShieldAlert, Trash2, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/primitives";
import { useAppStore } from "@/lib/state/store";
import type { HistoryEntry } from "@/lib/state/types";
import { cn, formatTime } from "@/lib/utils";

const ICON: Record<HistoryEntry["kind"], ReactNode> = {
  command: <Zap className="h-3.5 w-3.5" />,
  blocked: <Ban className="h-3.5 w-3.5" />,
  state: <CircleCheck className="h-3.5 w-3.5" />,
  link: <Radio className="h-3.5 w-3.5" />,
  mode: <Info className="h-3.5 w-3.5" />,
  safety: <ShieldAlert className="h-3.5 w-3.5" />,
  info: <CircleAlert className="h-3.5 w-3.5" />,
};

const TONE: Record<HistoryEntry["tone"], string> = {
  neutral: "text-ink-300 border-ink-600",
  info: "text-accent border-accent/40",
  success: "text-ok border-ok/40",
  warning: "text-warn border-warn/40",
  danger: "text-danger border-danger/50",
};

export function HistoryPanel() {
  const history = useAppStore((s) => s.light.history);
  const dispatch = useAppStore((s) => s.dispatch);

  return (
    <Card>
      <CardHeader
        title="Command & event history"
        subtitle="Requested commands, backend confirmations, device feedback and blocked actions (latest first)."
        actions={
          history.length ? (
            <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "HISTORY_CLEARED" })}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Clear
            </Button>
          ) : null
        }
      />
      <div className="px-2 pb-3 pt-2 sm:px-3">
        {history.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-ink-400">No events yet. Toggle the lamp to get started.</p>
        ) : (
          <ol className="scrollbar-thin max-h-[60vh] space-y-1 overflow-y-auto pr-1" aria-label="History" data-testid="history">
            {history.map((h) => (
              <li key={h.id} className="flex gap-3 rounded-xl px-3 py-2 hover:bg-ink-800/60">
                <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border", TONE[h.tone])} aria-hidden>
                  {ICON[h.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink-50">{h.title}</p>
                    <time className="shrink-0 font-mono text-[11px] text-ink-400" dateTime={new Date(h.at).toISOString()}>
                      {formatTime(h.at)}
                    </time>
                  </div>
                  {h.detail ? <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-300">{h.detail}</p> : null}
                  <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-500">
                    {h.mode === "simulation" ? "simulation" : h.mode === "bridge" ? "knx · bridge" : "knx · home assistant"}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
