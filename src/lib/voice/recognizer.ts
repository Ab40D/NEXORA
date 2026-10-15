/**
 * Thin wrapper around the Web Speech API (SpeechRecognition).
 *
 * Browser support is limited and varies (Chromium-based browsers and Safari
 * expose `webkitSpeechRecognition`; Firefox does not enable it by default).
 * By default most engines send audio to the browser vendor's speech service;
 * Chrome 139+ can run on-device when `processLocally` is set and a language
 * pack is installed. Audio never passes through SE7ENX servers.
 */
import type { RecognitionAlternative } from "./commands";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?: (opts: { langs: string[]; processLocally?: boolean }) => Promise<string>;
  install?: (opts: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
}

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function supportsOnDeviceRecognition(): boolean {
  const C = getSpeechRecognitionCtor();
  return !!C && typeof C.available === "function";
}

export type OnDeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";

export async function checkOnDevice(lang: string): Promise<OnDeviceAvailability> {
  const C = getSpeechRecognitionCtor();
  if (!C?.available) return "unsupported";
  try {
    const r = await C.available({ langs: [lang], processLocally: true });
    return (["available", "downloadable", "downloading", "unavailable"] as const).includes(r as never)
      ? (r as OnDeviceAvailability)
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function installOnDevice(lang: string): Promise<boolean> {
  const C = getSpeechRecognitionCtor();
  if (!C?.install) return false;
  try {
    return await C.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

export const VOICE_ERROR_TEXT: Record<string, string> = {
  "not-allowed": "Microphone access was denied. Allow the microphone for this site in your browser settings and try again.",
  "service-not-allowed": "Speech recognition is blocked in this browser or context (it may require HTTPS or be disabled by policy).",
  "audio-capture": "No microphone was found or it is in use by another application.",
  network: "The browser's speech recognition service could not be reached. Check your connection or try on-device recognition.",
  "no-speech": "No speech detected. Press Listen and say a command.",
  aborted: "Listening stopped.",
  "language-not-supported": "This language is not supported by your browser's speech recognition (or the on-device language pack is missing).",
  "bad-grammar": "Speech recognition configuration error.",
};

export interface RecognizerCallbacks {
  onListening?: (listening: boolean) => void;
  onInterim?: (text: string) => void;
  onFinal?: (alternatives: RecognitionAlternative[]) => void;
  onError?: (code: string, message: string) => void;
}

export interface ListenOptions {
  lang: string;
  /** keep listening for multiple commands until maxDurationMs */
  continuous: boolean;
  /** hard stop — avoids open-ended listening */
  maxDurationMs: number;
  processLocally?: boolean;
}

export class VoiceRecognizer {
  private rec: SpeechRecognitionLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _listening = false;

  constructor(private readonly callbacks: RecognizerCallbacks, private readonly ctor = getSpeechRecognitionCtor()) {}

  get supported(): boolean {
    return this.ctor !== null;
  }

  get listening(): boolean {
    return this._listening;
  }

  start(opts: ListenOptions): void {
    if (!this.ctor) {
      this.callbacks.onError?.("unsupported", "Speech recognition is not available in this browser.");
      return;
    }
    this.abort();
    const rec = new this.ctor();
    rec.lang = opts.lang;
    rec.continuous = opts.continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    if (opts.processLocally && "processLocally" in rec) rec.processLocally = true;

    rec.onstart = () => {
      this._listening = true;
      this.callbacks.onListening?.(true);
    };
    rec.onend = () => {
      this.clearTimer();
      this._listening = false;
      this.rec = null;
      this.callbacks.onListening?.(false);
    };
    rec.onerror = (e) => {
      const code = e.error || "unknown";
      if (code === "aborted") return;
      this.callbacks.onError?.(code, VOICE_ERROR_TEXT[code] ?? `Speech recognition error: ${code}`);
    };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        if (result.isFinal) {
          const alts: RecognitionAlternative[] = [];
          for (let j = 0; j < result.length; j++) {
            const a = result[j];
            if (a) alts.push({ transcript: a.transcript, confidence: a.confidence });
          }
          this.callbacks.onFinal?.(alts);
        } else {
          this.callbacks.onInterim?.(result[0]?.transcript ?? "");
        }
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.callbacks.onError?.("start-failed", err instanceof Error ? err.message : "Could not start speech recognition.");
      return;
    }
    this.timer = setTimeout(() => this.stop(), opts.maxDurationMs);
  }

  stop(): void {
    this.clearTimer();
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
  }

  abort(): void {
    this.clearTimer();
    if (this.rec) {
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
      this.rec = null;
    }
    if (this._listening) {
      this._listening = false;
      this.callbacks.onListening?.(false);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
