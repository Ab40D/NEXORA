"use client";

/**
 * One speech-input API with two engines:
 *
 *  - "hub":     MediaRecorder in the browser → SE7ENX hub → local speech-to-text service
 *               (SE7ENX_STT_URL). Works in Firefox and in Chromium builds without Google keys;
 *               audio stays in your network. Preferred automatically when the hub offers it.
 *  - "browser": the Web Speech API (SpeechRecognition). Depending on the browser, audio goes to the
 *               vendor's cloud (Chrome, Edge, Safari) or is processed on-device; unavailable in
 *               Firefox.
 *
 * Both deliver the same callbacks, so the voice panel and the assistant chat do not care which one
 * runs. Listening always starts from an explicit click and ends after one utterance or a timeout.
 */
import { create } from "zustand";
import type { SttInfo } from "@/lib/hub/contract";
import { hubClient, useHub } from "@/lib/hub/hub-store";
import { AdapterError } from "@/lib/adapters/types";
import type { RecognitionAlternative } from "./commands";
import { getSpeechRecognitionCtor, VoiceRecognizer, type RecognizerCallbacks } from "./recognizer";
import { recorderSupported, RecorderError, startRecording } from "./recorder";

export type SpeechEnginePref = "auto" | "browser" | "hub";
export type SpeechEngine = "browser" | "hub";

interface SpeechCaps {
  browser: boolean;
  recorder: boolean;
  hub: SttInfo | null;
  refresh: () => Promise<void>;
}

export const useSpeechCaps = create<SpeechCaps>((set) => ({
  browser: false,
  recorder: false,
  hub: null,
  refresh: async () => {
    const browser = getSpeechRecognitionCtor() !== null;
    const recorder = recorderSupported();
    let hub: SttInfo | null = null;
    if (useHub.getState().status === "ready") {
      try {
        hub = (await hubClient().assistantInfo()).stt ?? null;
      } catch {
        hub = null; // signed-out, no permission, or an older hub
      }
    }
    set({ browser, recorder, hub });
  },
}));

export function hubSpeechAvailable(caps: Pick<SpeechCaps, "recorder" | "hub">): boolean {
  return caps.recorder && !!caps.hub?.enabled;
}

/** Local hub speech first (privacy, works everywhere); the browser engine otherwise. */
export function resolveEngine(pref: SpeechEnginePref, caps: Pick<SpeechCaps, "browser" | "recorder" | "hub">): SpeechEngine | null {
  const hub = hubSpeechAvailable(caps);
  if (pref === "hub") return hub ? "hub" : null;
  if (pref === "browser") return caps.browser ? "browser" : null;
  return hub ? "hub" : caps.browser ? "browser" : null;
}

export interface SpeechCallbacks extends RecognizerCallbacks {
  onTranscribing?: (busy: boolean) => void;
  onLevel?: (level: number) => void;
}

export interface SpeechOptions {
  lang: string;
  maxDurationMs: number;
  continuous?: boolean;
  processLocally?: boolean;
}

export interface SpeechSession {
  engine: SpeechEngine;
  stop: () => void;
  abort: () => void;
}

const HUB_ERRORS: Record<string, string> = {
  STT_DISABLED: "hub-stt-disabled",
  STT_UNAVAILABLE: "hub-stt-unavailable",
  STT_TIMEOUT: "hub-stt-unavailable",
  STT_INVALID_OUTPUT: "hub-stt-unavailable",
  STT_BAD_AUDIO: "hub-stt-audio",
  RATE_LIMITED: "hub-stt-busy",
};

function startHub(opts: SpeechOptions, cb: SpeechCallbacks): SpeechSession {
  const rec = startRecording({ maxMs: opts.maxDurationMs, onLevel: cb.onLevel });
  let aborted = false;
  cb.onListening?.(true);
  void rec.done
    .then(async (recording) => {
      cb.onListening?.(false);
      if (aborted) return;
      if (!recording.speechDetected) {
        cb.onError?.("no-speech", "No speech detected.");
        return;
      }
      cb.onTranscribing?.(true);
      try {
        const res = await hubClient().transcribe(recording.blob, opts.lang);
        if (aborted) return;
        const text = res.text.trim();
        if (!text) cb.onError?.("no-speech", "No speech detected.");
        else cb.onFinal?.([{ transcript: text, confidence: 0.9 } satisfies RecognitionAlternative]);
      } finally {
        cb.onTranscribing?.(false);
      }
    })
    .catch((err: unknown) => {
      cb.onListening?.(false);
      if (aborted) return;
      if (err instanceof RecorderError) {
        if (err.code !== "aborted") cb.onError?.(err.code, err.message);
      } else if (err instanceof AdapterError) {
        cb.onError?.(HUB_ERRORS[err.code] ?? (err.status === 403 ? "hub-stt-forbidden" : "hub-stt-unavailable"), err.message);
      } else {
        cb.onError?.("hub-stt-unavailable", err instanceof Error ? err.message : String(err));
      }
    });
  return {
    engine: "hub",
    stop: () => rec.stop(),
    abort: () => {
      aborted = true;
      rec.abort();
      cb.onListening?.(false);
    },
  };
}

export function startSpeech(engine: SpeechEngine, opts: SpeechOptions, cb: SpeechCallbacks): SpeechSession {
  if (engine === "hub") return startHub(opts, cb);
  const r = new VoiceRecognizer(cb);
  r.start({ lang: opts.lang, continuous: !!opts.continuous, maxDurationMs: opts.maxDurationMs, processLocally: opts.processLocally });
  return { engine: "browser", stop: () => r.stop(), abort: () => r.abort() };
}
