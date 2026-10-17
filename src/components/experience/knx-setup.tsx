"use client";
/**
 * KNX setup inside the Connect workspace:
 *  - KNX/IP: interface type, IP, port, route-back — stored on the hub (restricted to the allowed
 *    private networks, environment configuration takes precedence). "Save and connect" runs the
 *    real KNXnet/IP handshake on the hub; nothing is written to the bus.
 *  - KNX USB: hub-side detection with honest reporting (detected ≠ connected) and knxd guidance.
 */
import { Cable, Plus, Search, Trash2, Usb } from "lucide-react";
import { Tabs as RTabs } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Checkbox, FieldHint, Input, Label } from "@/components/ui/primitives";
import { describeError } from "@/lib/adapters/types";
import { KNX_CONNECTION_TYPES, type KnxConnectionType, type KnxInterface, type KnxUsbReport } from "@/lib/hub/contract";
import { hubClient, useHub } from "@/lib/hub/hub-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { knxDiagnosis, STAGE_TONE, type Diagnosis } from "./diagnostics";

const DEFAULT_PORT = 3671;

export function KnxSetup({ onAddLight, onStatus }: { onAddLight: () => void; onStatus?: (k: KnxInterface) => void }) {
  const { t, dir } = useT();
  const hubReady = useHub((s) => s.status === "ready");
  const [tab, setTab] = useState<"ip" | "usb">("ip");
  return (
    <div className="space-y-3 rounded-2xl border border-ink-700 bg-ink-900/60 p-4" data-testid="knx-setup">
      <RTabs.Root value={tab} onValueChange={(v) => setTab(v as "ip" | "usb")} dir={dir}>
        <RTabs.List className="mb-3 inline-flex gap-1 rounded-xl bg-ink-850 p-1" aria-label="KNX">
          {(["ip", "usb"] as const).map((id) => (
            <RTabs.Trigger
              key={id}
              value={id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                tab === id && "bg-ink-700 text-ink-50",
              )}
            >
              {id === "ip" ? <Cable className="h-3.5 w-3.5" aria-hidden /> : <Usb className="h-3.5 w-3.5" aria-hidden />}
              {t(`knx.tabs.${id}`)}
            </RTabs.Trigger>
          ))}
        </RTabs.List>
        <RTabs.Content value="ip">{tab === "ip" ? <KnxIpForm hubReady={hubReady} onStatus={onStatus} /> : null}</RTabs.Content>
        <RTabs.Content value="usb">{tab === "usb" ? <KnxUsbCheck hubReady={hubReady} /> : null}</RTabs.Content>
      </RTabs.Root>
      <div className="border-t border-ink-800 pt-3">
        <Button variant="secondary" size="sm" onClick={onAddLight} disabled={!hubReady} data-testid="knx-add-light">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("knx.addLight")}
        </Button>
        <p className="mt-1.5 text-xs text-ink-400">{t("knx.addLightHint")}</p>
      </div>
    </div>
  );
}

