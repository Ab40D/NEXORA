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
import { cn } from "@/lib/utils";

type Flow = "shelly" | "homeassistant" | "knx" | "simulated";

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
      <p className="text-xs text-ink-300">Enter the local IP address of ONE Shelly device. SE7ENX does not scan your network.</p>
      <Field id="sh-host" label="Device IP address" hint="e.g. 192.168.1.40, shown in the Shelly app or your router">
        <Input id="sh-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.40" autoComplete="off" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sh-user" label="Username (Gen1 only)" hint="Gen2+ always uses 'admin'">
          <Input id="sh-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="sh-pass" label="Password (if enabled)" hint="Stored on the hub only, never shown again">
          <Input id="sh-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void identify()} disabled={busy || !host.trim()}>
        <Search className="h-3.5 w-3.5" aria-hidden /> Identify device
      </Button>
      <ErrorLine error={error} />
      {ident ? (
        <div className="space-y-3 rounded-xl border border-ink-600 p-3">
          <p className="text-sm text-ink-100">
            {ident.model} · Gen{ident.gen} · firmware {ident.firmware ?? "?"} {ident.authRequired ? <Badge tone="warn">password protected</Badge> : null}
          </p>
          {ident.channels.length === 0 ? <p className="text-xs text-warn">No controllable channel found on this device.</p> : null}
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-ink-200">Channel</legend>
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
                    {c.capabilities.join(", ")} · {describeReported(c.suggestedType, c.state).join(" · ") || "no state"}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {ident.unsupportedComponents.length ? (
            <p className="text-xs text-ink-400">Not supported yet: {ident.unsupportedComponents.join(", ")}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sh-name" label="Name">
              <Input id="sh-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </Field>
            <Field id="sh-type" label="Device type">
              <select id="sh-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button variant="primary" size="sm" disabled={busy || !selected || !name.trim()} onClick={() => void submit()}>
            Add device (control stays disabled)
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Home Assistant */

function HomeAssistantFlow({ onDone }: { onDone: () => void }) {
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
    return entities.filter((e) => !f || e.entityId.includes(f) || e.name.toLowerCase().includes(f)).slice(0, 200);
  }, [entities, filter]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">
        SE7ENX connects to Home Assistant from the hub. The access token is stored on the hub only and is never sent to this browser.
      </p>
      {cfg ? (
        <p className="text-xs text-ink-300">
          Status: <span className={connected ? "text-ok" : "text-warn"}>{cfg.status.state}</span> · {cfg.status.detail}
          {cfg.status.lastError ? <span className="block text-danger">{cfg.status.lastError.message}</span> : null}
        </p>
      ) : null}
      {cfg?.config.readOnly ? (
        <Callout tone="neutral">Configured through environment variables on the hub (read-only here).</Callout>
      ) : (
        <>
          <Field id="ha-url" label="Home Assistant URL" hint="An address the hub can reach, e.g. http://192.168.1.20:8123">
            <Input id="ha-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://homeassistant.local:8123" autoComplete="off" />
          </Field>
          <Field
            id="ha-token"
            label={cfg?.config.tokenStored ? "Long-lived access token (stored: leave empty to keep)" : "Long-lived access token"}
            hint="Home Assistant → your profile → Security → Long-lived access tokens. Prefer a dedicated non-admin user."
          >
            <Input id="ha-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
          </Field>
          <Switch id="ha-tls" checked={verifyTls} onCheckedChange={setVerifyTls} label="Verify TLS certificate" description="Turn off only for a self-signed certificate on your LAN." />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !url.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await hubClient().testHomeAssistant(url.trim(), token || undefined, verifyTls);
                  setNote(`Connection OK: ${r.locationName ?? "Home Assistant"} ${r.version ?? ""}`);
                })
              }
            >
              Test connection
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !url.trim() || (!token && !cfg?.config.tokenStored)}
              onClick={() =>
                void run(async () => {
                  setCfg(await hubClient().configureHomeAssistant(url.trim(), token || undefined, verifyTls));
                  setToken("");
                  setNote("Saved. Connecting…");
                  for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    const c = await hubClient().homeAssistant();
                    setCfg(c);
                    if (c.status.state === "connected") {
                      setEntities(await hubClient().homeAssistantEntities());
                      setNote("Connected.");
                      return;
                    }
                    if (c.status.state === "auth_failed") return;
                  }
                })
              }
            >
              Save &amp; connect
            </Button>
          </div>
        </>
      )}
      {note ? <p className="text-xs text-ok">{note}</p> : null}
      <ErrorLine error={error} />
      {connected ? (
        <div className="space-y-2">
          <Input aria-label="Filter entities" placeholder="Filter entities…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto pr-1">
            {shown.map((e) => (
              <li key={e.entityId} className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 px-2 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className="text-ink-100">{e.name}</span> <span className="font-mono text-ink-400">{e.entityId}</span>
                  <span className="text-ink-400"> · {e.state}</span>
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
                  {e.added ? "Added" : "Add"}
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ KNX */

const KNX_FIELDS: Record<DeviceType, { key: string; label: string; hint: string; required?: boolean }[]> = {
  switch: [
    { key: "switch", label: "Switch (DPT 1.001)", hint: "e.g. 1/1/1", required: true },
    { key: "switchStatus", label: "Switch status (DPT 1.001)", hint: "feedback, recommended" },
  ],
  outlet: [
    { key: "switch", label: "Switch (DPT 1.001)", hint: "e.g. 1/1/1", required: true },
    { key: "switchStatus", label: "Switch status (DPT 1.001)", hint: "feedback, recommended" },
  ],
  light: [
    { key: "switch", label: "Switch (DPT 1.001)", hint: "on/off" },
    { key: "switchStatus", label: "Switch status (DPT 1.001)", hint: "feedback" },
    { key: "brightness", label: "Brightness, absolute (DPT 5.001)", hint: "0–100 %" },
    { key: "brightnessStatus", label: "Brightness status (DPT 5.001)", hint: "feedback" },
    { key: "dim", label: "Relative dimming (DPT 3.007)", hint: "start/stop dimming" },
  ],
  cover: [
    { key: "upDown", label: "Up/Down (DPT 1.008)", hint: "0 = up/open, 1 = down/close" },
    { key: "stop", label: "Stop", hint: "trigger, writes 1" },
    { key: "position", label: "Position (DPT 5.001)", hint: "KNX 0 % = open (inverted by default)" },
    { key: "positionStatus", label: "Position status (DPT 5.001)", hint: "feedback" },
  ],
  sensor: [
    { key: "value", label: "Value group address", hint: "e.g. 3/1/1", required: true },
    { key: "valueDpt", label: "Datapoint type", hint: "e.g. 9.001 (temperature), 9.007, 9.004, 14.056", required: true },
    { key: "unit", label: "Unit (optional)", hint: "e.g. °C" },
  ],
};

function KnxFlow({ onDone }: { onDone: () => void }) {
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
        KNX interface: <span className={knx?.state === "connected" ? "text-ok" : "text-warn"}>{knx?.state ?? "unknown"}</span>
        {knx?.detail ? ` · ${knx.detail}` : ""}. Only the group addresses you enter here will ever be written for this device.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="knx-name" label="Name">
          <Input id="knx-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field id="knx-type" label="Device type">
          <select id="knx-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
            {(["light", "switch", "outlet", "cover", "sensor"] as DeviceType[]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {KNX_FIELDS[type].map((f) => (
          <Field key={f.key} id={`knx-${f.key}`} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>
            <Input id={`knx-${f.key}`} value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} autoComplete="off" />
          </Field>
        ))}
      </div>
      <ErrorLine error={error} />
      <Button variant="primary" size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
        Add KNX device (control stays disabled)
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ simulated */

function SimulatedFlow({ onDone }: { onDone: () => void }) {
  const add = useHub((s) => s.add);
  const ids = useExistingIds();
  const [type, setType] = useState<DeviceType>("light");
  const [name, setName] = useState("Demo light (simulated)");
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-300">Simulated devices never touch hardware. Useful for demos and trying the interface.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="sim-name" label="Name">
          <Input id="sim-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field id="sim-type" label="Device type">
          <select id="sim-type" className="h-10 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
            {(["light", "switch", "outlet", "cover", "sensor"] as DeviceType[]).map((t) => (
              <option key={t} value={t}>
                {t}
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
        Add simulated device
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function AddDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [flow, setFlow] = useState<Flow>("shelly");
  const close = () => onOpenChange(false);
  const tabs: { id: Flow; label: string }[] = [
    { id: "shelly", label: "Shelly" },
    { id: "homeassistant", label: "Home Assistant" },
    { id: "knx", label: "KNX" },
    { id: "simulated", label: "Simulated" },
  ];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-3 top-[5vh] z-50 mx-auto max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900 p-5 shadow-2xl focus:outline-none">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink-50">Add a device</Dialog.Title>
              <Dialog.Description className="text-xs text-ink-300">
                Manual setup only, no network scanning. Real devices start read-only until you enable control.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <RTabs.Root value={flow} onValueChange={(v) => setFlow(v as Flow)}>
            <RTabs.List className="mb-4 flex flex-wrap gap-1 rounded-xl bg-ink-850 p-1" aria-label="Device source">
              {tabs.map((t) => (
                <RTabs.Trigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium text-ink-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    flow === t.id && "bg-ink-700 text-ink-50",
                  )}
                >
                  {t.label}
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
