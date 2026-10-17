"use client";

/**
 * Voice control runtime. Listening only ever starts from an explicit user
 * action, is time-limited, and stops on emergency stop / tab hide.
 */
import { create } from "zustand";
import { EXEC_KEY } from "@/lib/experience/labels";
import { useExperience } from "@/lib/experience/store";
import { t } from "@/lib/i18n";
import { useSettings } from "@/lib/state/settings";
import { useAppStore } from "@/lib/state/store";
import type { OnOff } from "@/lib/state/types";
import { languageFamily, resolveAlternatives, type RecognitionAlternative, type VoiceParseResult } from "./commands";
import { checkOnDevice, getSpeechRecognitionCtor, VoiceRecognizer, type OnDeviceAvailability } from "./recognizer";

export const PUSH_TO_TALK_MS = 8_000;
export const HANDS_FREE_MS = 60_000;
const MAX_HANDS_FREE_RESTARTS = 6;

export type VoiceResultStatus = "executed" | "blocked" | "failed" | "ignored" | "pending";

interface VoiceStore {
  supported: boolean | null;
  micPermission: "unknown" | "granted" | "denied";
  enabled: boolean;
  listening: boolean;
  session: { mode: "push" | "handsfree"; endsAt: number } | null;
  interim: string;
  lastHeard: { transcript: string; at: number } | null;
  lastResult: { command: OnOff | null; status: VoiceResultStatus; detail: string; at: number } | null;
  error: { code: string; message: string } | null;
  onDevice: OnDeviceAvailability | null;
  set: (p: Partial<Omit<VoiceStore, "set">>) => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  supported: null,
  micPermission: "unknown",
  enabled: false,
  listening: false,
  session: null,
  interim: "",
  lastHeard: null,
  lastResult: null,
  error: null,
  onDevice: null,
  set: (p) => set(p),
}));

const reasonText = (reason: NonNullable<VoiceParseResult["reason"]>) => t(`voice.reason.${reason}`);

let recognizer: VoiceRecognizer | null = null;
let restarts = 0;

async function handleFinal(alts: RecognitionAlternative[]) {
  const store = useVoiceStore.getState();
  const lang = useSettings.getState().voice.lang;
  const transcript = alts[0]?.transcript?.trim() ?? "";
  store.set({ interim: "", lastHeard: { transcript, at: Date.now() } });
  const parsed = resolveAlternatives(alts, languageFamily(lang));
  if (!parsed.command) {
    store.set({ lastResult: { command: null, status: "ignored", detail: reasonText(parsed.reason ?? "no-match"), at: Date.now() } });
    return;
  }
  store.set({ lastResult: { command: parsed.command, status: "pending", detail: t("voice.sending"), at: Date.now() } });
  // With a light selected in the Smart Light Experience, voice uses the same pipeline as every input.
  const xp = useExperience.getState();
  if (xp.target !== "none") {
    const exec = await xp.execute({ kind: parsed.command === "on" ? "turn_on" : "turn_off" }, "voice");
    const status: VoiceResultStatus =
      exec.state === "confirmed" || exec.state === "simulated" || exec.state === "already"
        ? "executed"
        : exec.state === "accepted"
          ? "pending"
          : exec.state === "blocked"
            ? "blocked"
            : "failed";
    const detail = t(EXEC_KEY[exec.state]) + (exec.error && exec.state !== "already" ? ` — ${t(`errors.${exec.error}.message`)}` : "");
    useVoiceStore.getState().set({ lastResult: { command: parsed.command, status, detail, at: Date.now() } });
    return;
  }
  const res = await useAppStore.getState().requestCommand(parsed.command, "voice");
  const detail = res.status === "done" ? res.detail : res.status === "blocked" ? t(`block.${res.reason}`) : `${res.message}${res.hint ? ` — ${res.hint}` : ""}`;
  useVoiceStore.getState().set({
    lastResult: { command: parsed.command, status: res.status === "done" ? "executed" : res.status, detail, at: Date.now() },
  });
}

