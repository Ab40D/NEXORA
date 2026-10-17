"use client";
/**
 * Connection workspace: Simulation, Home Assistant, KNX and Shelly cards with honest diagnostics,
 * the lights known to the hub ("Use this light"), and the explicit first-test step.
 * Real providers are configured on the SE7ENX hub; this page never talks to devices directly.
 */
import { Cable, CircleCheck, FlaskConical, Home, Lightbulb, Network, Plug, ShieldAlert, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AddDeviceDialog, type Flow } from "@/components/hub/add-device-dialog";
import { PairCard } from "@/components/hub/devices-panel";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card } from "@/components/ui/primitives";
import { snapshotOfDevice, useExperience } from "@/lib/experience/store";
import type { HubDevice, KnxInterface } from "@/lib/hub/contract";
import { APPLIANCE, hubClient, useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useUi } from "@/lib/state/ui-store";
import { cn } from "@/lib/utils";
import { deviceDiagnosis, integrationDiagnosis, knxDiagnosis, shellyDiagnosis, STAGE_TONE, type Diagnosis } from "./diagnostics";
import { FirstTestDialog } from "./first-test-dialog";
import { KnxSetup } from "./knx-setup";

const LIGHT_TYPES = new Set(["light", "switch", "outlet"]);

function StageBadge({ d, testId }: { d: Diagnosis; testId?: string }) {
  const { t } = useT();
  return (
    <Badge tone={STAGE_TONE[d.stage]} dot className="whitespace-nowrap">
      <span data-testid={testId} data-stage={d.stage}>
        {t(`connect.status.${d.stage}`)}
      </span>
    </Badge>
  );
}

function ProviderCard({
  icon,
  title,
  body,
  diagnosis,
  action,
  onAction,
  disabled,
  active,
  testId,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  diagnosis: Diagnosis;
  action: string;
  onAction: () => void;
  disabled?: boolean;
  active?: boolean;
  testId: string;
}) {
  const { t } = useT();
  return (
    <Card className={cn("flex flex-col gap-3 p-4", active && "border-accent/60")} data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-50">
          {icon}
          {title}
        </h3>
        <StageBadge d={diagnosis} testId={`${testId}-stage`} />
      </div>
      <p className="text-xs leading-relaxed text-ink-300">{body}</p>
      {diagnosis.detail ? <p className="text-xs text-danger">{t(diagnosis.detail)}</p> : null}
      {diagnosis.guide && diagnosis.stage !== "notConfigured" ? <p className="text-xs text-ink-200">{t(diagnosis.guide)}</p> : null}
      <div className="mt-auto">
        <Button variant={active ? "primary" : "secondary"} size="sm" onClick={onAction} disabled={disabled} data-testid={`${testId}-action`}>
          {action}
        </Button>
      </div>
    </Card>
  );
}

function HubSection() {
  const { t } = useT();
  const status = useHub((s) => s.status);
  const error = useHub((s) => s.error);
  const openWizard = useUi((s) => s.openWizard);
  if (status === "ready") {
    return (
      <p className="flex items-center gap-2 text-xs text-ok" data-testid="hub-ready">
        <CircleCheck className="h-3.5 w-3.5" aria-hidden />
        {t("connect.hub.connected")}
      </p>
    );
  }
  if (status === "needs_pairing" && APPLIANCE) return <PairCard />;
  return (
    <Callout tone="neutral" title={t("connect.hub.title")}>
      <span className="block text-xs leading-relaxed">{t("connect.hub.body")}</span>
      {error ? <span className="mt-1 block text-xs text-warn">{error.message}</span> : null}
      {!APPLIANCE ? (
        <Button className="mt-2" variant="secondary" size="sm" onClick={openWizard} data-testid="hub-open-wizard">
          <Network className="h-3.5 w-3.5" aria-hidden />
          {t("connect.hub.open")}
        </Button>
      ) : null}
    </Callout>
  );
}

function LightRow({ device, selected, onUse }: { device: HubDevice; selected: boolean; onUse: () => void }) {
  const { t, pct } = useT();
  const safety = useHub((s) => s.safety);
  const [confirm, setConfirm] = useState(false);
  const snap = snapshotOfDevice(device, safety.active);
  const diag = deviceDiagnosis(device);
  const needsTest = !device.simulated && !device.controlEnabled;
  const state = snap.state;
  return (
    <li
      className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-700 p-3", selected && "border-accent/60 bg-accent/5")}
      data-testid={`light-${device.id}`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-50">
          <Lightbulb className={cn("h-4 w-4 shrink-0", state?.on ? "text-warm" : "text-ink-400")} aria-hidden />
          <span className="truncate" dir="auto">
            {device.name}
          </span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-300">
          <span>{t(`experience.providers.${snap.provider}`)}</span>
          {device.simulated ? <Badge tone="sim">{t("badge.simulation")}</Badge> : <Badge tone="accent">{t("badge.real")}</Badge>}
          <StageBadge d={diag} />
          {state ? (
            <span dir="auto">
              {state.on ? (snap.dimmable && state.brightness !== null ? `${t("light.on")} · ${pct(state.brightness)}` : t("light.on")) : t("light.off")}
            </span>
          ) : null}
        </p>
        {diag.guide ? <p className="mt-1 text-[11px] text-ink-400">{t(diag.guide)}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {needsTest ? (
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)} data-testid={`first-test-${device.id}`}>
            <ShieldAlert className="h-3.5 w-3.5 text-warn" aria-hidden />
            {t("connect.devices.firstTest")}
          </Button>
        ) : null}
        <Button variant={selected ? "secondary" : "primary"} size="sm" onClick={onUse} disabled={selected} data-testid={`use-${device.id}`}>
          {selected ? t("connect.devices.selected") : t("connect.devices.use")}
        </Button>
      </div>
      <FirstTestDialog deviceId={device.id} deviceName={device.name} open={confirm} onOpenChange={setConfirm} />
    </li>
  );
}

