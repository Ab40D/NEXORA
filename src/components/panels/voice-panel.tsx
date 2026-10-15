"use client";

import { Download, Mic, MicOff, Radio, ShieldAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, Label, Switch } from "@/components/ui/primitives";
import { useNow } from "@/lib/device";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";
import { EXAMPLE_PHRASES, languageFamily, VOICE_LANGUAGES } from "@/lib/voice/commands";
import { installOnDevice, supportsOnDeviceRecognition } from "@/lib/voice/recognizer";
import {
  disableVoice,
  enableVoice,
  listenOnce,
  refreshOnDevice,
  startHandsFree,
  stopListening,
  useVoiceStore,
} from "@/lib/voice/voice-controller";

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
  const isSim = useAppStore((s) => s.light.mode === "simulation");
  const now = useNow(500);
  const [installing, setInstalling] = useState(false);
  const family = languageFamily(voice.lang);
  const langOpt = VOICE_LANGUAGES.find((l) => l.tag === voice.lang) ?? VOICE_LANGUAGES[0]!;

  // Probe on-device availability only after the user opted in.
  useEffect(() => {
    if (v.enabled && voice.preferOnDevice) void refreshOnDevice();
  }, [voice.lang, v.enabled, voice.preferOnDevice]);

  if (v.supported === false) {
    return (
      <Card>
        <CardHeader icon={<MicOff className="h-4 w-4" />} title="Voice commands not available" />
        <div className="space-y-3 px-4 pb-5 pt-3 sm:px-5">
          <Callout tone="warn" title="This browser does not support speech recognition">
            Voice control uses the Web Speech API, which is available in Chrome, Edge and Safari but not enabled by default in Firefox.
            Manual controls and gestures keep working.
          </Callout>
        </div>
      </Card>
    );
  }

  const remaining = v.session ? Math.max(0, Math.ceil((v.session.endsAt - now) / 1000)) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Mic className="h-4 w-4" />}
          title="Voice commands"
          subtitle={`Only allowlisted phrases are accepted. Voice can switch the light ${isSim ? "(simulated)" : "(REAL)"} on or off — nothing else.`}
          actions={v.listening ? <Badge tone="danger" dot>Listening</Badge> : v.enabled ? <Badge tone="ok">Enabled</Badge> : null}
        />
        <div className="space-y-4 px-4 pb-5 pt-3 sm:px-5">
          {!v.enabled ? (
            <>
              <div className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-xs leading-relaxed text-ink-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <p>
                  The microphone is used only while you press <strong className="text-ink-100">Listen</strong> (or during a 60-second hands-free
                  session you start). Speech is transcribed by your browser&apos;s speech service — in Chrome and Safari this usually means audio is sent
                  to Google or Apple — unless on-device recognition is available and enabled. SE7ENX never receives your audio.
                </p>
              </div>
              <Button variant="primary" onClick={() => void enableVoice()} data-testid="enable-voice">
                <Mic className="h-4 w-4" aria-hidden />
                Enable voice commands
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {!v.listening ? (
                  <>
                    <Button variant="primary" size="lg" onClick={listenOnce} disabled={paused} data-testid="voice-listen">
                      <Mic className="h-5 w-5" aria-hidden />
                      Listen
                    </Button>
                    <Button variant="outline" onClick={startHandsFree} disabled={paused}>
                      <Radio className="h-4 w-4" aria-hidden />
                      Hands-free 60 s
                    </Button>
                  </>
                ) : (
                  <Button variant="danger" size="lg" onClick={stopListening}>
                    <Square className="h-4 w-4" aria-hidden />
                    Stop listening {v.session ? `(${remaining}s)` : ""}
                  </Button>
                )}
                <Button variant="ghost" onClick={disableVoice}>
                  <MicOff className="h-4 w-4" aria-hidden />
                  Disable
                </Button>
              </div>

              <div className="grid gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm" aria-live="polite">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Heard</p>
                  <p className="mt-0.5 min-h-5 text-ink-100" dir={langOpt.dir} data-testid="voice-heard">
                    {v.interim ? <span className="text-ink-300">{v.interim}…</span> : v.lastHeard ? `“${v.lastHeard.transcript}”` : <span className="text-ink-400">—</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Result</p>
                  {v.lastResult ? (
                    <p className={cn("mt-0.5", STATUS_TONE[v.lastResult.status])} data-testid="voice-result">
                      {v.lastResult.command ? `${v.lastResult.command.toUpperCase()} · ` : ""}
                      {v.lastResult.status}: {v.lastResult.detail}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-ink-400">—</p>
                  )}
                </div>
              </div>
            </>
          )}

          {v.error ? (
            <Callout tone="danger" role="alert" title="Voice error">
              {v.error.message}
            </Callout>
          ) : null}
          {paused ? <Callout tone="danger" title="Emergency stop active">Voice commands are blocked until you resume hands-free control.</Callout> : null}

          <div className="space-y-2">
            <Label htmlFor="voice-lang">Recognition language</Label>
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

          {v.enabled && supportsOnDeviceRecognition() ? (
            <div className="space-y-2">
              <Switch
                id="on-device"
                checked={voice.preferOnDevice}
                onCheckedChange={(c) => setVoice({ preferOnDevice: c })}
                label="Prefer on-device recognition (experimental)"
                description={
                  !voice.preferOnDevice
                    ? "Keeps audio on this device when your browser has an offline language pack (Chrome 139+)."
                    : v.onDevice === null
                      ? "Checking availability…"
                      : v.onDevice === "available"
                        ? "On-device recognition is used — audio stays on this device."
                        : v.onDevice === "downloadable"
                          ? "A language pack must be downloaded first. Until then the browser's online service is used."
                          : v.onDevice === "downloading"
                            ? "Language pack downloading…"
                            : "Not available for this language — the browser's online service is used."
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
                  {installing ? "Downloading…" : "Download language pack"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Allowed phrases" subtitle="Filler words like “please” are ignored. Negations and other sentences are rejected." />
        <div className="grid gap-3 px-4 pb-5 pt-3 sm:grid-cols-2 sm:px-5">
          {(["on", "off"] as const).map((k) => (
            <div key={k} className="rounded-xl border border-ink-700 bg-ink-900/60 p-3">
              <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", k === "on" ? "text-warm" : "text-ink-300")}>{k === "on" ? "Switch on" : "Switch off"}</p>
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
