"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  FlaskConical,
  Hand,
  Home,
  KeyRound,
  Loader2,
  Mic,
  Router,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { Dialog, RadioGroup } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Connection } from "home-assistant-js-websocket";
import type { Auth } from "home-assistant-js-websocket";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Checkbox, FieldHint, Input, Label, Slider, Switch } from "@/components/ui/primitives";
import { BridgeAdapter, describeKnxStatus } from "@/lib/adapters/bridge-adapter";
import { connectHomeAssistant, HomeAssistantAdapter, type HaCapabilities } from "@/lib/adapters/ha-adapter";
import { AdapterError, describeError } from "@/lib/adapters/types";
import { BridgeClient } from "@/lib/bridge/client";
import type { Gateway, Health, KnxStatus, SessionInfo } from "@/lib/bridge/contract";
import { gaAllowed } from "@/lib/connection/allowlist";
import { loadBridgeSession, saveBridgeSession, setActiveBackend } from "@/lib/connection/session";
import { beginHaLogin, completeHaLogin, hasHaCallback, loadStoredAuth } from "@/lib/ha/oauth";
import { DPT_INFO, type DptId } from "@/lib/knx/dpt";
import { parseGroupAddress } from "@/lib/knx/group-address";
import { checkEndpointUrl } from "@/lib/net/endpoint";
import { useNow } from "@/lib/device";
import { selectLampView } from "@/lib/state/selectors";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import type { LightTarget } from "@/lib/state/types";
import { useUi } from "@/lib/state/ui-store";
import { cn } from "@/lib/utils";

type Backend = "simulation" | "bridge" | "homeassistant";
type StepId = "mode" | "backend" | "test" | "address" | "status" | "command" | "done";

const STEPS: Array<{ id: StepId; title: string }> = [
  { id: "mode", title: "Mode" },
  { id: "backend", title: "Backend" },
  { id: "test", title: "Test link" },
  { id: "address", title: "Address" },
  { id: "status", title: "Feedback" },
  { id: "command", title: "Test" },
  { id: "done", title: "Control" },
];

interface Check {
  id: string;
  label: string;
  state: "ok" | "fail" | "warn" | "running";
  detail: string;
}

interface HaSnapshot {
  backend: "homeassistant";
  hassUrl: string;
}

const LIGHT_ID = "primary";

function pageProtocol(): string {
  return typeof location !== "undefined" ? location.protocol : "https:";
}

function clientName(): string {
  if (typeof navigator === "undefined") return "SE7ENX web";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `SE7ENX web · ${browser}${os ? ` on ${os}` : ""}`;
}