function KnxIpForm({ hubReady, onStatus }: { hubReady: boolean; onStatus?: (k: KnxInterface) => void }) {
  const { t } = useT();
  const [info, setInfo] = useState<KnxInterface | null>(null);
  const [type, setType] = useState<KnxConnectionType>("tunneling");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [routeBack, setRouteBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  const apply = useCallback(
    (k: KnxInterface) => {
      setInfo(k);
      onStatus?.(k); // keep the workspace card in sync
      if (k.config) {
        if ((KNX_CONNECTION_TYPES as readonly string[]).includes(k.config.connectionType)) setType(k.config.connectionType as KnxConnectionType);
        setHost(k.config.host ?? "");
        setPort(String(k.config.port));
        setRouteBack(k.config.routeBack);
      }
    },
    [onStatus],
  );

  useEffect(() => {
    if (!hubReady) return;
    let alive = true;
    hubClient()
      .knxInterface()
      .then((k) => alive && apply(k))
      .catch((err) => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [hubReady, apply]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // while saving/testing the hub may briefly report "disconnected" — show "connecting" instead
  const diagnosis: Diagnosis = busy ? { stage: "connecting" } : knxDiagnosis(info, hubReady);
  const editable = info?.editable ?? false;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const needsHost = type !== "routing";
  const gatewayName = info?.status.gateway?.name ?? info?.status.gateway?.host ?? info?.config?.host ?? "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-ink-50">{t("knx.interfaceTitle")}</h4>
          <p className="text-xs text-ink-300">{t("knx.interfaceBody")}</p>
        </div>
        <Badge tone={STAGE_TONE[diagnosis.stage]} dot>
          <span data-testid="knx-stage" data-stage={diagnosis.stage}>
            {t(`connect.status.${diagnosis.stage}`)}
          </span>
        </Badge>
      </div>
      {diagnosis.stage === "connected" ? (
        <p className="text-xs text-ok">
          {t("knx.connectedTo", { name: gatewayName })}
          <span className="mt-0.5 block text-ink-400">{t("knx.connectedNote")}</span>
        </p>
      ) : null}
      {diagnosis.detail ? <p className="text-xs text-danger">{t(diagnosis.detail)}</p> : null}
      {diagnosis.guide ? <p className="text-xs text-ink-300">{t(diagnosis.guide)}</p> : null}
      {info?.status.lastError && diagnosis.stage !== "connected" ? (
        <details className="text-xs text-ink-400">
          <summary className="cursor-pointer select-none">{t("common.details")}</summary>
          <p className="mt-1 font-mono text-[11px]" dir="ltr">
            {info.status.lastError.code}: {info.status.lastError.message}
          </p>
        </details>
      ) : null}
      {info?.secure ? <p className="text-xs text-ink-300">{t("knx.secure")}</p> : null}
      {info && !editable ? <Callout tone="neutral">{t("knx.envManaged")}</Callout> : null}

      {hubReady && editable ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              apply(
                await hubClient().configureKnxInterface({
                  connectionType: type,
                  host: needsHost ? host.trim() : null,
                  port: portNumber,
                  routeBack: type === "tunneling" && routeBack,
                }),
              );
              apply(await hubClient().testKnxInterface()); // real handshake, waits for the result
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="knx-type">{t("knx.type")}</Label>
              <select
                id="knx-type"
                value={type}
                onChange={(e) => setType(e.target.value as KnxConnectionType)}
                className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm"
                data-testid="knx-type"
              >
                {KNX_CONNECTION_TYPES.map((ct) => (
                  <option key={ct} value={ct}>
                    {t(`knx.types.${ct}`)}
                  </option>
                ))}
              </select>
            </div>
            {needsHost ? (
              <div className="space-y-1">
                <Label htmlFor="knx-host">{t("knx.ip")}</Label>
                <Input
                  id="knx-host"
                  dir="ltr"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.1.10"
                  autoComplete="off"
                  inputMode="decimal"
                  data-testid="knx-host"
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="knx-port">{t("knx.port")}</Label>
              <Input
                id="knx-port"
                dir="ltr"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                invalid={!portValid}
                data-testid="knx-port"
              />
            </div>
          </div>
          {type === "tunneling" ? (
            <Checkbox id="knx-routeback" checked={routeBack} onCheckedChange={setRouteBack}>
              {t("knx.routeBack")}
            </Checkbox>
          ) : null}
          {info?.allowedNetworks.length ? <FieldHint>{t("knx.allowed", { networks: info.allowedNetworks.join(", ") })}</FieldHint> : null}
          {error ? (
            <Callout tone="danger" role="alert">
              {error.message}
              {error.hint ? <span className="block text-xs opacity-80">{error.hint}</span> : null}
            </Callout>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy || !portValid || (needsHost && !host.trim())} data-testid="knx-save">
              {busy ? t("common.loading") : t("knx.save")}
            </Button>
            {info?.source === "hub" ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(async () => apply(await hubClient().testKnxInterface()))}
                  data-testid="knx-test"
                >
                  {t("knx.test")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await hubClient().removeKnxInterface();
                      apply(await hubClient().knxInterface());
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  {t("knx.remove")}
                </Button>
              </>
            ) : null}
          </div>
        </form>
      ) : error ? (
        <p className="text-xs text-danger">{error.message}</p>
      ) : null}
    </div>
  );
}

function KnxUsbCheck({ hubReady }: { hubReady: boolean }) {
  const { t } = useT();
  const [report, setReport] = useState<KnxUsbReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detected = report?.status === "detected_no_access" || report?.status === "detected_unsupported";
  return (
    <div className="space-y-3" data-testid="knx-usb">
      <div>
        <h4 className="text-sm font-semibold text-ink-50">{t("knx.usb.title")}</h4>
        <p className="text-xs text-warn">{t("knx.usb.unsupported")}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={!hubReady || busy}
        data-testid="knx-usb-scan"
        onClick={() => {
          setBusy(true);
          setError(null);
          hubClient()
            .knxUsbReport()
            .then(setReport)
            .catch((err) => setError(describeError(err).message))
            .finally(() => setBusy(false));
        }}
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        {busy ? t("knx.usb.scanning") : t("knx.usb.scan")}
      </Button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {report ? (
        <div className="space-y-2 rounded-xl border border-ink-700 p-3 text-xs" data-testid="knx-usb-report" data-status={report.status}>
          <div className="flex flex-wrap gap-1.5">
            {detected ? <Badge tone="accent">{t("connect.status.interfaceDetected")}</Badge> : null}
            {report.status === "detected_unsupported" ? <Badge tone="warn">{t("connect.status.protocolUnsupported")}</Badge> : null}
          </div>
          <p className="text-ink-100">{t(`knx.usb.status.${report.status}`)}</p>
          {report.devices.map((d) => (
            <p key={`${d.vendorId}:${d.productId}`} className="text-ink-300">
              {t("knx.usb.device", { name: [d.manufacturer, d.product].filter(Boolean).join(" ") || d.match, id: `${d.vendorId}:${d.productId}` })}
            </p>
          ))}
          {report.sysfsVisible ? (
            <p className="text-ink-400">{t("knx.usb.hidraw", { nodes: report.hidrawNodes.length ? report.hidrawNodes.join(", ") : t("knx.usb.none") })}</p>
          ) : null}
          <p className="text-ink-300">{t("knx.usb.guidance")}</p>
        </div>
      ) : null}
    </div>
  );
}