function getRecognizer(): VoiceRecognizer {
  if (recognizer) return recognizer;
  recognizer = new VoiceRecognizer({
    onListening: (listening) => {
      const s = useVoiceStore.getState();
      s.set({ listening, interim: listening ? s.interim : "" });
      if (!listening && s.session?.mode === "handsfree" && Date.now() < s.session.endsAt && restarts < MAX_HANDS_FREE_RESTARTS && !document.hidden) {
        // engines stop after silence; keep the explicitly started session alive until its deadline
        restarts++;
        startRecognition("handsfree", s.session.endsAt - Date.now());
        return;
      }
      if (!listening) s.set({ session: null });
    },
    onInterim: (text) => useVoiceStore.getState().set({ interim: text }),
    onFinal: (alts) => void handleFinal(alts),
    onError: (code, message) => {
      const s = useVoiceStore.getState();
      if (code === "not-allowed" || code === "service-not-allowed") {
        s.set({ micPermission: code === "not-allowed" ? "denied" : s.micPermission, session: null, error: { code, message } });
      } else if (code === "no-speech") {
        s.set({ lastResult: { command: null, status: "ignored", detail: message, at: Date.now() } });
      } else {
        s.set({ error: { code, message }, session: s.session?.mode === "handsfree" ? s.session : null });
      }
    },
  });
  return recognizer;
}

function startRecognition(mode: "push" | "handsfree", durationMs: number) {
  const { lang, preferOnDevice } = useSettings.getState().voice;
  const onDevice = useVoiceStore.getState().onDevice;
  getRecognizer().start({
    lang,
    continuous: mode === "handsfree",
    maxDurationMs: durationMs,
    processLocally: preferOnDevice && onDevice === "available",
  });
}

export function initVoiceSupport(): void {
  useVoiceStore.getState().set({ supported: getSpeechRecognitionCtor() !== null });
}

export async function refreshOnDevice(): Promise<void> {
  const lang = useSettings.getState().voice.lang;
  useVoiceStore.getState().set({ onDevice: await checkOnDevice(lang) });
}

/** Explicit opt-in: asks for microphone permission once, records nothing. */
export async function enableVoice(): Promise<void> {
  const s = useVoiceStore.getState();
  if (!getSpeechRecognitionCtor()) {
    s.set({ supported: false });
    return;
  }
  s.set({ error: null });
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t) => t.stop()); // permission check only
      s.set({ micPermission: "granted", enabled: true });
    } catch (err) {
      const name = (err as DOMException)?.name;
      s.set({
        micPermission: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unknown",
        enabled: false,
        error: {
          code: name ?? "mic",
          message:
            name === "NotAllowedError"
              ? "Microphone access was denied. Allow it in the browser's site settings to use voice commands. Manual controls still work."
              : name === "NotFoundError"
                ? "No microphone found."
                : `Could not access the microphone (${name ?? "error"}).`,
        },
      });
      return;
    }
  } else {
    s.set({ enabled: true });
  }
  // NOTE: the experimental on-device availability probe is NOT called here; it only
  // runs when the user explicitly opts into on-device recognition (it can crash
  // browsers without an on-device speech service).
}

export function disableVoice(): void {
  stopListening();
  useVoiceStore.getState().set({ enabled: false, interim: "" });
}

export function listenOnce(): void {
  const s = useVoiceStore.getState();
  if (!s.enabled) return;
  if (useAppStore.getState().light.dispatchPaused) {
    s.set({ lastResult: { command: null, status: "blocked", detail: t("block.paused"), at: Date.now() } });
    return;
  }
  restarts = 0;
  s.set({ error: null, session: { mode: "push", endsAt: Date.now() + PUSH_TO_TALK_MS } });
  startRecognition("push", PUSH_TO_TALK_MS);
}

export function startHandsFree(): void {
  const s = useVoiceStore.getState();
  if (!s.enabled) return;
  if (useAppStore.getState().light.dispatchPaused) {
    s.set({ lastResult: { command: null, status: "blocked", detail: t("block.paused"), at: Date.now() } });
    return;
  }
  restarts = 0;
  s.set({ error: null, session: { mode: "handsfree", endsAt: Date.now() + HANDS_FREE_MS } });
  startRecognition("handsfree", HANDS_FREE_MS);
}

export function stopListening(): void {
  useVoiceStore.getState().set({ session: null });
  recognizer?.abort();
}
