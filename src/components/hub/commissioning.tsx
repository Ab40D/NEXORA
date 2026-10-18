"use client";

/**
 * Commissioning UI: verification badge, the step-by-step commissioning dialog and the KNX
 * chain diagnostics. Everything shown comes from evidence recorded by the hub.
 */
import { Dialog } from "radix-ui";
import { CircleCheck, CircleDashed, CircleHelp, CircleX, ClipboardCheck, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Checkbox } from "@/components/ui/primitives";
import { useCan } from "@/lib/core/auth-store";
import { describeError } from "@/lib/adapters/types";
import type { Assessment, Evidence, HubDevice, KnxChain, VerificationLevel } from "@/lib/hub/contract";
import { useCommissioning } from "@/lib/hub/commissioning-store";
import { hubClient, useHub } from "@/lib/hub/hub-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const LEVEL_TONE: Record<VerificationLevel, "sim" | "neutral" | "accent" | "ok"> = {
  simulated: "sim",
  configured: "neutral",
  connected: "accent",
  verified: "ok",
};

export function VerificationBadge({ level, showSimulated = false }: { level: VerificationLevel | undefined; showSimulated?: boolean }) {
  const { t } = useT();
  // device cards already show a "Simulated" integration badge: do not repeat it
  if (!level || (level === "simulated" && !showSimulated)) return null;
  return (
    <Badge tone={LEVEL_TONE[level]} dot={level === "verified"}>
      <span data-testid="verification-level" data-level={level}>
        {t(`commission.level.${level}`)}
      </span>
    </Badge>
  );
}

let rid = 0;
const requestId = () => `cm-${Date.now().toString(36)}-${++rid}`;

function EvidenceRow({ e }: { e: Evidence }) {
  const { t } = useT();
  const d = e.detail as Record<string, unknown>;
  const text =
    typeof d.message === "string"
      ? d.message
      : e.step === "switch"
        ? `${String(d.command ?? "")} → ${String(d.outcome ?? d.error ?? "")}${typeof d.latencyMs === "number" ? ` (${d.latencyMs} ms)` : ""}`
        : e.step === "read"
          ? `${String(d.connection ?? "")} · ${String(d.source ?? "")}`
          : e.step === "observe"
            ? d.observed
              ? t("commission.observedYes")
              : t("commission.observedNo")
            : "";
  return (
    <li className="flex items-start gap-2 py-1.5 text-xs">
      {e.ok ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden /> : <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />}
      <div className="min-w-0">
        <p className="text-ink-100">
          {t(`commission.step.${e.step}`)} <span className="text-ink-400">· {new Date(e.at).toLocaleString()} · {e.actor ?? "—"}</span>
        </p>
        {text ? <p className="break-words text-ink-300">{text}</p> : null}
      </div>
    </li>
  );
}