export function ConnectWorkspace() {
  const { t } = useT();
  const status = useHub((s) => s.status);
  const connect = useHub((s) => s.connect);
  const devicesMap = useHub((s) => s.devices);
  const order = useHub((s) => s.order);
  const integrations = useHub((s) => s.integrations);
  const openWizard = useUi((s) => s.openWizard);
  const setTab = useUi((s) => s.setTab);
  const { target, deviceId, selectSim, selectDevice } = useExperience();
  const [knxOpen, setKnxOpen] = useState(false);
  const [knx, setKnx] = useState<KnxInterface | null>(null);
  const [dialog, setDialog] = useState<{ flow: Flow; key: number } | null>(null);
  const hubReady = status === "ready";

  useEffect(() => {
    if (status === "idle") void connect();
  }, [status, connect]);

  useEffect(() => {
    if (!hubReady) return;
    let alive = true;
    hubClient()
      .knxInterface()
      .then((k) => alive && setKnx(k))
      .catch(() => alive && setKnx(null));
    return () => {
      alive = false;
    };
  }, [hubReady, knxOpen]);

  const devices = useMemo(() => order.map((id) => devicesMap[id]).filter((d): d is HubDevice => !!d && !d.hidden), [order, devicesMap]);
  const lights = devices.filter((d) => LIGHT_TYPES.has(d.type));
  const ha = integrations.find((i) => i.name === "homeassistant");
  const openFlow = (flow: Flow) => setDialog((d) => ({ flow, key: (d?.key ?? 0) + 1 })); // new key = fresh dialog state
  const use = (id: string) => {
    selectDevice(id);
    setTab("experience");
  };

  const cards: {
    id: string;
    icon: ReactNode;
    title: MessageKey;
    body: MessageKey;
    action: MessageKey;
    diagnosis: Diagnosis;
    onAction: () => void;
    disabled?: boolean;
    active?: boolean;
  }[] = [
    {
      id: "provider-sim",
      icon: <FlaskConical className="h-4 w-4 text-sim" aria-hidden />,
      title: "connect.sim.title",
      body: "connect.sim.body",
      action: "connect.sim.action",
      diagnosis: { stage: "ready" },
      active: target === "sim",
      onAction: () => {
        selectSim();
        setTab("experience");
      },
    },
    {
      id: "provider-ha",
      icon: <Home className="h-4 w-4 text-accent" aria-hidden />,
      title: "connect.ha.title",
      body: "connect.ha.body",
      action: "connect.ha.action",
      diagnosis: integrationDiagnosis(ha, hubReady),
      disabled: !hubReady,
      onAction: () => openFlow("homeassistant"),
    },
    {
      id: "provider-knx",
      icon: <Cable className="h-4 w-4 text-accent" aria-hidden />,
      title: "connect.knx.title",
      body: "connect.knx.body",
      action: "connect.knx.action",
      diagnosis: knxDiagnosis(knx, hubReady),
      disabled: !hubReady,
      active: knxOpen,
      onAction: () => setKnxOpen((v) => !v),
    },
    {
      id: "provider-shelly",
      icon: <Plug className="h-4 w-4 text-accent" aria-hidden />,
      title: "connect.shelly.title",
      body: "connect.shelly.body",
      action: "connect.shelly.action",
      diagnosis: shellyDiagnosis(devices, hubReady),
      disabled: !hubReady,
      onAction: () => openFlow("shelly"),
    },
  ];

  return (
    <div className="space-y-4" data-testid="connect-workspace">
      <div>
        <h2 className="text-lg font-semibold text-ink-50">{t("connect.title")}</h2>
        <p className="text-sm text-ink-300">{t("connect.subtitle")}</p>
      </div>
      <HubSection />
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <ProviderCard
            key={c.id}
            testId={c.id}
            icon={c.icon}
            title={t(c.title)}
            body={t(c.body)}
            action={t(c.action)}
            diagnosis={c.diagnosis}
            onAction={c.onAction}
            disabled={c.disabled}
            active={c.active}
          />
        ))}
      </div>
      {knxOpen && hubReady ? <KnxSetup onAddLight={() => openFlow("knx")} onStatus={setKnx} /> : null}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink-50">{t("connect.devices.title")}</h3>
          {hubReady ? (
            <Button variant="ghost" size="sm" onClick={() => openFlow("shelly")}>
              {t("connect.devices.add")}
            </Button>
          ) : null}
        </div>
        {!hubReady ? (
          <p className="text-xs text-ink-400">{t("experience.hubNeeded")}</p>
        ) : lights.length === 0 ? (
          <p className="text-xs text-ink-400">{t("connect.devices.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {lights.map((d) => (
              <LightRow key={d.id} device={d} selected={target === "hub" && deviceId === d.id} onUse={() => use(d.id)} />
            ))}
          </ul>
        )}
      </Card>

      <button
        type="button"
        onClick={openWizard}
        className="inline-flex items-center gap-1.5 text-xs text-ink-400 underline-offset-4 hover:text-ink-100 hover:underline"
        data-testid="legacy-wizard"
      >
        <Wrench className="h-3.5 w-3.5" aria-hidden />
        {t("connect.legacy")}
      </button>
      {dialog ? <AddDeviceDialog key={dialog.key} open onOpenChange={(v) => !v && setDialog(null)} initialFlow={dialog.flow} /> : null}
    </div>
  );
}
