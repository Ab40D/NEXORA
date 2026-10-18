"use client";

import { Download, Mic, MicOff, Radio, ShieldAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { SecureContextHelp } from "@/components/security/secure-context-help";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Label, Switch } from "@/components/ui/primitives";
import { useNow } from "@/lib/device";
import { useTarget } from "@/lib/experience/store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { useHub } from "@/lib/hub/hub-store";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";
import { EXAMPLE_PHRASES, languageFamily, VOICE_LANGUAGES } from "@/lib/voice/commands";
import { installOnDevice, supportsOnDeviceRecognition } from "@/lib/voice/recognizer";
import { hubSpeechAvailable, resolveEngine, useSpeechCaps } from "@/lib/voice/speech-input";
import {
  disableVoice,
  enableVoice,
  listenOnce,
  refreshOnDevice,
  startHandsFree,
  stopListening,
  useVoiceStore,
} from "@/lib/voice/voice-controller";

const ERROR_CODES = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "network",
  "no-speech",
  "aborted",
  "language-not-supported",
  "bad-grammar",
  "NotAllowedError",
  "NotFoundError",
  "no-engine",
  "insecure",
  "hub-stt-disabled",
  "hub-stt-unavailable",
  "hub-stt-audio",
  "hub-stt-busy",
  "hub-stt-forbidden",
]);

const STATUS_TONE = {
  executed: "text-ok",
  pending: "text-accent",
  blocked: "text-warn",
  failed: "text-danger",
  ignored: "text-ink-300",
} as const;

