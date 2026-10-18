"use client";

import { Activity, Camera, CameraOff, Copy, Crosshair, Hand, RotateCcw, Save, ShieldCheck, SwitchCamera, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SecureContextHelp } from "@/components/security/secure-context-help";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Slider, Switch } from "@/components/ui/primitives";
import { roomLabel, useBuilding } from "@/lib/core/building-store";
import { useTarget } from "@/lib/experience/store";
import { collectEnvReport, type EnvReport } from "@/lib/gesture/diagnostics";
import { MIN_THRESHOLD_GAP } from "@/lib/gesture/gesture-engine";
import { cancelCalibration, startCalibration, startCamera, stopCamera, useGestureStore } from "@/lib/gesture/gesture-store";
import {
  allProfiles,
  GESTURE_ACTIONS,
  GESTURE_IDS,
  useActiveProfile,
  useGestureProfiles,
  usesHeight,
  type GestureAction,
  type GestureProfile,
  type GestureTarget,
} from "@/lib/gesture/profiles";
import { useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";

const CAMERA_ERROR_CODES = new Set([
  "unsupported",
  "insecure",
  "ended",
  "NotAllowedError",
  "SecurityError",
  "NotFoundError",
  "OverconstrainedError",
  "NotReadableError",
  "AbortError",
]);

const selectCls =
  "h-9 w-full rounded-lg border border-ink-600 bg-ink-900 px-2 text-sm text-ink-100 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60";

export function GesturePanel() {
  const { t, pct: fmtPct } = useT();
  const camera = useGestureStore((s) => s.cameraStatus);
  const error = useGestureStore((s) => s.error);
  const pose = useGestureStore((s) => s.pose);
  const update = useGestureStore((s) => s.update);
  const enabled = useGestureStore((s) => s.gesturesEnabled);
  const lastTrigger = useGestureStore((s) => s.lastTrigger);
  const calibration = useGestureStore((s) => s.calibration);
  const setG = useGestureStore((s) => s.set);
  const g = useSettings((s) => s.gesture);
  const setGesture = useSettings((s) => s.setGesture);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const legacySim = useAppStore((s) => s.light.mode === "simulation");
  const target = useTarget();
  const profile = useActiveProfile();
  const heightMode = usesHeight(profile);
  const isSim = target ? target.simulated : legacySim;

  const cameraOn = camera === "starting" || camera === "loading-model" || camera === "running";
  const calibrating = !["idle", "done", "failed"].includes(calibration.phase);
  const errorText = error
    ? CAMERA_ERROR_CODES.has(error.code)
      ? t(`gesture.cameraError.${error.code}` as MessageKey)
      : error.code === "model"
        ? error.message
        : t("gesture.cameraError.generic", { code: error.code })
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Hand className="h-4 w-4" />}
          title={t("gesture.title")}
          subtitle={t("gesture.subtitle2")}
          actions={
            cameraOn ? (
              <Badge tone={camera === "running" ? "ok" : "accent"} dot>
                {camera === "running" ? t("gesture.cameraOn") : t("gesture.starting")}
              </Badge>
            ) : null
          }
        />
        <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <div className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs leading-relaxed text-ink-300">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
            <p>{t("gesture.privacy")}</p>
          </div>

          <SecureContextHelp feature="camera" />

          <details className="rounded-xl border border-ink-700 p-3 text-xs text-ink-300" data-testid="gesture-tutorial">
            <summary className="cursor-pointer select-none font-medium text-ink-100">{t("gesture.tutorial.title")}</summary>
            <ol className="mt-2 list-decimal space-y-1 ps-5">
              <li>{t("gesture.tutorial2.step1")}</li>
              <li>{t("gesture.tutorial2.step2")}</li>
              <li>{t("gesture.tutorial2.step3")}</li>
              <li>{t("gesture.tutorial2.step4")}</li>
            </ol>
          </details>

          <div className="flex flex-wrap gap-2">
            {!cameraOn ? (
              <Button variant="primary" onClick={() => void startCamera(g.facing)} disabled={camera === "requesting"} data-testid="enable-camera">
                <Camera className="h-4 w-4" aria-hidden />
                {camera === "requesting" ? t("gesture.waiting") : t("gesture.enable")}
              </Button>
            ) : (
              <Button variant="secondary" onClick={stopCamera}>
                <CameraOff className="h-4 w-4" aria-hidden />
                {t("gesture.turnOff")}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                const facing = g.facing === "user" ? "environment" : "user";
                setGesture({ facing });
                if (cameraOn) {
                  stopCamera();
                  void startCamera(facing);
                }
              }}
              title={t("gesture.diag.facing")}
            >
              <SwitchCamera className="h-4 w-4" aria-hidden />
              {g.facing === "user" ? t("gesture.diag.front") : t("gesture.diag.back")}
            </Button>
            {heightMode ? (
              <Button variant="outline" onClick={startCalibration} disabled={camera !== "running" || calibrating}>
                <Crosshair className="h-4 w-4" aria-hidden />
                {t("gesture.calibrate")}
              </Button>
            ) : null}
          </div>

          {errorText ? (
            <Callout tone="danger" role="alert" title={t("gesture.unavailable")}>
              {errorText}
              <span className="mt-1 block text-ink-300">{t("gesture.keepWorking")}</span>
            </Callout>
          ) : null}

          <Switch
            id="gestures-enabled"
            checked={enabled}
            onCheckedChange={(v) => setG({ gesturesEnabled: v })}
            label={t("gesture.send")}
            description={paused ? t("gesture.blocked") : isSim ? t("gesture.sendsSim") : t("gesture.sendsReal")}
          />

          {camera === "running" ? (
            <div className="grid gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm sm:grid-cols-2" aria-live="polite">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("gesture.tracking")}</p>
                {heightMode ? (
                  <p className="mt-0.5 text-ink-100">{update ? t(`gesture.status.${update.status}`) : t("gesture.showHand")}</p>
                ) : (
                  <p className="mt-0.5 text-ink-100" data-testid="gesture-pose">
                    {pose?.pose ? t(`gesture.pose.${pose.pose}`) : "—"} · {pose ? t(`gesture.rstatus.${pose.status}`) : t("gesture.showHand")}
                  </p>
                )}
                {pose?.issue ? <p className="text-xs text-warn">{t(`gesture.issue.${pose.issue}`)}</p> : null}
                {pose && pose.status === "holding" ? (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700" aria-hidden>
                    <div className="h-full bg-ink-50 transition-[width]" style={{ width: `${Math.round(pose.progress * 100)}%` }} />
                  </div>
                ) : null}
                <p className="mt-1 font-mono text-[11px] text-ink-400">
                  {t("gesture.diag.confidence")}: {pose?.poseConfidence ? fmtPct(pose.poseConfidence * 100) : "—"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("gesture.lastGesture")}</p>
                {lastTrigger ? (
                  <p className={cn("mt-0.5", lastTrigger.ok ? "text-ok" : "text-warn")} data-testid="gesture-last">
                    {t(`gesture.pose.${lastTrigger.gesture}`)} → {t(`gesture.action.${lastTrigger.action}`)} — {lastTrigger.message}
                  </p>
                ) : (
                  <p className="mt-0.5 text-ink-400">{t("gesture.noneYet")}</p>
                )}
              </div>
            </div>
          ) : null}

          {heightMode && calibration.phase !== "idle" ? (
            <Callout
              tone={calibration.phase === "failed" ? "danger" : calibration.phase === "done" ? "ok" : "accent"}
              title={calibration.phase === "done" ? t("gesture.calDone") : calibration.phase === "failed" ? t("gesture.calFailed") : t("gesture.calibrating")}
            >
              <p>{calibration.message ?? (calibrating ? t(`gesture.cal.${calibration.phase as "get-low" | "low" | "get-high" | "high"}`) : "")}</p>
              {calibrating ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuenow={Math.round(calibration.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
                </div>
              ) : null}
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={cancelCalibration}>
                  {calibrating ? t("gesture.cancel") : t("gesture.dismiss")}
                </Button>
              </div>
            </Callout>
          ) : null}
        </div>
      </Card>

      <GestureProfileCard />
      <CameraDiagnostics />
      {heightMode ? <HeightTuning /> : null}
    </div>
  );
}