export function CommissioningDialog({ device, open, onOpenChange }: { device: HubDevice; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t, dir } = useT();
  const canConfigure = useCan("device.configure");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [lastSwitchOk, setLastSwitchOk] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    hubClient()
      .commissioning(device.id)
      .then((a) => alive && setAssessment(a))
      .catch((err) => alive && setError(describeError(err).message));
    return () => {
      alive = false;
    };
  }, [open, device.id]);

  const run = async (body: { step: "read" | "switch" | "observe" | "reset"; value?: "on" | "off"; observed?: boolean; confirm?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await hubClient().commissioningStep(device.id, { ...body, requestId: requestId() });
      setAssessment(res.assessment);
      if (body.step === "switch") setLastSwitchOk(res.evidence.ok);
      if (body.step === "observe" || body.step === "reset") setLastSwitchOk(false);
      void useCommissioning.getState().refresh();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const level = assessment?.level;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content
          dir={dir}
          className="fixed inset-x-3 top-[5vh] z-50 mx-auto max-h-[90vh] max-w-xl overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900 p-5 shadow-2xl focus:outline-none"
          data-testid="commissioning-dialog"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink-50">{t("commission.title", { name: device.name })}</Dialog.Title>
              <Dialog.Description className="text-xs text-ink-300">{t("commission.description")}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("common.close")}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-300">{t("commission.current")}</span>
            <VerificationBadge level={level} showSimulated />
            {assessment?.verifiedAt ? (
              <span className="text-xs text-ink-400">{t("commission.verifiedBy", { who: assessment.verifiedBy ?? "—", when: new Date(assessment.verifiedAt).toLocaleString() })}</span>
            ) : null}
          </div>
          <p className="mb-4 text-xs text-ink-400">{level ? t(`commission.levelHelp.${level}`) : null}</p>

          {device.simulated ? <Callout tone="accent">{t("commission.simulatedNote")}</Callout> : null}
          {!canConfigure ? <Callout tone="neutral">{t("commission.readOnly")}</Callout> : null}

          {canConfigure ? (
            <ol className="space-y-3">
              <li className="rounded-xl border border-ink-700 p-3">
                <p className="text-sm font-medium text-ink-100">1. {t("commission.step.read")}</p>
                <p className="mb-2 text-xs text-ink-400">{t("commission.readHelp")}</p>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run({ step: "read" })} data-testid="commission-read">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t("commission.readAction")}
                </Button>
              </li>
              <li className="rounded-xl border border-ink-700 p-3">
                <p className="text-sm font-medium text-ink-100">2. {t("commission.step.switch")}</p>
                <p className="mb-2 text-xs text-ink-400">{t("commission.switchHelp")}</p>
                {device.commands.includes("turn_on") ? (
                  <>
                    <Checkbox id={`cm-ack-${device.id}`} checked={ack} onCheckedChange={setAck}>
                      {t("commission.switchAck")}
                    </Checkbox>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="on" disabled={busy || !ack} onClick={() => void run({ step: "switch", value: "on", confirm: true })} data-testid="commission-switch-on">
                        {t("commission.switchOn")}
                      </Button>
                      <Button size="sm" variant="off" disabled={busy || !ack} onClick={() => void run({ step: "switch", value: "off", confirm: true })} data-testid="commission-switch-off">
                        {t("commission.switchOff")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-ink-400">{t("commission.noSwitch")}</p>
                )}
              </li>
              <li className="rounded-xl border border-ink-700 p-3">
                <p className="text-sm font-medium text-ink-100">3. {t("commission.step.observe")}</p>
                <p className="mb-2 text-xs text-ink-400">{t("commission.observeHelp")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" disabled={busy || !lastSwitchOk} onClick={() => void run({ step: "observe", observed: true })} data-testid="commission-observed-yes">
                    {t("commission.observedYes")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy || !lastSwitchOk} onClick={() => void run({ step: "observe", observed: false })} data-testid="commission-observed-no">
                    {t("commission.observedNo")}
                  </Button>
                </div>
              </li>
            </ol>
          ) : null}

          {error ? (
            <p className="mt-3 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {assessment?.lastFailure ? (
            <Callout tone="warn" className="mt-3" title={t("commission.lastFailure")}>
              <EvidenceRow e={assessment.lastFailure} />
            </Callout>
          ) : null}

          <details className="mt-4" open>
            <summary className="cursor-pointer select-none text-xs font-medium text-ink-200">{t("commission.history")}</summary>
            {assessment?.history.length ? (
              <ul className="mt-1 divide-y divide-ink-800" data-testid="commission-history">
                {assessment.history.map((e) => (
                  <EvidenceRow key={e.id} e={e} />
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-ink-400">{t("commission.noHistory")}</p>
            )}
          </details>
          {canConfigure && assessment?.history.length ? (
            <Button className="mt-3" size="sm" variant="ghost" disabled={busy} onClick={() => void run({ step: "reset" })}>
              {t("commission.reset")}
            </Button>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const CHAIN_ICON = { ok: CircleCheck, fail: CircleX, missing: CircleX, pending: CircleDashed, na: CircleHelp } as const;
const CHAIN_TONE = { ok: "text-ok", fail: "text-danger", missing: "text-warn", pending: "text-ink-400", na: "text-ink-400" } as const;

export function KnxChainCard() {
  const { t } = useT();
  const hubReady = useHub((s) => s.status === "ready");
  const [chain, setChain] = useState<KnxChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchChain = useCallback(
    () =>
      hubClient()
        .knxChain()
        .then((c) => {
          setChain(c);
          setError(null);
        })
        .catch((err) => setError(describeError(err).message))
        .finally(() => setLoading(false)),
    [],
  );
  const load = () => {
    setLoading(true);
    void fetchChain();
  };
  useEffect(() => {
    if (hubReady) void fetchChain();
  }, [hubReady, fetchChain]);
  if (!hubReady) return null;
  return (
    <Card data-testid="knx-chain">
      <CardHeader
        icon={<ClipboardCheck className="h-4 w-4" />}
        title={t("commission.chain.title")}
        subtitle={t("commission.chain.subtitle")}
        actions={
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden /> {t("commission.chain.check")}
          </Button>
        }
      />
      <ol className="space-y-2 px-4 pb-4 pt-3 sm:px-5">
        {(chain?.steps ?? []).map((s) => {
          const Icon = CHAIN_ICON[s.state];
          const detail = (s as { detail?: unknown }).detail;
          const text =
            s.id === "bus" && detail && typeof detail === "object"
              ? t("commission.chain.busSeen", { source: String((detail as Record<string, unknown>).source), ga: String((detail as Record<string, unknown>).groupAddress) })
              : typeof detail === "string"
                ? detail
                : "";
          return (
            <li key={s.id} className="flex items-start gap-2 text-sm" data-testid={`knx-chain-${s.id}`} data-state={s.state}>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", CHAIN_TONE[s.state])} aria-hidden />
              <div className="min-w-0">
                <p className="text-ink-100">
                  {t(`commission.chain.${s.id}`)}
                  {s.id === "interface" && (s as { knxd?: boolean }).knxd ? <span className="ms-2 text-xs text-ink-400">knxd</span> : null}
                </p>
                <p className="break-words text-xs text-ink-400">{text || t(`commission.chain.state.${s.state}`)}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {error ? <p className="px-5 pb-4 text-xs text-danger">{error}</p> : null}
      <p className="px-5 pb-4 text-xs text-ink-400">{t("commission.chain.note")}</p>
    </Card>
  );
}
