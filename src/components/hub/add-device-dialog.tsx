"use client";

import { Dialog, Tabs as RTabs } from "radix-ui";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, FieldHint, Input, Label, Switch } from "@/components/ui/primitives";
import { describeError } from "@/lib/adapters/types";
import type { DeviceType, HaConfig, HaEntity, ShellyIdentity } from "@/lib/hub/contract";
import { describeReported, slugifyId } from "@/lib/hub/format";
import { hubClient, useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Flow = "shelly" | "homeassistant" | "knx" | "simulated";

const KNOWN_HA_STATES = new Set(["connected", "connecting", "degraded", "disconnected", "auth_failed", "error", "not_configured"]);
const CAPABILITIES = new Set(["on_off", "brightness", "dim_relative", "open_close", "position", "stop", "power", "energy", "temperature", "humidity", "illuminance", "value", "binary"]);

/** Localized capability name (unknown capabilities are shown as-is). */
function capLabel(t: (key: MessageKey) => string, cap: string): string {
  return CAPABILITIES.has(cap) ? t(`hub.cap.${cap}` as MessageKey) : cap;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}

function ErrorLine({ error }: { error: { message: string; hint?: string } | null }) {
  if (!error) return null;
  return (
    <Callout tone="danger" role="alert">
      {error.message}
      {error.hint ? <span className="block text-xs opacity-80">{error.hint}</span> : null}
    </Callout>
  );
}

function useExistingIds(): string[] {
  return useHub((s) => s.order);
}

/* ------------------------------------------------------------------ Shelly */

function ShellyFlow({ onDone }: { onDone: () => void }) {
  const { t, locale } = useT();
  const add = useHub((s) => s.add);
  const ids = useExistingIds();
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ident, setIdent] = useState<ShellyIdentity | null>(null);
  const [channel, setChannel] = useState<string>("");
  const [name, setName] = useState("");
  const [type, setType] = useState<DeviceType>("switch");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  async function identify() {
    setBusy(true);
    setError(null);
    setIdent(null);
    try {
      const r = await hubClient().shellyIdentify(host.trim(), username.trim() || undefined, password || undefined);
      setIdent(r);
      const first = r.channels[0];
      if (first) {
        setChannel(`${first.component}:${first.channel}`);
        setType(first.suggestedType);
        setName(`${r.model} ${first.component} ${first.channel}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const selected = ident?.channels.find((c) => `${c.component}:${c.channel}` === channel);
  const allowedTypes: DeviceType[] = selected?.component === "cover" ? ["cover"] : selected?.component === "light" ? ["light"] : ["switch", "outlet", "light"];

  async function submit() {
    if (!ident || !selected) return;
    setBusy(true);
    setError(null);
    try {
      await add({
        device: {
          integration: "shelly",
          id: slugifyId(name, ids),
          name: name.trim(),
          type,
          host: ident.host,
          gen: ident.gen,
          component: selected.component,
          channel: selected.channel,
          ...(ident.gen === 1 && username.trim() ? { username: username.trim() } : {}),
        },
        ...(password ? { credentials: { password, ...(ident.gen === 1 && username.trim() ? { username: username.trim() } : {}) } } : {}),
      });
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">{t("hub.add.shelly.intro")}</p>
      <Field id="sh-host" label={t("hub.add.shelly.host")} hint={t("hub.add.shelly.hostHint")}>
        <Input id="sh-host" dir="ltr" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.40" autoComplete="off" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sh-user" label={t("hub.add.shelly.user")} hint={t("hub.add.shelly.userHint")}>
          <Input id="sh-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="sh-pass" label={t("hub.add.shelly.pass")} hint={t("hub.add.shelly.passHint")}>
          <Input id="sh-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void identify()} disabled={busy || !host.trim()}>
        <Search className="h-3.5 w-3.5" aria-hidden /> {t("hub.add.shelly.identify")}
      </Button>
      <ErrorLine error={error} />
      {ident ? (
        <div className="space-y-3 rounded-xl border border-ink-600 p-3">
          <p className="text-sm text-ink-100">
            {t("hub.add.shelly.info", { model: ident.model, gen: ident.gen, firmware: ident.firmware ?? "?" })}{" "}
            {ident.authRequired ? <Badge tone="warn">{t("hub.add.shelly.protected")}</Badge> : null}
          </p>
          {ident.channels.length === 0 ? <p className="text-xs text-warn">{t("hub.add.shelly.noChannel")}</p> : null}
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-ink-200">{t("hub.add.shelly.channel")}</legend>
            {ident.channels.map((c) => {
              const key = `${c.component}:${c.channel}`;
              return (
                <label key={key} className="flex items-center gap-2 text-xs text-ink-200">
                  <input
                    type="radio"
                    name="shelly-channel"
                    value={key}
                    checked={channel === key}
                    onChange={() => {
                      setChannel(key);
                      setType(c.suggestedType);
                    }}
                  />
                  <span className="font-mono">{key}</span>
                  <span className="text-ink-400">
                    {c.capabilities.map((cap) => capLabel(t, cap)).join(", ")} · {describeReported(c.suggestedType, c.state, locale).join(" · ") || t("hub.add.shelly.noState")}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {ident.unsupportedComponents.length ? (
            <p className="text-xs text-ink-400">{t("hub.add.shelly.unsupported", { list: ident.unsupportedComponents.join(", ") })}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sh-name" label={t("hub.add.name")}>
              <Input id="sh-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </Field>
            <Field id="sh-type" label={t("hub.add.type")}>
              <select id="sh-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
                {allowedTypes.map((dt) => (
                  <option key={dt} value={dt}>
                    {t(`hub.type.${dt}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button variant="primary" size="sm" disabled={busy || !selected || !name.trim()} onClick={() => void submit()}>
            {t("hub.add.shelly.submit")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Home Assistant */

function HomeAssistantFlow({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const add = useHub((s) => s.add);
  const ids = useExistingIds();
  const [cfg, setCfg] = useState<HaConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [verifyTls, setVerifyTls] = useState(true);
  const [entities, setEntities] = useState<HaEntity[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    hubClient()
      .homeAssistant()
      .then(async (c) => {
        if (!alive) return;
        setCfg(c);
        if (c.config.url) setUrl(c.config.url);
        setVerifyTls(c.config.verifyTls);
        if (c.status.state === "connected") {
          const list = await hubClient().homeAssistantEntities();
          if (alive) setEntities(list);
        }
      })
      .catch((err) => {
        if (alive) setError(describeError(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const connected = cfg?.status.state === "connected";
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // lights first (the Smart Light Experience targets lights), then everything else
    return entities
      .filter((e) => !f || e.entityId.includes(f) || e.name.toLowerCase().includes(f))
      .sort((a, b) => Number(b.domain === "light") - Number(a.domain === "light"))
      .slice(0, 200);
  }, [entities, filter]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">{t("hub.add.ha.intro")}</p>
      {cfg ? (
        <p className="text-xs text-ink-300">
          {t("hub.add.ha.status")}{" "}
          <span className={connected ? "text-ok" : "text-warn"} data-testid="ha-state">
            {KNOWN_HA_STATES.has(cfg.status.state) ? t(`hub.panel.state.${cfg.status.state}` as MessageKey) : cfg.status.state}
          </span>{" "}
          · {cfg.status.detail}
          {cfg.status.lastError ? <span className="block text-danger">{cfg.status.lastError.message}</span> : null}
        </p>
      ) : null}
      {cfg?.config.readOnly ? (
        <Callout tone="neutral">{t("hub.add.ha.env")}</Callout>
      ) : (
        <>
          <Field id="ha-url" label={t("hub.add.ha.url")} hint={t("hub.add.ha.urlHint")}>
            <Input id="ha-url" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://homeassistant.local:8123" autoComplete="off" />
          </Field>
          <Field
            id="ha-token"
            label={cfg?.config.tokenStored ? t("hub.add.ha.tokenStored") : t("hub.add.ha.token")}
            hint={t("hub.add.ha.tokenHint")}
          >
            <Input id="ha-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
          </Field>
          <Switch id="ha-tls" checked={verifyTls} onCheckedChange={setVerifyTls} label={t("hub.add.ha.tls")} description={t("hub.add.ha.tlsHint")} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !url.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await hubClient().testHomeAssistant(url.trim(), token || undefined, verifyTls);
                  setNote(t("hub.add.ha.testOk", { name: r.locationName ?? "Home Assistant", version: r.version ?? "" }));
                })
              }
            >
              {t("hub.add.ha.test")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !url.trim() || (!token && !cfg?.config.tokenStored)}
              onClick={() =>
                void run(async () => {
                  setCfg(await hubClient().configureHomeAssistant(url.trim(), token || undefined, verifyTls));
                  setToken("");
                  setNote(t("hub.add.ha.saved"));
                  for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    const c = await hubClient().homeAssistant();
                    setCfg(c);
                    if (c.status.state === "connected") {
                      setEntities(await hubClient().homeAssistantEntities());
                      setNote(t("hub.add.ha.connected"));
                      return;
                    }
                    if (c.status.state === "auth_failed") return;
                  }
                })
              }
            >
              {t("hub.add.ha.save")}
            </Button>
          </div>
        </>
      )}
      {note ? <p className="text-xs text-ok">{note}</p> : null}
      <ErrorLine error={error} />
      {connected ? (
        <div className="space-y-2">
          <Input aria-label={t("hub.add.ha.filter")} placeholder={t("hub.add.ha.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto pr-1">
            {shown.map((e) => (
              <li key={e.entityId} className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 px-2 py-1.5 text-xs">
                <span className="min-w-0">
                  <span className="block truncate">
                    <span className="text-ink-100" dir="auto">
                      {e.name}
                    </span>{" "}
                    <span className="font-mono text-ink-400" dir="ltr">
                      {e.entityId}
                    </span>
                    <span className="text-ink-400"> · {e.state}</span>
                  </span>
                  {e.capabilities.length ? (
                    <span className="block truncate text-[11px] text-ink-400" data-testid="ha-entity-caps">
                      {e.capabilities.map((cap) => capLabel(t, cap)).join(", ")}
                    </span>
                  ) : null}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || e.added}
                  onClick={() =>
                    void run(async () => {
                      await add({ device: { integration: "homeassistant", id: slugifyId(e.name, ids), name: e.name.slice(0, 64), type: e.suggestedType, entityId: e.entityId } });
                      setEntities((list) => list.map((x) => (x.entityId === e.entityId ? { ...x, added: true } : x)));
                    })
                  }
                >
                  {e.added ? t("hub.add.ha.added") : t("hub.add.ha.add")}
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={onDone}>
            {t("hub.add.ha.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ KNX */

/** Separate group addresses per function (switching ≠ dimming); only these are ever written. */
const KNX_FIELDS: Record<DeviceType, { key: string; label: MessageKey; hint: MessageKey; required?: boolean }[]> = {
  switch: [
    { key: "switch", label: "hub.add.knx.f.switch", hint: "hub.add.knx.h.example", required: true },
    { key: "switchStatus", label: "hub.add.knx.f.switchStatus", hint: "hub.add.knx.h.feedbackRecommended" },
  ],
  outlet: [
    { key: "switch", label: "hub.add.knx.f.switch", hint: "hub.add.knx.h.example", required: true },
    { key: "switchStatus", label: "hub.add.knx.f.switchStatus", hint: "hub.add.knx.h.feedbackRecommended" },
  ],
  light: [
    { key: "switch", label: "hub.add.knx.f.switch", hint: "hub.add.knx.h.onoff" },
    { key: "switchStatus", label: "hub.add.knx.f.switchStatus", hint: "hub.add.knx.h.feedback" },
    { key: "brightness", label: "hub.add.knx.f.brightness", hint: "hub.add.knx.h.percent" },
    { key: "brightnessStatus", label: "hub.add.knx.f.brightnessStatus", hint: "hub.add.knx.h.feedback" },
    { key: "dim", label: "hub.add.knx.f.dim", hint: "hub.add.knx.h.dim" },
  ],
  cover: [
    { key: "upDown", label: "hub.add.knx.f.upDown", hint: "hub.add.knx.h.upDown" },
    { key: "stop", label: "hub.add.knx.f.stop", hint: "hub.add.knx.h.stop" },
    { key: "position", label: "hub.add.knx.f.position", hint: "hub.add.knx.h.position" },
    { key: "positionStatus", label: "hub.add.knx.f.positionStatus", hint: "hub.add.knx.h.feedback" },
  ],
  sensor: [
    { key: "value", label: "hub.add.knx.f.value", hint: "hub.add.knx.h.valueExample", required: true },
    { key: "valueDpt", label: "hub.add.knx.f.valueDpt", hint: "hub.add.knx.h.dpt", required: true },
    { key: "unit", label: "hub.add.knx.f.unit", hint: "hub.add.knx.h.unit" },
  ],
};

function KnxFlow({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const add = useHub((s) => s.add);
  const ids = useExistingIds();
  const knx = useHub((s) => s.integrations.find((i) => i.name === "knx"));
  const [type, setType] = useState<DeviceType>("light");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const mapping = Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() && KNX_FIELDS[type].some((f) => f.key === k)).map(([k, v]) => [k, v.trim()]));
      await add({ device: { integration: "knx", id: slugifyId(name, ids), name: name.trim(), type, ...mapping } });
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">
        <span className={knx?.state === "connected" ? "text-ok" : "text-warn"}>
          {t("hub.add.knx.interface", {
            state: knx && KNOWN_HA_STATES.has(knx.state) ? t(`hub.panel.state.${knx.state}` as MessageKey) : (knx?.state ?? t("common.unknown")),
          })}
        </span>
        {knx?.detail ? ` · ${knx.detail}` : ""}
        <span className="block">{t("hub.add.knx.only")}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="knx-name" label={t("hub.add.name")}>
          <Input id="knx-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field id="knx-type" label={t("hub.add.type")}>
          <select id="knx-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
            {(["light", "switch", "outlet", "cover", "sensor"] as DeviceType[]).map((dt) => (
              <option key={dt} value={dt}>
                {t(`hub.type.${dt}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {KNX_FIELDS[type].map((f) => (
          <Field key={f.key} id={`knx-${f.key}`} label={`${t(f.label)}${f.required ? " *" : ""}`} hint={t(f.hint)}>
            <Input id={`knx-${f.key}`} dir="ltr" value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} autoComplete="off" />
          </Field>
        ))}
      </div>
      <ErrorLine error={error} />
      <Button variant="primary" size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
        {t("hub.add.knx.submit")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ simulated */

function SimulatedFlow({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const add = useHub((s) => s.add);
  const ids = useExistingIds();
  const [type, setType] = useState<DeviceType>("light");
  const [name, setName] = useState(() => t("hub.add.sim.defaultName"));
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">{t("hub.add.sim.intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sim-name" label={t("hub.add.name")}>
          <Input id="sim-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field id="sim-type" label={t("hub.add.type")}>
          <select id="sim-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
            {(["light", "switch", "outlet", "cover", "sensor"] as DeviceType[]).map((dt) => (
              <option key={dt} value={dt}>
                {t(`hub.type.${dt}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorLine error={error} />
      <Button
        variant="primary"
        size="sm"
        disabled={!name.trim()}
        onClick={() =>
          void add({ device: { integration: "simulated", id: slugifyId(name, ids), name: name.trim(), type, ...(type === "sensor" ? { sensorKind: "temperature" } : {}) } })
            .then(onDone)
            .catch((err) => setError(describeError(err)))
        }
      >
        {t("hub.add.sim.submit")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function AddDeviceDialog({ open, onOpenChange, initialFlow = "shelly" }: { open: boolean; onOpenChange: (v: boolean) => void; initialFlow?: Flow }) {
  const { t, dir } = useT();
  const [flow, setFlow] = useState<Flow>(initialFlow);
  const close = () => onOpenChange(false);
  const tabs: Flow[] = ["shelly", "homeassistant", "knx", "simulated"];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content dir={dir} className="fixed inset-x-3 top-[5vh] z-50 mx-auto max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900 p-5 shadow-2xl focus:outline-none">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink-50">{t("hub.add.title")}</Dialog.Title>
              <Dialog.Description className="text-xs text-ink-300">{t("hub.add.description")}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("common.close")}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <RTabs.Root value={flow} onValueChange={(v) => setFlow(v as Flow)}>
            <RTabs.List className="mb-4 flex flex-wrap gap-1 rounded-xl bg-ink-850 p-1" aria-label={t("hub.add.source")}>
              {tabs.map((id) => (
                <RTabs.Trigger
                  key={id}
                  value={id}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    flow === id && "bg-ink-700 text-ink-50",
                  )}
                >
                  {t(`hub.add.tabs.${id}`)}
                </RTabs.Trigger>
              ))}
            </RTabs.List>
            <RTabs.Content value="shelly">{flow === "shelly" ? <ShellyFlow onDone={close} /> : null}</RTabs.Content>
            <RTabs.Content value="homeassistant">{flow === "homeassistant" ? <HomeAssistantFlow onDone={close} /> : null}</RTabs.Content>
            <RTabs.Content value="knx">{flow === "knx" ? <KnxFlow onDone={close} /> : null}</RTabs.Content>
            <RTabs.Content value="simulated">{flow === "simulated" ? <SimulatedFlow onDone={close} /> : null}</RTabs.Content>
          </RTabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
