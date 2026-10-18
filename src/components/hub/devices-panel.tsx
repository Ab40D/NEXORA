"use client";

import { Boxes, Download, OctagonX, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader } from "@/components/ui/primitives";
import { describeError } from "@/lib/adapters/types";
import { useNow } from "@/lib/device";
import type { IntegrationStatus } from "@/lib/hub/contract";
import { relativeTime } from "@/lib/hub/format";
import { useAuth } from "@/lib/core/auth-store";
import { APPLIANCE, hubClient, useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useUi } from "@/lib/state/ui-store";
import { AddDeviceDialog } from "./add-device-dialog";
import { DeviceCard } from "./device-card";

const STATE_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  connected: "ok",
  connecting: "warn",
  degraded: "warn",
  disconnected: "danger",
  auth_failed: "danger",
  error: "danger",
  not_configured: "neutral",
};

const KNOWN_STATES = new Set(["connected", "connecting", "degraded", "disconnected", "auth_failed", "error", "not_configured"]);
const INTEGRATIONS = new Set(["simulated", "shelly", "homeassistant", "knx"]);

export function PairCard() {
  const { t } = useT();
  const error = useHub((s) => s.error);
  const openWizard = useUi((s) => s.openWizard);
  if (!APPLIANCE) {
    return (
      <Card>
        <CardHeader title={t("hub.panel.title")} subtitle={t("hub.panel.subtitleNoHub")} icon={<Boxes className="h-4 w-4" />} />
        <div className="space-y-3 p-4 pt-0 text-sm text-ink-200">
          <p>{t("hub.panel.pairInfo")}</p>
          {error ? <p className="text-xs text-warn">{error.message}</p> : null}
          <Button variant="secondary" size="sm" onClick={openWizard}>
            {t("hub.panel.connectHub")}
          </Button>
        </div>
      </Card>
    );
  }
  // Appliance: the hub's data needs a SE7ENX account (pairing codes are only used for the first owner setup).
  return (
    <Card>
      <CardHeader title={t("hub.panel.title")} subtitle={t("auth.guest.banner")} icon={<ShieldCheck className="h-4 w-4" />} />
      <div className="space-y-3 p-4 pt-0 text-sm text-ink-200">
        <p>{t("auth.guest.note")}</p>
        <Button variant="primary" size="sm" onClick={() => useAuth.getState().stopGuest()} data-testid="hub-signin">
          {t("auth.guest.signIn")}
        </Button>
      </div>
    </Card>
  );
}

function IntegrationChip({ i, now }: { i: IntegrationStatus; now: number }) {
  const { t, locale } = useT();
  const label = INTEGRATIONS.has(i.name) ? t(`hub.integration.${i.name}` as MessageKey) : i.name;
  return (
    <li className="rounded-xl border border-ink-700 px-3 py-2 text-xs" title={i.lastError?.message ?? i.detail}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-ink-100">{label}</span>
        <Badge tone={STATE_TONE[i.state] ?? "neutral"} dot className="shrink-0 whitespace-nowrap">
          {KNOWN_STATES.has(i.state) ? t(`hub.panel.state.${i.state}` as MessageKey) : i.state}
        </Badge>
      </div>
      <p className="mt-1 truncate text-ink-400">{i.detail}</p>
      <p className="text-ink-400">{t("hub.panel.lastSuccess", { time: relativeTime(i.lastSuccessAt, now, locale) })}</p>
      {i.lastError && i.state !== "connected" ? <p className="truncate text-danger">{i.lastError.message}</p> : null}
    </li>
  );
}

export function DevicesPanel() {
  const { status, error, order, devices, integrations, persistent, safety, connect, setSafety } = useHub();
  const { t } = useT();
  const now = useNow(5000);
  const [adding, setAdding] = useState(false);
  const [safetyErr, setSafetyErr] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") void connect();
  }, [status, connect]);

  const list = useMemo(() => order.map((id) => devices[id]).filter((d) => d && !d.hidden), [order, devices]);
  const realCount = list.filter((d) => d && !d.simulated).length;

  if (status === "needs_pairing") return <PairCard />;
  if (status === "idle" || status === "connecting") {
    return (
      <Card>
        <p className="p-4 text-sm text-ink-300">{t("hub.panel.connecting")}</p>
      </Card>
    );
  }
  if (status === "error" || status === "unsupported") {
    return (
      <Callout tone="danger" title={t("hub.panel.cannotLoad")} role="alert">
        {error?.message}
        {error?.hint ? <span className="block text-xs">{error.hint}</span> : null}
        <Button className="mt-2" variant="secondary" size="sm" onClick={() => void connect()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t("hub.panel.retry")}
        </Button>
      </Callout>
    );
  }

  async function exportConfig() {
    const data = await hubClient().exportConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `se7enx-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4" data-testid="devices-panel">
      <Card>
        <CardHeader
          title={t("hub.panel.title")}
          subtitle={t("hub.panel.count", { count: list.length, real: realCount })}
          icon={<Boxes className="h-4 w-4" />}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> {t("hub.panel.add")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void exportConfig()} aria-label={t("hub.panel.exportAria")}>
                <Download className="h-3.5 w-3.5" aria-hidden /> {t("hub.panel.export")}
              </Button>
            </div>
          }
        />
        <div className="space-y-3 p-4 pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-700 p-3">
            <p className="text-xs text-ink-300">
              {safety.active ? (
                <span className="text-danger">{safety.by ? t("hub.panel.hubStopActiveBy", { by: safety.by }) : t("hub.panel.hubStopActive")}</span>
              ) : (
                t("hub.panel.hubStopInfo")
              )}
            </p>
            <Button
              variant={safety.active ? "secondary" : "danger"}
              size="sm"
              onClick={() =>
                void setSafety(!safety.active)
                  .then(() => setSafetyErr(null))
                  .catch((x) => setSafetyErr(describeError(x).message))
              }
              data-testid="hub-safety"
            >
              <OctagonX className="h-3.5 w-3.5" aria-hidden /> {safety.active ? t("hub.panel.resume") : t("hub.panel.stopAll")}
            </Button>
          </div>
          {safetyErr ? <p className="text-xs text-danger">{safetyErr}</p> : null}
          {!persistent ? <Callout tone="warn">{t("hub.panel.noData")}</Callout> : null}
          <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("hub.panel.integrations")}>
            {integrations.map((i) => (
              <IntegrationChip key={i.name} i={i} now={now} />
            ))}
          </ul>
        </div>
      </Card>
      {list.length === 0 ? (
        <Card>
          <p className="p-4 text-sm text-ink-300">{t("hub.panel.empty")}</p>
        </Card>
      ) : (
        <div className="grid gap-3">{list.map((d) => (d ? <DeviceCard key={d.id} device={d} now={now} /> : null))}</div>
      )}
      <AddDeviceDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