function normalizeCode(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

/* =========================================================================== */

export function ConnectionWizard() {
  const open = useUi((s) => s.wizardOpen);
  const closeWizard = useUi((s) => s.closeWizard);
  const openWizard = useUi((s) => s.openWizard);
  const setTab = useUi((s) => s.setTab);
  const prefs = useSettings((s) => s.connection);
  const setPrefs = useSettings((s) => s.setConnection);
  const light = useAppStore((s) => s.light);
  const activateAdapter = useAppStore((s) => s.activateAdapter);
  const useSimulation = useAppStore((s) => s.useSimulation);
  const requestCommand = useAppStore((s) => s.requestCommand);

  const [step, setStep] = useState<StepId>("mode");
  const [backend, setBackend] = useState<Backend>("bridge");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message: string; hint?: string } | null>(null);

  // bridge state
  const [bridgeUrl, setBridgeUrl] = useState(prefs.bridgeUrl);
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [override, setOverride] = useState({ enabled: false, connectionType: "tunneling" as "tunneling" | "tunneling_tcp" | "routing", host: "", port: "3671" });
  const [gateways, setGateways] = useState<Gateway[] | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);

  // home assistant state
  const [hassUrl, setHassUrl] = useState(prefs.hassUrl);
  const [haCaps, setHaCaps] = useState<HaCapabilities | null>(null);
  const haRef = useRef<{ conn: Connection; auth: Auth } | null>(null);

  // target
  const [ga, setGa] = useState(prefs.groupAddress);
  const [statusGa, setStatusGa] = useState(prefs.statusAddress);
  const [dpt, setDpt] = useState<DptId>(prefs.dpt);
  const [onLevel, setOnLevel] = useState(prefs.onLevel);

  // results
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [readResult, setReadResult] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [activated, setActivated] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: "ok" | "warn" | "danger"; text: string } | null>(null);

  const bridgeCheck = useMemo(() => checkEndpointUrl(bridgeUrl, { pageProtocol: pageProtocol(), kind: "bridge" }), [bridgeUrl]);
  const haCheck = useMemo(() => checkEndpointUrl(hassUrl, { pageProtocol: pageProtocol(), kind: "homeassistant" }), [hassUrl]);
  const gaParsed = useMemo(() => parseGroupAddress(ga), [ga]);
  const statusParsed = useMemo(() => (statusGa.trim() ? parseGroupAddress(statusGa) : null), [statusGa]);
  const allowPatterns = session?.policy.allowedGroupAddresses ?? null;
  const gaPermitted = backend !== "bridge" || !allowPatterns || (gaParsed.ok && gaAllowed(ga, allowPatterns));
  const statusPermitted = backend !== "bridge" || !allowPatterns || !statusParsed || (statusParsed.ok && gaAllowed(statusGa, allowPatterns));

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const d = describeError(err);
      setError({ title: label.replace(/…$/, "") + " failed", message: d.message, hint: d.hint });
    } finally {
      setBusy(null);
    }
  }, []);

  const resetDownstream = () => {
    setChecks(null);
    setReadResult(null);
    setAck(false);
    setTestResult(null);
  };

  /* --------------------------------------------- Home Assistant OAuth return */
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !hasHaCallback()) return;
    resumedRef.current = true;
    openWizard();
    setBackend("homeassistant");
    setStep("backend");
    void run("Completing Home Assistant sign-in…", async () => {
      const { auth, hassUrl: url } = await completeHaLogin<HaSnapshot>();
      setHassUrl(url);
      setPrefs({ hassUrl: url });
      const { conn, caps } = await connectHomeAssistant(auth);
      haRef.current = { conn, auth };
      setHaCaps(caps);
    });
  }, [openWizard, run, setPrefs]);

  /* -------------------------------------------------------- bridge actions */
  const ensureClient = (): BridgeClient => {
    if (!bridgeCheck.ok || !bridgeCheck.url) throw new AdapterError("INVALID_URL", bridgeCheck.error ?? "Invalid bridge URL");
    if (!clientRef.current || clientRef.current.baseUrl !== bridgeCheck.url) {
      const stored = loadBridgeSession(bridgeCheck.url);
      clientRef.current = new BridgeClient({ baseUrl: bridgeCheck.url, targetAddressSpace: bridgeCheck.targetAddressSpace, token: stored?.token ?? null });
    }
    return clientRef.current;
  };

  const checkBridge = () =>
    run("Contacting bridge…", async () => {
      setHealth(null);
      setSession(null);
      const client = ensureClient();
      const h = await client.health();
      setHealth(h);
      setPrefs({ bridgeUrl: client.baseUrl });
      if (client.hasToken) {
        try {
          setSession(await client.session());
        } catch {
          client.setToken(null);
        }
      }
    });

  const pair = () =>
    run("Pairing…", async () => {
      const client = ensureClient();
      const res = await client.pair(normalizeCode(pairCode), clientName());
      saveBridgeSession({ baseUrl: client.baseUrl, token: res.token, expiresAt: res.expiresAt });
      setPairCode("");
      setSession(await client.session());
    });

  const discover = () =>
    run("Searching for KNX interfaces…", async () => {
      const list = await ensureClient().discover();
      setGateways(list);
    });

  const runBridgeTest = () =>
    run("Testing connectivity…", async () => {
      const client = ensureClient();
      const list: Check[] = [];
      const push = (c: Check) => {
        const i = list.findIndex((x) => x.id === c.id);
        if (i >= 0) list[i] = c;
        else list.push(c);
        setChecks([...list]);
      };
      push({ id: "bridge", label: "Bridge reachable", state: "running", detail: client.baseUrl });
      const h = await client.health();
      push({ id: "bridge", label: "Bridge reachable", state: "ok", detail: `SE7ENX Bridge ${h.version} at ${client.baseUrl}` });
      push({ id: "auth", label: "Paired session valid", state: "running", detail: "" });
      const s = await client.session();
      setSession(s);
      push({ id: "auth", label: "Paired session valid", state: "ok", detail: `${s.session.clientName} · expires ${new Date(s.session.expiresAt).toLocaleString()}` });
      push({ id: "knx", label: "KNX interface connected", state: "running", detail: "Connecting…" });
      let knx: KnxStatus = s.knx;
      if (knx.state !== "connected" || override.enabled) {
        const port = Number(override.port) || 3671;
        knx = await client.connect(
          override.enabled && s.policy.clientGatewayOverride
            ? { connectionType: override.connectionType, ...(override.host ? { host: override.host.trim() } : {}), port }
            : undefined,
        );
      }
      if (knx.state !== "connected") {
        push({ id: "knx", label: "KNX interface connected", state: "fail", detail: knx.lastError?.message ?? `State: ${knx.state}` });
        throw new AdapterError(knx.lastError?.code ?? "KNX_NOT_CONNECTED", knx.lastError?.message ?? "The bridge could not connect to the KNX interface.", {
          hint: "Check SE7ENX_KNX_GATEWAY_IP / connection type on the bridge, that the interface is powered, on the same network, and has a free tunnelling slot.",
        });
      }
      push({ id: "knx", label: "KNX interface connected", state: "ok", detail: describeKnxStatus(knx) });
      const t = await client.test();
      for (const c of t.checks) push({ id: `t-${c.id}`, label: c.label, state: c.ok ? "ok" : "warn", detail: c.detail });
      if (knx.confirmation === "local") {
        push({
          id: "routing",
          label: "Bus confirmation",
          state: "warn",
          detail: "KNX IP routing (multicast) gives no bus-level confirmation. Commands will be reported as sent, not confirmed — use a status address.",
        });
      }
    });

  /* ------------------------------------------------- home assistant actions */
  const haSignIn = () => {
    if (!haCheck.ok || !haCheck.url) return;
    setPrefs({ hassUrl: haCheck.url });
    const stored = loadStoredAuth(haCheck.url);
    if (stored) {
      void run("Connecting to Home Assistant…", async () => {
        const { conn, caps } = await connectHomeAssistant(stored);
        haRef.current?.conn.close();
        haRef.current = { conn, auth: stored };
        setHaCaps(caps);
      });
      return;
    }
    beginHaLogin<HaSnapshot>(haCheck.url, { backend: "homeassistant", hassUrl: haCheck.url });
  };

  const runHaTest = () => {
    const c = haCaps;
    if (!c) return;
    const list: Check[] = [
      { id: "conn", label: "Home Assistant reachable & signed in", state: "ok", detail: `HA ${c.version} · ${c.userName}${c.isAdmin ? " (administrator)" : ""}` },
      {
        id: "knx",
        label: "KNX integration loaded",
        state: c.knxLoaded ? "ok" : "fail",
        detail: c.knxLoaded ? "The KNX integration is set up in Home Assistant." : "Set up the KNX integration in Home Assistant first (Settings → Devices & services).",
      },
      { id: "send", label: "knx.send available", state: c.canSend ? "ok" : "fail", detail: c.canSend ? "Group writes can be sent." : "The knx.send action is missing." },
      {
        id: "read",
        label: "State read-back",
        state: c.readWithResponse ? "ok" : "warn",
        detail: c.readWithResponse
          ? "knx.read returns responses — device state can be read."
          : c.isAdmin
            ? "This HA version cannot return read responses; state will come from live events."
            : "This HA version cannot return read responses and you are not an admin: device state cannot be confirmed.",
      },
      {
        id: "events",
        label: "Live bus events",
        state: c.isAdmin ? "ok" : "warn",
        detail: c.isAdmin ? "Admin: knx_event can be subscribed (bus confirmation & live status)." : "Not an admin: commands are reported as accepted, not bus-confirmed.",
      },
      {
        id: "iface",
        label: "KNX interface link (in HA)",
        state: c.knxConnected === true ? "ok" : c.knxConnected === false ? "fail" : "warn",
        detail:
          c.knxConnected === true
            ? `Connected${c.knxAddress ? ` as ${c.knxAddress}` : ""}.`
            : c.knxConnected === false
              ? "Home Assistant reports its KNX interface as DISCONNECTED."
              : "Not available (requires an admin account / recent HA version).",
      },
    ];
    setChecks(list);
  };

  /* ------------------------------------------------------ target / adapter */
  const target = (): LightTarget | null => {
    if (!gaParsed.ok) return null;
    const st = statusParsed && statusParsed.ok ? statusParsed.value : null;
    return {
      groupAddress: gaParsed.value.canonical,
      displayAddress: gaParsed.value.display,
      statusAddress: st?.canonical ?? null,
      displayStatusAddress: st?.display ?? null,
      dpt,
      onLevel,
    };
  };

  const registerBridgeLight = async () => {
    const client = ensureClient();
    const t = target();
    if (!t) throw new AdapterError("INVALID_GA", "Invalid group address");
    return client.putLight(LIGHT_ID, { switchAddress: t.groupAddress, statusAddress: t.statusAddress, dpt: t.dpt, onLevel: t.onLevel });
  };

  const readState = () =>
    run("Reading state…", async () => {
      setReadResult(null);
      const t = target();
      if (!t) return;
      if (backend === "bridge") {
        await registerBridgeLight();
        const st = await ensureClient().lightState(LIGHT_ID, true);
        setReadResult(
          st.value === "unknown"
            ? { tone: "warn", text: "No answer to the read request. The actuator may not allow reads on this object (read flag). Live status telegrams will still be received." }
            : { tone: "ok", text: `The installation answered: ${st.value.toUpperCase()} (${st.via.replace("_", " ")}).` },
        );
      } else if (haRef.current && haCaps) {
        if (!haCaps.readWithResponse) {
          setReadResult({ tone: "warn", text: "This Home Assistant version cannot return read responses. State will be observed via live events (admin only)." });
          return;
        }
        try {
          const res = await haRef.current.conn.sendMessagePromise<{ response?: { payload?: unknown; value?: unknown } }>({
            type: "call_service",
            domain: "knx",
            service: "read",
            service_data: { address: t.statusAddress ?? t.groupAddress },
            return_response: true,
          });
          setReadResult({ tone: "ok", text: `The installation answered with payload ${JSON.stringify(res?.response?.payload)}.` });
        } catch {
          setReadResult({ tone: "warn", text: "No device answered the read request within 2 s (read flag not set or wrong address)." });
        }
      }
    });

  const activate = () =>
    run("Activating live control…", async () => {
      const t = target();
      if (!t) throw new AdapterError("INVALID_GA", "Invalid group address");
      setPrefs({ groupAddress: ga.trim(), statusAddress: statusGa.trim(), dpt, onLevel });
      if (backend === "bridge") {
        const client = ensureClient();
        const res = await registerBridgeLight();
        const knx = await client.knxStatus();
        const adapter = new BridgeAdapter(client, res.light, knx);
        setActiveBackend({ kind: "bridge", client });
        await activateAdapter(adapter, { target: t });
      } else {
        const h = haRef.current;
        if (!h || !haCaps) throw new AdapterError("HA_NOT_CONNECTED", "Not connected to Home Assistant.");
        const adapter = new HomeAssistantAdapter(h.conn, haCaps, t, haCheck.url ?? hassUrl);
        setActiveBackend({ kind: "homeassistant", auth: h.auth });
        haRef.current = null; // ownership moves to the adapter
        await activateAdapter(adapter, { target: t });
      }
      setActivated(true);
    });

  const sendTest = async (value: "on" | "off") => {
    setTestResult(null);
    const r = await requestCommand(value, "test");
    if (r.status === "done") {
      setTestResult({
        tone: r.phase === "bus_confirmed" ? "ok" : "warn",
        text: `${value.toUpperCase()}: ${r.detail}`,
      });
    } else if (r.status === "blocked") {
      setTestResult({ tone: "warn", text: `Not sent: ${r.reason.replace("_", " ")}.` });
    } else {
      setTestResult({ tone: "danger", text: `${value.toUpperCase()} failed: ${r.message}${r.hint ? ` — ${r.hint}` : ""}` });
    }
  };

  /* ------------------------------------------------------------ navigation */
  const idx = STEPS.findIndex((s) => s.id === step);
  const goto = (id: StepId) => {
    setError(null);
    setStep(id);
  };

  const canNext = (): boolean => {
    if (busy) return false;
    switch (step) {
      case "mode":
        return true;
      case "backend":
        return backend === "bridge" ? !!session : !!haCaps;
      case "test":
        return !!checks && checks.every((c) => c.state === "ok" || c.state === "warn") && checks.length > 0;
      case "address":
        return gaParsed.ok && gaPermitted;
      case "status":
        return (!statusParsed || statusParsed.ok) && statusPermitted;
      case "command":
        return activated;
      default:
        return true;
    }
  };

  const next = async () => {
    if (step === "mode") {
      if (backend === "simulation") {
        await useSimulation();
        closeWizard();
        setStep("mode");
        return;
      }
      goto("backend");
      return;
    }
    if (step === "backend") {
      resetDownstream();
      goto("test");
      if (backend === "homeassistant") setTimeout(runHaTest, 0);
      else void runBridgeTest();
      return;
    }
    if (step === "status") {
      await activate();
      if (useAppStore.getState().light.mode !== "simulation") goto("command");
      return;
    }
    const nextStep = STEPS[idx + 1];
    if (nextStep) goto(nextStep.id);
  };

  const back = () => {
    const prev = STEPS[idx - 1];
    if (prev) goto(prev.id);
  };

  const onOpenChange = (o: boolean) => {
    if (!o) {
      closeWizard();
      if (step === "done") setStep("mode");
    }
  };

  // clean up an HA connection that never got activated
  useEffect(
    () => () => {
      haRef.current?.conn.close();
    },
    [],
  );

  /* ================================================================ render */
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[94dvh] flex-col rounded-t-3xl border border-ink-600 bg-ink-850 shadow-2xl focus:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[min(760px,94vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl"
          aria-describedby="wizard-desc"
        >
          <div className="flex items-start justify-between gap-3 border-b border-ink-700 px-5 pb-3 pt-5">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink-50">Connect a KNX light</Dialog.Title>
              <Dialog.Description id="wizard-desc" className="mt-0.5 text-xs text-ink-300">
                Step {idx + 1} of {STEPS.length} · {STEPS[idx]?.title}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          <ol className="flex gap-1 px-5 pt-3" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex-1">
                <div className={cn("h-1 rounded-full", i < idx ? "bg-accent" : i === idx ? "bg-accent/70" : "bg-ink-600")} />
                <span className={cn("mt-1 hidden text-[10px] font-medium uppercase tracking-wider sm:block", i === idx ? "text-accent" : "text-ink-400")}>
                  {s.title}
                </span>
              </li>
            ))}
          </ol>

          <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {step === "mode" ? <ModeStep backend={backend} setBackend={setBackend} /> : null}

            {step === "backend" && backend === "bridge" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bridge-url">Bridge URL</Label>
                  <Input
                    id="bridge-url"
                    value={bridgeUrl}
                    onChange={(e) => {
                      setBridgeUrl(e.target.value);
                      setHealth(null);
                      setSession(null);
                    }}
                    placeholder="http://127.0.0.1:8787 or https://bridge.your-tailnet.ts.net"
                    invalid={!bridgeCheck.ok && bridgeUrl.length > 0}
                    aria-describedby="bridge-url-hint"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                  />
                  <FieldHint id="bridge-url-hint" tone={bridgeCheck.ok ? "muted" : "error"}>
                    {bridgeCheck.ok ? "The address where the SE7ENX Bridge is reachable from THIS device." : bridgeCheck.error}
                  </FieldHint>
                  {bridgeCheck.warnings.map((w) => (
                    <FieldHint key={w}>⚠ {w}</FieldHint>
                  ))}
                  <Button variant="secondary" onClick={checkBridge} disabled={!bridgeCheck.ok || !!busy}>
                    <Router className="h-4 w-4" aria-hidden />
                    Check bridge
                  </Button>
                </div>

                {health ? (
                  <Callout tone="ok" icon={<CircleCheck className="h-4 w-4" />} title={`SE7ENX Bridge ${health.version} found`}>
                    API v{health.apiVersion}. {session ? "This browser is paired." : "Pair this browser with the code printed in the bridge console."}
                  </Callout>
                ) : null}

                {health && !session ? (
                  <div className="space-y-2">
                    <Label htmlFor="pair-code">Pairing code</Label>
                    <div className="flex gap-2">
                      <Input
                        id="pair-code"
                        value={pairCode}
                        onChange={(e) => setPairCode(e.target.value)}
                        placeholder="XXXX-XXXX"
                        className="font-mono uppercase tracking-[0.3em]"
                        autoComplete="one-time-code"
                        spellCheck={false}
                        aria-describedby="pair-hint"
                      />
                      <Button variant="primary" onClick={pair} disabled={normalizeCode(pairCode).length < 8 || !!busy}>
                        <KeyRound className="h-4 w-4" aria-hidden />
                        Pair
                      </Button>
                    </div>
                    <FieldHint id="pair-hint">
                      Shown when the bridge starts (and after each successful pairing). The resulting session token is kept only in this browser tab and expires automatically.
                    </FieldHint>
                  </div>
                ) : null}

                {session ? (
                  <div className="space-y-3 rounded-2xl border border-ink-700 bg-ink-900/60 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-50">KNX interface</p>
                      <Badge tone={session.knx.state === "connected" ? "ok" : session.knx.state === "error" ? "danger" : "neutral"} dot>
                        {session.knx.state}
                      </Badge>
                    </div>
                    <p className="text-sm text-ink-200">
                      Configured on the bridge: <span className="font-mono">{describeKnxStatus(session.knx)}</span>
                    </p>
                    {session.policy.clientGatewayOverride ? (
                      <div className="space-y-3">
                        <Switch
                          id="override"
                          checked={override.enabled}
                          onCheckedChange={(v) => setOverride({ ...override, enabled: v })}
                          label="Choose the KNX interface from here"
                          description="Allowed by this bridge for private network addresses only."
                        />
                        {override.enabled ? (
                          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_0.6fr]">
                            <div className="space-y-1.5">
                              <Label htmlFor="ov-type">Type</Label>
                              <select
                                id="ov-type"
                                className="h-11 w-full rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm"
                                value={override.connectionType}
                                onChange={(e) => setOverride({ ...override, connectionType: e.target.value as typeof override.connectionType })}
                              >
                                <option value="tunneling">Tunnelling (UDP)</option>
                                <option value="tunneling_tcp">Tunnelling (TCP)</option>
                                <option value="routing">Routing (multicast)</option>
                              </select>
                            </div>
                            {override.connectionType !== "routing" ? (
                              <>
                                <div className="space-y-1.5">
                                  <Label htmlFor="ov-host">Interface IP</Label>
                                  <Input id="ov-host" value={override.host} onChange={(e) => setOverride({ ...override, host: e.target.value })} placeholder="192.168.1.20" inputMode="decimal" />
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor="ov-port">Port</Label>
                                  <Input id="ov-port" value={override.port} onChange={(e) => setOverride({ ...override, port: e.target.value.replace(/\D/g, "").slice(0, 5) })} inputMode="numeric" />
                                </div>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                        {override.enabled && session.policy.discovery ? (
                          <div className="space-y-2">
                            <Button size="sm" variant="outline" onClick={discover} disabled={!!busy}>
                              <Search className="h-3.5 w-3.5" aria-hidden />
                              Discover interfaces
                            </Button>
                            {gateways ? (
                              gateways.length === 0 ? (
                                <FieldHint>No KNXnet/IP interfaces answered the search (multicast may be blocked on this network).</FieldHint>
                              ) : (
                                <ul className="space-y-1.5">
                                  {gateways.map((g) => (
                                    <li key={`${g.host}:${g.port}`}>
                                      <button
                                        type="button"
                                        className="w-full rounded-xl border border-ink-600 px-3 py-2 text-left text-sm hover:border-accent/60"
                                        onClick={() =>
                                          setOverride({
                                            enabled: true,
                                            connectionType: g.supportsTunnellingTcp ? "tunneling_tcp" : g.supportsTunnelling ? "tunneling" : "routing",
                                            host: g.host,
                                            port: String(g.port),
                                          })
                                        }
                                      >
                                        <span className="font-medium text-ink-50">{g.name}</span>{" "}
                                        <span className="font-mono text-xs text-ink-300">
                                          {g.host}:{g.port} · {g.individualAddress ?? "?"}
                                        </span>
                                        <span className="block text-xs text-ink-400">
                                          {[g.supportsTunnellingTcp && "TCP tunnelling", g.supportsTunnelling && "UDP tunnelling", g.supportsRouting && "routing", g.requiresSecure && "KNX Secure (configure keys on bridge)"]
                                            .filter(Boolean)
                                            .join(" · ")}
                                        </span>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <FieldHint>Gateway settings are fixed in the bridge configuration (SE7ENX_KNX_* environment variables) — nothing to enter here.</FieldHint>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}

            {step === "backend" && backend === "homeassistant" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ha-url">Home Assistant URL</Label>
                  <Input
                    id="ha-url"
                    value={hassUrl}
                    onChange={(e) => {
                      setHassUrl(e.target.value);
                      setHaCaps(null);
                    }}
                    placeholder="https://home.example.com"
                    invalid={!haCheck.ok && hassUrl.length > 0}
                    aria-describedby="ha-url-hint"
                    inputMode="url"
                    spellCheck={false}
                  />
                  <FieldHint id="ha-url-hint" tone={haCheck.ok || !hassUrl ? "muted" : "error"}>
                    {haCheck.ok || !hassUrl ? "Must be reachable over HTTPS from this device (e.g. your Nabu Casa or own-domain URL)." : haCheck.error}
                  </FieldHint>
                  {haCheck.warnings.map((w) => (
                    <FieldHint key={w}>⚠ {w}</FieldHint>
                  ))}
                </div>
                {haCaps ? (
                  <Callout tone="ok" icon={<CircleCheck className="h-4 w-4" />} title={`Signed in to Home Assistant ${haCaps.version}`}>
                    As {haCaps.userName}
                    {haCaps.isAdmin ? " (administrator)" : " (non-admin: commands work, live bus events are unavailable)"}.
                  </Callout>
                ) : (
                  <>
                    <Callout tone="accent" icon={<KeyRound className="h-4 w-4" />} title="Sign in on your own Home Assistant">
                      You will be redirected to your Home Assistant login page and back. SE7ENX never sees your password and does not ask for a long-lived
                      token; the short-lived session stays in this browser tab only and is revoked when you disconnect.
                    </Callout>
                    <Button variant="primary" onClick={haSignIn} disabled={!haCheck.ok || !!busy}>
                      <Home className="h-4 w-4" aria-hidden />
                      Sign in with Home Assistant
                    </Button>
                  </>
                )}
              </div>
            ) : null}

            {step === "test" ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-300">
                  These checks verify the path to your KNX installation. <strong className="text-ink-100">No telegrams are written to the bus.</strong>
                </p>
                <CheckList checks={checks} />
                <Button variant="secondary" size="sm" onClick={() => (backend === "bridge" ? void runBridgeTest() : runHaTest())} disabled={!!busy}>
                  Run again
                </Button>
              </div>
            ) : null}

            {step === "address" ? (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="ga">Light group address (switching)</Label>
                  <Input
                    id="ga"
                    value={ga}
                    onChange={(e) => {
                      setGa(e.target.value);
                      setReadResult(null);
                    }}
                    placeholder="0/0/1"
                    className="font-mono text-base"
                    invalid={!gaParsed.ok || !gaPermitted}
                    aria-describedby="ga-hint"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldHint id="ga-hint" tone={!gaParsed.ok || !gaPermitted ? "error" : "ok"}>
                    {!gaParsed.ok
                      ? gaParsed.error.message
                      : !gaPermitted
                        ? `This bridge does not permit ${gaParsed.value.display}. Allowed: ${allowPatterns?.join(", ")}. Ask the installer to extend SE7ENX_ALLOWED_GROUP_ADDRESSES.`
                        : `Valid ${gaParsed.value.style} address${gaParsed.value.style !== "three-level" ? ` (= ${gaParsed.value.canonical})` : ""}.`}
                  </FieldHint>
                  <FieldHint>
                    A valid format does not prove that this address exists in your installation or that it switches a light. Use the test command
                    (step 6) to verify.
                  </FieldHint>
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-300">Datapoint type</legend>
                  <RadioGroup.Root value={dpt} onValueChange={(v) => setDpt(v as DptId)} className="grid gap-2 sm:grid-cols-2">
                    {(Object.keys(DPT_INFO) as DptId[]).map((id) => (
                      <RadioGroup.Item
                        key={id}
                        value={id}
                        className="rounded-xl border border-ink-600 p-3 text-left data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/[0.06]"
                      >
                        <span className="block text-sm font-semibold text-ink-50">{DPT_INFO[id].name}</span>
                        <span className="mt-0.5 block text-xs text-ink-300">{DPT_INFO[id].description}</span>
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                </fieldset>
                {dpt === "5.001" ? (
                  <Slider id="on-level" label="Brightness for ON" value={onLevel} min={1} max={100} step={1} format={(v) => `${v}%`} onChange={setOnLevel} />
                ) : null}
              </div>
            ) : null}

            {step === "status" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="status-ga">Status / feedback group address (optional, recommended)</Label>
                  <Input
                    id="status-ga"
                    value={statusGa}
                    onChange={(e) => {
                      setStatusGa(e.target.value);
                      setReadResult(null);
                    }}
                    placeholder="e.g. 0/0/2"
                    className="font-mono text-base"
                    invalid={(statusParsed !== null && !statusParsed.ok) || !statusPermitted}
                    aria-describedby="status-hint"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldHint id="status-hint" tone={statusParsed && !statusParsed.ok ? "error" : !statusPermitted ? "error" : "muted"}>
                    {statusParsed && !statusParsed.ok
                      ? statusParsed.error.message
                      : !statusPermitted
                        ? "This bridge does not permit reading this address."
                        : "The actuator's “status on/off” object. With it, SE7ENX shows the CONFIRMED device state; without it, the lamp can only show the commanded state as unverified."}
                  </FieldHint>
                  {statusParsed?.ok && gaParsed.ok && statusParsed.value.raw === gaParsed.value.raw ? (
                    <FieldHint>⚠ Same as the switching address — only useful if the actuator sends feedback on it.</FieldHint>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Button variant="secondary" onClick={readState} disabled={!!busy || (statusParsed !== null && !statusParsed.ok) || !statusPermitted || !gaParsed.ok}>
                    Read current state (GroupValueRead)
                  </Button>
                  <FieldHint>Reading does not switch anything. It asks the actuator to report its current state.</FieldHint>
                  {readResult ? (
                    <Callout tone={readResult.tone} icon={readResult.tone === "ok" ? <CircleCheck className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}>
                      {readResult.text}
                    </Callout>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === "command" ? (
              <CommandStep ack={ack} setAck={setAck} onSend={sendTest} result={testResult} gaLabel={gaParsed.ok ? gaParsed.value.display : ga} light={light} />
            ) : null}

            {step === "done" ? (
              <div className="space-y-4">
                <Callout tone="ok" icon={<CircleCheck className="h-4 w-4" />} title="Live KNX control is active">
                  The lamp now reflects your real light. Manual controls are always available; gesture and voice control start only when you enable them.
                </Callout>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => {
                      setTab("gesture");
                      closeWizard();
                      setStep("mode");
                    }}
                  >
                    <Hand className="h-5 w-5" aria-hidden />
                    Set up gestures
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => {
                      setTab("voice");
                      closeWizard();
                      setStep("mode");
                    }}
                  >
                    <Mic className="h-5 w-5" aria-hidden />
                    Set up voice
                  </Button>
                </div>
                <FieldHint>Tip: “Stop hands-free” in the header (or the Esc key) immediately blocks gesture and voice commands.</FieldHint>
              </div>
            ) : null}

            {busy ? (
              <p className="flex items-center gap-2 text-sm text-accent" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {busy}
              </p>
            ) : null}
            {error ? (
              <Callout tone="danger" role="alert" icon={<CircleX className="h-4 w-4" />} title={error.title}>
                <p>{error.message}</p>
                {error.hint ? <p className="mt-1 text-ink-300">{error.hint}</p> : null}
              </Callout>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-ink-700 px-5 py-4">
            <Button variant="ghost" onClick={back} disabled={idx === 0 || !!busy || step === "done" || (step === "command" && activated)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Button>
            <div className="flex gap-2">
              {step === "command" ? (
                <Button variant="ghost" onClick={() => goto("done")} disabled={!activated}>
                  Skip test
                </Button>
              ) : null}
              {step === "done" ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    closeWizard();
                    setStep("mode");
                  }}
                >
                  <Check className="h-4 w-4" aria-hidden />
                  Done
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void next()} disabled={!canNext()} data-testid="wizard-next">
                  {step === "mode" && backend === "simulation" ? "Use simulation" : step === "status" ? "Activate live control" : "Next"}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* =========================================================================== */

function ModeStep({ backend, setBackend }: { backend: Backend; setBackend: (b: Backend) => void }) {
  const options: Array<{ id: Backend; icon: ReactNode; title: string; text: string; needs: string[] }> = [
    {
      id: "simulation",
      icon: <FlaskConical className="h-5 w-5" />,
      title: "Simulation",
      text: "Explore gestures, voice and the lamp without any hardware. Nothing on your network is contacted.",
      needs: ["No requirements"],
    },
    {
      id: "homeassistant",
      icon: <Home className="h-5 w-5" />,
      title: "Home Assistant",
      text: "Use your existing Home Assistant KNX integration. You sign in with your Home Assistant account.",
      needs: ["Home Assistant with the KNX integration configured", "HA reachable over HTTPS from this device", "Admin account recommended for live feedback"],
    },
    {
      id: "bridge",
      icon: <Router className="h-5 w-5" />,
      title: "Local KNX Bridge",
      text: "Run the SE7ENX Bridge (Python, xknx) next to your KNX IP interface or router. Best latency and true bus confirmation.",
      needs: ["KNXnet/IP interface or router on your LAN", "SE7ENX Bridge running on a PC / Raspberry Pi in the same network", "This device can reach the bridge (LAN, Tailscale or HTTPS)"],
    },
  ];
  return (
    <RadioGroup.Root value={backend} onValueChange={(v) => setBackend(v as Backend)} className="grid gap-3" aria-label="Connection method">
      {options.map((o) => (
        <RadioGroup.Item
          key={o.id}
          value={o.id}
          data-testid={`mode-${o.id}`}
          className="group rounded-2xl border border-ink-600 bg-ink-900/50 p-4 text-left transition-colors hover:border-ink-400 data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/[0.05]"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-700 text-accent">{o.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink-50">{o.title}</span>
                <span className="grid h-5 w-5 place-items-center rounded-full border border-ink-400 group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent">
                  <Check className="hidden h-3 w-3 text-ink-950 group-data-[state=checked]:block" strokeWidth={3} />
                </span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-300">{o.text}</span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                {o.needs.map((n) => (
                  <span key={n} className="rounded-md bg-ink-750 px-2 py-0.5 text-[11px] text-ink-200">
                    {n}
                  </span>
                ))}
              </span>
            </span>
          </div>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

function CheckList({ checks }: { checks: Check[] | null }) {
  if (!checks) return <p className="text-sm text-ink-400">Running…</p>;
  return (
    <ul className="space-y-2" data-testid="checks">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-3 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2.5">
          <span className="mt-0.5 shrink-0">
            {c.state === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin text-accent" aria-label="running" />
            ) : c.state === "ok" ? (
              <CircleCheck className="h-4 w-4 text-ok" aria-label="passed" />
            ) : c.state === "warn" ? (
              <TriangleAlert className="h-4 w-4 text-warn" aria-label="warning" />
            ) : (
              <CircleX className="h-4 w-4 text-danger" aria-label="failed" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink-50">{c.label}</span>
            {c.detail ? <span className="block break-words text-xs text-ink-300">{c.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CommandStep({
  ack,
  setAck,
  onSend,
  result,
  gaLabel,
  light,
}: {
  ack: boolean;
  setAck: (v: boolean) => void;
  onSend: (v: "on" | "off") => Promise<void>;
  result: { tone: "ok" | "warn" | "danger"; text: string } | null;
  gaLabel: string;
  light: ReturnType<typeof useAppStore.getState>["light"];
}) {
  const now = useNow(500);
  const view = selectLampView(light, now);
  const pending = light.lastCommand?.phase === "pending";
  return (
    <div className="space-y-4">
      <Callout tone="danger" icon={<TriangleAlert className="h-4 w-4" />} title="This operates real equipment">
        A test command writes to group address <span className="font-mono">{gaLabel}</span> on your KNX bus. Whatever is linked to it — a light, a socket,
        a blind or another load — may switch. Only continue if that is safe right now.
      </Callout>
      <Checkbox id="ack" checked={ack} onCheckedChange={setAck}>
        I understand that this switches real equipment and it is safe to do so now.
      </Checkbox>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="on" size="lg" disabled={!ack || pending} onClick={() => void onSend("on")} data-testid="test-on">
          Send test ON
        </Button>
        <Button variant="off" size="lg" disabled={!ack || pending} onClick={() => void onSend("off")} data-testid="test-off">
          Send test OFF
        </Button>
      </div>
      {result ? (
        <Callout tone={result.tone} role="status">
          {result.text}
        </Callout>
      ) : null}
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Lamp state</p>
        <p className="mt-0.5 font-mono text-sm font-semibold text-ink-50">{view.label}</p>
        <p className="text-xs text-ink-300">{view.detail}</p>
      </div>
    </div>
  );
}
