/**
 * Speech synthesis (Web Speech API) with honest reporting:
 *  - "speaking" is only reported once the browser fires `onstart`;
 *  - a blocked autoplay (`not-allowed`, or no start within a grace period) is reported as blocked;
 *  - a voice is only used if it matches the language. For Darija (ar-DZ) another Arabic voice may be
 *    used, but it is flagged as a fallback so the UI can say so. Nothing is claimed otherwise.
 */
import { LOCALE_META, stripBidi, type Locale } from "@/lib/i18n/core";

export interface VoicePick {
  voice: SpeechSynthesisVoice | null;
  /** true when the voice is not for the exact language (Darija read by another Arabic voice) */
  fallback: boolean;
}

export type SpeakOutcome = "started" | "blocked" | "unsupported" | "no-voice" | "error";

const START_GRACE_MS = 2500;

export function synthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

const norm = (tag: string) => tag.replace("_", "-").toLowerCase();

export function pickVoice(locale: Locale, voices: readonly SpeechSynthesisVoice[]): VoicePick {
  for (const wanted of LOCALE_META[locale].synthesis.map(norm)) {
    const exact = voices.filter((v) => norm(v.lang) === wanted || (!wanted.includes("-") && norm(v.lang).startsWith(`${wanted}-`)));
    if (exact.length) return { voice: exact.find((v) => v.localService) ?? exact[0] ?? null, fallback: false };
  }
  if (locale === "dz") {
    const arabic = voices.filter((v) => norm(v.lang).startsWith("ar"));
    if (arabic.length) return { voice: arabic.find((v) => v.localService) ?? arabic[0] ?? null, fallback: true };
  }
  return { voice: null, fallback: false };
}

/** Voices load asynchronously in some browsers. Resolves with whatever is available after a short wait. */
export function loadVoices(waitMs = 1200): Promise<SpeechSynthesisVoice[]> {
  if (!synthesisSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, waitMs);
    synth.addEventListener("voiceschanged", done);
  });
}

export interface SpeakHandlers {
  onStart?: () => void;
  onEnd?: () => void;
}

/** Speak `text`; resolves when speech started (or failed to). `onEnd` fires when it finishes. */
export async function speak(text: string, locale: Locale, handlers: SpeakHandlers = {}): Promise<{ outcome: SpeakOutcome; pick: VoicePick }> {
  if (!synthesisSupported()) return { outcome: "unsupported", pick: { voice: null, fallback: false } };
  const pick = pickVoice(locale, await loadVoices());
  if (!pick.voice) return { outcome: "no-voice", pick };
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new window.SpeechSynthesisUtterance(stripBidi(text));
  utterance.voice = pick.voice;
  utterance.lang = pick.voice.lang;
  utterance.rate = 1;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpeakOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, pick });
    };
    const timer = setTimeout(() => {
      synth.cancel();
      settle("blocked");
    }, START_GRACE_MS);
    utterance.onstart = () => {
      handlers.onStart?.();
      settle("started");
    };
    utterance.onend = () => {
      handlers.onEnd?.();
      settle("error");
    };
    utterance.onerror = (e) => {
      handlers.onEnd?.();
      settle(e.error === "not-allowed" ? "blocked" : "error");
    };
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (synthesisSupported()) window.speechSynthesis.cancel();
}