function targetKey(target: GestureTarget): string {
  return target.type === "experience" ? "experience" : target.type === "device" ? `device:${target.deviceId}` : `room:${target.roomId}`;
}

function parseTarget(key: string): GestureTarget {
  if (key.startsWith("device:")) return { type: "device", deviceId: key.slice(7) };
  if (key.startsWith("room:")) return { type: "room", roomId: key.slice(5) };
  return { type: "experience" };
}

function GestureProfileCard() {
  const active = useActiveProfile();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // keyed: switching or saving a profile starts a fresh draft (the message survives the remount)
  return <ProfileEditor key={JSON.stringify(active)} active={active} message={message} setMessage={setMessage} />;
}

function ProfileEditor({
  active,
  message,
  setMessage,
}: {
  active: GestureProfile;
  message: { ok: boolean; text: string } | null;
  setMessage: (m: { ok: boolean; text: string } | null) => void;
}) {
  const { t } = useT();
  const custom = useGestureProfiles((s) => s.custom);
  const setActive = useGestureProfiles((s) => s.setActive);
  const save = useGestureProfiles((s) => s.save);
  const remove = useGestureProfiles((s) => s.remove);
  const devices = useHub((s) => s.devices);
  const order = useHub((s) => s.order);
  const building = useBuilding((s) => s.snapshot);
  const [draft, setDraft] = useState<GestureProfile>(active);
  useEffect(() => {
    if (!building) void useBuilding.getState().load();
  }, [building]);
  const profiles = allProfiles(custom);
  const editable = !draft.builtin;
  const deviceList = order.map((id) => devices[id]).filter((d): d is NonNullable<typeof d> => !!d && !d.hidden);
  const bothPalmAndHeight = Boolean(draft.bindings.open_palm && (draft.bindings.raise || draft.bindings.lower));

  const duplicate = () => {
    const base = draft.name.replace(/\s*\(\d+\)$/, "");
    const id = `custom-${Date.now().toString(36)}`;
    const copy: GestureProfile = { ...draft, id, builtin: false, name: t("gesture.profile.copyOf", { name: base }).slice(0, 60) };
    const err = save(copy);
    if (err) setMessage({ ok: false, text: err });
    else setActive(id);
  };

  return (
    <Card>
      <CardHeader icon={<Hand className="h-4 w-4" />} title={t("gesture.profile.title")} subtitle={t("gesture.profile.subtitle")} />
      <div className="space-y-4 px-4 pb-5 pt-3 sm:px-5">
        <label className="block text-xs font-medium text-ink-200">
          {t("gesture.profile.select")}
          <select
            className={cn(selectCls, "mt-1")}
            value={active.id}
            onChange={(e) => {
              setMessage(null);
              setActive(e.target.value);
            }}
            data-testid="gesture-profile-select"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.builtin ? `(${t("gesture.profile.builtin")})` : ""}
              </option>
            ))}
          </select>
        </label>

        {editable ? (
          <label className="block text-xs font-medium text-ink-200">
            {t("gesture.profile.name")}
            <input className={cn(selectCls, "mt-1")} value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
        ) : (
          <p className="text-xs text-ink-400">{t("gesture.profile.readOnly")}</p>
        )}

        <label className="block text-xs font-medium text-ink-200">
          {t("gesture.profile.target")}
          <select
            className={cn(selectCls, "mt-1")}
            value={targetKey(draft.target)}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, target: parseTarget(e.target.value) })}
            data-testid="gesture-target-select"
          >
            <option value="experience">{t("gesture.profile.targetExperience")}</option>
            {deviceList.length ? (
              <optgroup label={t("gesture.profile.targetDevice")}>
                {deviceList.map((d) => (
                  <option key={d.id} value={`device:${d.id}`}>
                    {d.name}
                    {d.simulated ? ` (${t("gesture.profile.sim")})` : ""}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {building?.rooms.length ? (
              <optgroup label={t("gesture.profile.targetRoom")}>
                {building.rooms.map((r) => (
                  <option key={r.id} value={`room:${r.id}`}>
                    {roomLabel(building, r)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>

        <div className="overflow-hidden rounded-xl border border-ink-700">
          <table className="w-full text-sm">
            <thead className="bg-ink-900/70 text-[10px] uppercase tracking-[0.12em] text-ink-400">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">{t("gesture.profile.gesture")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("gesture.profile.binding")}</th>
              </tr>
            </thead>
            <tbody>
              {GESTURE_IDS.map((gid) => (
                <tr key={gid} className="border-t border-ink-800">
                  <td className="px-3 py-1.5 text-ink-100">{t(`gesture.pose.${gid}`)}</td>
                  <td className="px-3 py-1.5">
                    {editable ? (
                      <select
                        className={selectCls}
                        value={draft.bindings[gid] ?? ""}
                        aria-label={t(`gesture.pose.${gid}`)}
                        onChange={(e) => {
                          const bindings = { ...draft.bindings };
                          if (e.target.value) bindings[gid] = e.target.value as GestureAction;
                          else delete bindings[gid];
                          setDraft({ ...draft, bindings });
                        }}
                      >
                        <option value="">{t("gesture.action.none")}</option>
                        {GESTURE_ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {t(`gesture.action.${a}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={draft.bindings[gid] ? "text-ink-100" : "text-ink-500"}>{t(`gesture.action.${draft.bindings[gid] ?? "none"}`)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {bothPalmAndHeight ? <Callout tone="warn">{t("gesture.profile.overlapWarning")}</Callout> : null}

        {editable ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Slider id="profile-hold" label={t("gesture.profile.hold")} value={draft.holdMs} min={200} max={2000} step={50} format={(v) => `${v} ms`} onChange={(v) => setDraft({ ...draft, holdMs: v })} />
            <Slider id="profile-cooldown" label={t("gesture.profile.cooldown")} value={draft.cooldownMs} min={300} max={5000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(v) => setDraft({ ...draft, cooldownMs: v })} />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={duplicate} data-testid="gesture-profile-duplicate">
            <Copy className="h-3.5 w-3.5" aria-hidden />
            {t("gesture.profile.duplicate")}
          </Button>
          {editable ? (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const err = save(draft);
                  setMessage(err ? { ok: false, text: err } : { ok: true, text: t("gesture.profile.saved") });
                }}
                data-testid="gesture-profile-save"
              >
                <Save className="h-3.5 w-3.5" aria-hidden />
                {t("gesture.profile.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove(draft.id)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {t("gesture.profile.delete")}
              </Button>
            </>
          ) : null}
        </div>
        {message ? <p className={cn("text-xs", message.ok ? "text-ok" : "text-danger")} role="status">{message.text}</p> : null}
      </div>
    </Card>
  );
}

function CameraDiagnostics() {
  const { t } = useT();
  const [report, setReport] = useState<EnvReport | null>(null);
  const s = useGestureStore();
  const g = useSettings((x) => x.gesture);
  const setGesture = useSettings((x) => x.setGesture);
  const run = () => void collectEnvReport().then(setReport);
  useEffect(() => {
    run();
  }, [s.cameraStatus]);
  const tone = (state: string) => (state === "ok" ? "text-ok" : state === "fail" ? "text-danger" : state === "warn" ? "text-warn" : "text-ink-400");
  const rows = useMemo(
    () => [
      [t("gesture.diag.delegate"), s.delegate ? `${s.delegate} · ${t(`gesture.diag.reason.${s.delegateReason ?? "preferred"}`)}` : "—"],
      [t("gesture.diag.fps"), s.cameraStatus === "running" ? String(s.fps) : "—"],
      [t("gesture.diag.inference"), s.inferenceMs !== null ? `${s.inferenceMs} ms` : "—"],
      [t("gesture.diag.model"), s.modelLoadMs !== null ? `${s.modelLoadMs} ms` : "—"],
      [t("gesture.diag.frameErrors"), String(s.frameErrors)],
      [
        t("gesture.diag.stream"),
        s.streamInfo ? `${s.streamInfo.label} · ${s.streamInfo.width ?? "?"}×${s.streamInfo.height ?? "?"} @ ${s.streamInfo.frameRate ?? "?"} fps${s.streamInfo.facingMode ? ` · ${s.streamInfo.facingMode}` : ""}` : "—",
      ],
    ],
    [s.delegate, s.delegateReason, s.fps, s.inferenceMs, s.modelLoadMs, s.frameErrors, s.streamInfo, s.cameraStatus, t],
  );
  return (
    <Card>
      <CardHeader
        icon={<Activity className="h-4 w-4" />}
        title={t("gesture.diag.title")}
        subtitle={t("gesture.diag.subtitle")}
        actions={
          <Button variant="ghost" size="sm" onClick={run}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("gesture.diag.run")}
          </Button>
        }
      />
      <div className="space-y-3 px-4 pb-5 pt-3 text-sm sm:px-5" data-testid="camera-diagnostics">
        <ul className="divide-y divide-ink-800 rounded-xl border border-ink-700">
          {(report?.checks ?? []).map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2" data-testid={`diag-${c.id}`} data-state={c.state}>
              <span className="text-ink-200">{t(`gesture.diag.${c.id}`)}</span>
              <span className={cn("max-w-[60%] break-words text-end font-mono text-xs", tone(c.state))}>
                {t(`gesture.diag.state.${c.state}`)} · {c.value}
              </span>
            </li>
          ))}
          {rows.map(([k, v]) => (
            <li key={k} className="flex items-start justify-between gap-3 px-3 py-2">
              <span className="text-ink-200">{k}</span>
              <span className="max-w-[60%] break-words text-end font-mono text-xs text-ink-300">{v}</span>
            </li>
          ))}
        </ul>
        {s.delegateNote ? <Callout tone="accent">{s.delegateNote}</Callout> : null}
        {report?.softwareRenderer ? <p className="text-xs text-ink-400">{t("gesture.diag.softwareHint")}</p> : null}
        <label className="block text-xs font-medium text-ink-200">
          {t("gesture.diag.delegatePref")}
          <select className={cn(selectCls, "mt-1")} value={g.delegate} onChange={(e) => setGesture({ delegate: e.target.value as "auto" | "GPU" | "CPU" })}>
            <option value="auto">{t("gesture.diag.auto")}</option>
            <option value="GPU">GPU (WebGL)</option>
            <option value="CPU">CPU (WASM)</option>
          </select>
          <span className="mt-1 block font-normal text-ink-400">{t("gesture.diag.delegateHint")}</span>
        </label>
      </div>
    </Card>
  );
}

function HeightTuning() {
  const { t, pct: fmtPct } = useT();
  const pct = (v: number) => fmtPct(v * 100);
  const g = useSettings((s) => s.gesture);
  const setGesture = useSettings((s) => s.setGesture);
  const resetGesture = useSettings((s) => s.resetGesture);
  return (
    <Card>
      <CardHeader
        title={t("gesture.tuning")}
        subtitle={t("gesture.tuningSub")}
        actions={
          <Button variant="ghost" size="sm" onClick={resetGesture}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("gesture.defaults")}
          </Button>
        }
      />
      <div className="space-y-5 px-4 pb-5 pt-3 sm:px-5">
        <Slider
          id="on-threshold"
          label={t("gesture.onLine")}
          value={g.onThreshold}
          min={0.05}
          max={0.95}
          step={0.01}
          format={pct}
          onChange={(v) => setGesture({ onThreshold: Math.round(Math.max(v, g.offThreshold + MIN_THRESHOLD_GAP) * 100) / 100 })}
          description={t("gesture.onLineHint", { gap: pct(MIN_THRESHOLD_GAP) })}
        />
        <Slider
          id="off-threshold"
          label={t("gesture.offLine")}
          value={g.offThreshold}
          min={0.05}
          max={0.95}
          step={0.01}
          format={pct}
          onChange={(v) => setGesture({ offThreshold: Math.round(Math.min(v, g.onThreshold - MIN_THRESHOLD_GAP) * 100) / 100 })}
        />
        <Slider id="dwell" label={t("gesture.hold")} value={g.dwellMs} min={150} max={1500} step={50} format={(v) => `${v} ms`} onChange={(v) => setGesture({ dwellMs: v })} description={t("gesture.holdHint")} />
        <Slider
          id="cooldown"
          label={t("gesture.cooldown")}
          value={g.cooldownMs}
          min={500}
          max={5000}
          step={100}
          format={(v) => `${(v / 1000).toFixed(1)} s`}
          onChange={(v) => setGesture({ cooldownMs: v })}
          description={t("gesture.cooldownHint")}
        />
        <Switch id="open-for-off" checked={g.requireOpenForOff} onCheckedChange={(v) => setGesture({ requireOpenForOff: v })} label={t("gesture.openForOff")} description={t("gesture.openForOffHint")} />
        <Switch id="landmarks" checked={g.showLandmarks} onCheckedChange={(v) => setGesture({ showLandmarks: v })} label={t("gesture.landmarks")} />
      </div>
    </Card>
  );
}
