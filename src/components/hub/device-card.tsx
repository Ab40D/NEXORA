"use client";

import { ArrowDown, ArrowUp, Lightbulb, Minus, Plus, Power, ShieldAlert, Square, Trash2 } from "lucide-react";
import { Slider as RSlider } from "radix-ui";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Checkbox } from "@/components/ui/primitives";
import type { HubCommand, HubDevice } from "@/lib/hub/contract";
import { CONNECTION_LABEL, describeReported, describeRequested, INTEGRATION_LABEL, OUTCOME_LABEL, relativeTime } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/hub-store";
import { cn } from "@/lib/utils";

const CONNECTION_TONE = { online: "ok", offline: "danger", unauthorized: "danger", unavailable: "warn", error: "danger", unknown: "neutral" } as const;

/** Slider that sends ONE command when released (never a command per drag step). */
function CommitSlider({ id, label, value, disabled, onCommit, format }: { id: string; label: string; value: number; disabled?: boolean; onCommit: (v: number) => void; format: (v: number) => string }) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span id={`${id}-label`} className="font-medium text-ink-200">
          {label}
        </span>
        <span className="font-mono tabular-nums text-accent">{format(shown)}</span>
      </div>
      <RSlider.Root
        aria-labelledby={`${id}-label`}
        className={cn("relative flex h-5 w-full touch-none select-none items-center", disabled && "opacity-50")}
        value={[shown]}
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        onValueChange={(v) => v[0] !== undefined && setLocal(v[0])}
        onValueCommit={(v) => {
          if (v[0] !== undefined) onCommit(v[0]);
          setLocal(null);
        }}
      >
        <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-ink-600">
          <RSlider.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent-blue to-accent" />
        </RSlider.Track>
        <RSlider.Thumb aria-label={label} className="block h-5 w-5 rounded-full border-2 border-accent bg-ink-950 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30" />
      </RSlider.Root>
    </div>
  );
}