export function VoicePanel() {
  const v = useVoiceStore();
  const voice = useSettings((s) => s.voice);
  const setVoice = useSettings((s) => s.setVoice);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const legacySim = useAppStore((s) => s.light.mode === "simulation");
  const target = useTarget();
  const isSim = target ? target.simulated : legacySim;
  const { t } = useT();
  const now = useNow(500);
  const [installing, setInstalling] = useState(false);
  const family = languageFamily(voice.lang);
  const langOpt = VOICE_LANGUAGES.find((l) => l.tag === voice.lang) ?? VOICE_LANGUAGES[0]!;
  const caps = useSpeechCaps();
  const hubStatus = useHub((s) => s.status);
  useEffect(() => {
    void useSpeechCaps.getState().refresh();
  }, [hubStatus]);
  const engine = resolveEngine(voice.engine, caps);
  const hubOk = hubSpeechAvailable(caps);

  // Probe on-device availability only after the user opted in.
  useEffect(() => {
    if (v.enabled && voice.preferOnDevice) void refreshOnDevice();
  }, [voice.lang, v.enabled, voice.preferOnDevice]);

  const engineSelect = (
    <div className="space-y-2">
      <Label htmlFor="voice-engine">{t("voice.engine.label")}</Label>
      <select
        id="voice-engine"
        value={voice.engine}
        onChange={(e) => {
          stopListening();
          setVoice({ engine: e.target.value as "auto" | "browser" | "hub" });
        }}
        className="h-11 w-full rounded-xl border border-ink-600 bg-ink-900/80 px-3 text-sm text-ink-50"
        data-testid="voice-engine"
      >
        <option value="auto">{t("voice.engine.auto")}</option>
        <option value="hub">{t("voice.engine.hub")}{hubOk ? "" : ` (${t("voice.engine.unavailable")})`}</option>
        <option value="browser">{t("voice.engine.browser")}{caps.browser ? "" : ` (${t("voice.engine.unavailable")})`}</option>
      </select>
      <p className="text-xs text-ink-400">
        {hubOk ? t("voice.engine.hubReady", { model: caps.hub?.model ?? "?" }) : t("voice.engine.hubMissing")}{" "}
        {caps.browser ? t("voice.engine.browserNote") : t("voice.engine.browserMissing")}
      </p>
    </div>
  );

  if (v.supported === false || engine === null) {
    return (
      <Card>
        <CardHeader icon={<MicOff className="h-4 w-4" />} title={t("voice.unavailableTitle")} />
        <div className="space-y-3 px-4 pb-5 pt-3 sm:px-5">
          <SecureContextHelp feature="microphone" />
          <Callout tone="warn" title={t("voice.unsupportedTitle")} data-testid="voice-no-engine">
            {t("voice.engine.noneBody")}
          </Callout>
          {v.supported !== false ? engineSelect : null}
        </div>
      </Card>
    );
  }

  const remaining = v.session ? Math.max(0, Math.ceil((v.session.endsAt - now) / 1000)) : 0;
  const errorText = v.error ? (ERROR_CODES.has(v.error.code) ? t(`voice.errors.${v.error.code}` as MessageKey) : v.error.message) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Mic className="h-4 w-4" />}
          title={t("voice.title")}
          subtitle={isSim ? t("voice.subtitleSim") : t("voice.subtitleReal")}
          actions={
            v.listening ? (
              <Badge tone="danger" dot>
                {t("voice.listening")}
              </Badge>
            ) : v.transcribing ? (
              <Badge tone="accent" dot>
                {t("voice.engine.transcribing")}
              </Badge>
            ) : v.enabled ? (
              <Badge tone="ok">{t("voice.enabled")}</Badge>
            ) : null
          }
        />
        <div className="space-y-4 px-4 pb-5 pt-3 sm:px-5">
          <SecureContextHelp feature="microphone" />
          <p className="text-xs text-ink-300" data-testid="voice-active-engine" data-engine={engine}>
            {engine === "hub" ? t("voice.engine.activeHub") : t("voice.engine.activeBrowser")}
          </p>
          {!v.enabled ? (
            <>
              <div className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs leading-relaxed text-ink-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <p>{t("voice.privacy")}</p>
              </div>
              <Button variant="primary" onClick={() => void enableVoice()} data-testid="enable-voice">
                <Mic className="h-4 w-4" aria-hidden />
                {t("voice.enable")}
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {!v.listening ? (
                  <>
                    <Button variant="primary" size="lg" onClick={listenOnce} disabled={paused} data-testid="voice-listen">
                      <Mic className="h-5 w-5" aria-hidden />
                      {t("voice.listen")}
                    </Button>
                    <Button variant="outline" onClick={startHandsFree} disabled={paused}>
                      <Radio className="h-4 w-4" aria-hidden />
                      {t("voice.handsFree")}
                    </Button>
                  </>
                ) : (
                  <Button variant="danger" size="lg" onClick={stopListening}>
                    <Square className="h-4 w-4" aria-hidden />
                    {v.session ? t("voice.stopRemaining", { seconds: remaining }) : t("voice.stop")}
                  </Button>
                )}
                <Button variant="ghost" onClick={disableVoice}>
                  <MicOff className="h-4 w-4" aria-hidden />
                  {t("voice.disable")}
                </Button>
              </div>

              {v.listening && engine === "hub" ? (
                <div className="h-1.5 overflow-hidden rounded-full bg-ink-700" aria-hidden>
                  <div className="h-full bg-ink-50 transition-[width] duration-75" style={{ width: `${Math.round(v.level * 100)}%` }} />
                </div>
              ) : null}
              <div className="grid gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm" aria-live="polite">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("voice.heard")}</p>
                  <p className="mt-0.5 min-h-5 text-ink-100" dir={langOpt.dir} data-testid="voice-heard">
                    {v.interim ? <span className="text-ink-300">{v.interim}…</span> : v.lastHeard ? `“${v.lastHeard.transcript}”` : <span className="text-ink-400">—</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{t("voice.result")}</p>
                  {v.lastResult ? (
                    <p className={cn("mt-0.5", STATUS_TONE[v.lastResult.status])} data-testid="voice-result">
                      {v.lastResult.command ? `${t(v.lastResult.command === "on" ? "lamp.legacyOn" : "lamp.legacyOff")} · ` : ""}
                      {t(`voice.status.${v.lastResult.status}`)}: {v.lastResult.detail}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-ink-400">—</p>
                  )}
                </div>
              </div>
            </>
          )}

          {errorText ? (
            <Callout tone="danger" role="alert" title={t("voice.error")}>
              {errorText}
            </Callout>
          ) : null}
          {paused ? (
            <Callout tone="danger" title={t("voice.stoppedTitle")}>
              {t("voice.stoppedBody")}
            </Callout>
          ) : null}
          {target ? <p className="text-xs text-ink-300">{t("voice.target", { name: target.name })}</p> : null}
          <p className="text-xs text-ink-400">{t("voice.chatHint")}</p>

          {engineSelect}

          <div className="space-y-2">
            <Label htmlFor="voice-lang">{t("voice.language")}</Label>
            <select
              id="voice-lang"
              value={voice.lang}
              onChange={(e) => {
                stopListening();
                setVoice({ lang: e.target.value });
              }}
              className="h-11 w-full rounded-xl border border-ink-600 bg-ink-900/80 px-3 text-sm text-ink-50"
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {v.enabled && engine === "browser" && supportsOnDeviceRecognition() ? (
            <div className="space-y-2">
              <Switch
                id="on-device"
                checked={voice.preferOnDevice}
                onCheckedChange={(c) => setVoice({ preferOnDevice: c })}
                label={t("voice.onDevice")}
                description={
                  !voice.preferOnDevice
                    ? t("voice.onDeviceOff")
                    : v.onDevice === null
                      ? t("voice.onDeviceChecking")
                      : v.onDevice === "available"
                        ? t("voice.onDeviceAvailable")
                        : v.onDevice === "downloadable"
                          ? t("voice.onDeviceDownloadable")
                          : v.onDevice === "downloading"
                            ? t("voice.onDeviceDownloading")
                            : t("voice.onDeviceUnavailable")
                }
              />
              {voice.preferOnDevice && v.onDevice === "downloadable" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installing}
                  onClick={async () => {
                    setInstalling(true);
                    await installOnDevice(voice.lang);
                    await refreshOnDevice();
                    setInstalling(false);
                  }}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {installing ? t("voice.downloading") : t("voice.download")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("voice.phrases")} subtitle={t("voice.phrasesSub")} />
        <div className="grid gap-3 px-4 pb-5 pt-3 sm:grid-cols-2 sm:px-5">
          {(["on", "off"] as const).map((k) => (
            <div key={k} className="rounded-xl border border-ink-700 bg-ink-900/60 p-3">
              <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", k === "on" ? "text-warm" : "text-ink-300")}>{k === "on" ? t("voice.switchOn") : t("voice.switchOff")}</p>
              <ul className="mt-1.5 space-y-1 text-sm text-ink-100" dir={langOpt.dir}>
                {EXAMPLE_PHRASES[family][k].map((p) => (
                  <li key={p}>“{p}”</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