export function DeviceCard({ device, now }: { device: HubDevice; now: number }) {
  const command = useHub((s) => s.command);
  const patch = useHub((s) => s.patch);
  const remove = useHub((s) => s.remove);
  const busy = useHub((s) => !!s.busy[device.id]);
  const result = useHub((s) => s.results[device.id]);
  const safety = useHub((s) => s.safety);
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const has = (c: HubCommand) => device.commands.includes(c);
  const rep = device.state.reported;
  const reported = describeReported(device.type, rep);
  const requested = describeRequested(device.state.requested);
  const real = !device.simulated;
  const controlsDisabled = busy || !device.controlAllowed;
  const send = (c: HubCommand, params?: Record<string, unknown>) => void command(device.id, c, params);
  const readOnly = device.commands.length === 0;

  async function guarded(fn: () => Promise<void>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <article className="rounded-2xl border border-ink-600/70 bg-ink-850/70 p-4" aria-labelledby={`dev-${device.id}-name`} data-testid={`device-${device.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`dev-${device.id}-name`} className="truncate text-sm font-semibold text-ink-50">
            {device.name}
          </h3>
          <p className="truncate text-xs text-ink-400">
            {device.model ?? device.type}
            {device.metadata.room ? ` · ${device.metadata.room}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={device.simulated ? "sim" : "accent"}>{INTEGRATION_LABEL[device.integration]}</Badge>
          <Badge tone={CONNECTION_TONE[device.connection.status]} dot>
            {CONNECTION_LABEL[device.connection.status]}
          </Badge>
        </div>
      </header>

      <div className="mt-3 space-y-1 text-sm" aria-live="polite">
        <p className="text-ink-100">
          <span className="text-ink-400">Reported: </span>
          {reported.length ? reported.join(" · ") : <span className="text-ink-300">no state reported yet</span>}
        </p>
        <p className="text-xs text-ink-400">
          {device.state.reportedAt ? `${relativeTime(device.state.reportedAt, now)} · ${device.state.source ?? "device"}` : "waiting for the device"}
        </p>
        {device.state.pending && requested ? (
          <p className="text-xs text-warn" data-testid={`device-${device.id}-pending`}>
            Requested {requested}: waiting for the device to confirm ({relativeTime(device.state.requestedAt, now)})
          </p>
        ) : null}
        {device.connection.lastError && device.connection.status !== "online" ? (
          <p className="text-xs text-danger">{device.connection.lastError.message}</p>
        ) : null}
      </div>

      {readOnly ? (
        <p className="mt-3 text-xs text-ink-400">Read-only sensor.</p>
      ) : real && !device.controlEnabled ? (
        <div className="mt-3 space-y-2">
          {!confirming ? (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Enable control…
            </Button>
          ) : (
            <Callout tone="danger" title="This operates real equipment">
              <p className="mb-2 text-xs">
                Commands will switch the real device. Make sure it is safe to do so (people, motors, heaters), that you can see or hear the
                device, and that you know how to switch it off locally.
              </p>
              <Checkbox id={`ack-${device.id}`} checked={ack} onCheckedChange={setAck}>
                I understand that this operates real equipment and it is safe to do so now.
              </Checkbox>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!ack}
                  onClick={() => guarded(() => patch(device.id, { controlEnabled: true, acknowledgeRealControl: true }))}
                >
                  Enable control
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </Callout>
          )}
          <p className="text-xs text-ink-400">Control is disabled for this real device: status only.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {safety.active && real ? <p className="text-xs text-danger">Hub emergency stop is active: real devices cannot be controlled.</p> : null}
          {has("turn_on") || has("open") ? (
            <div className="flex flex-wrap gap-2">
              {has("turn_on") ? (
                <Button variant="on" size="sm" disabled={controlsDisabled} onClick={() => send("turn_on")}>
                  <Power className="h-3.5 w-3.5" aria-hidden /> On
                </Button>
              ) : null}
              {has("turn_off") ? (
                <Button variant="off" size="sm" disabled={controlsDisabled} onClick={() => send("turn_off")}>
                  Off
                </Button>
              ) : null}
              {has("open") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("open")}>
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Open
                </Button>
              ) : null}
              {has("stop") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("stop")}>
                  <Square className="h-3.5 w-3.5" aria-hidden /> Stop
                </Button>
              ) : null}
              {has("close") ? (
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => send("close")}>
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Close
                </Button>
              ) : null}
            </div>
          ) : null}
          {has("set_brightness") ? (
            <CommitSlider
              id={`b-${device.id}`}
              label="Brightness (absolute)"
              value={typeof rep.brightness === "number" ? rep.brightness : 0}
              disabled={controlsDisabled}
              onCommit={(v) => send("set_brightness", { brightness: v })}
              format={(v) => `${v} %`}
            />
          ) : null}
          {has("dim") ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-300">Relative dimming</span>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "down" })} aria-label="Dim down">
                <Minus className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "stop" })}>
                Stop
              </Button>
              <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => send("dim", { direction: "up" })} aria-label="Dim up">
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
          {has("set_position") ? (
            <CommitSlider
              id={`p-${device.id}`}
              label="Position (% open)"
              value={typeof rep.position === "number" ? rep.position : 0}
              disabled={controlsDisabled}
              onCommit={(v) => send("set_position", { position: v })}
              format={(v) => `${v} %`}
            />
          ) : null}
        </div>
      )}

      {result ? (
        <p className={cn("mt-3 text-xs", result.ok ? (result.outcome === "accepted" ? "text-warn" : "text-ok") : "text-danger")} role="status">
          {result.ok && result.outcome ? `${OUTCOME_LABEL[result.outcome]}. ` : ""}
          {result.text}
          {result.hint ? ` ${result.hint}` : ""}
        </p>
      ) : null}
      {actionError ? <p className="mt-2 text-xs text-danger">{actionError}</p> : null}

      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700/70 pt-3">
        {real && device.controlEnabled ? (
          <Button variant="ghost" size="sm" onClick={() => guarded(() => patch(device.id, { controlEnabled: false }))}>
            <Lightbulb className="h-3.5 w-3.5" aria-hidden /> Disable control
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (window.confirm(`Remove ${device.name} from SE7ENX? The physical device is not changed.`)) void guarded(() => remove(device.id));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
        </Button>
        {device.credentialsStored ? <span className="text-[11px] text-ink-400">Credentials stored on the hub</span> : null}
      </footer>
    </article>
  );
}
