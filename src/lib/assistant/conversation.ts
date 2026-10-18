"use client";
/**
 * "Talk to SE7ENX" conversation: typed or push-to-talk input → local intent engine
 * (optional hub LLM fallback for messages the local engine does not understand) → the single
 * experience pipeline → truthful, localized reply (optionally spoken).
 *
 * Safety: the microphone only starts on an explicit click and stops after one utterance; speech
 * recognition results are ignored while SE7ENX is speaking (no feedback loop); the emergency stop
 * blocks assistant commands; the LLM can only return one of the fixed intents (validated twice:
 * by the hub and by the zod contract).
 */
import { create } from "zustand";
import { commandForIntent, conversationalReply, executionReply, stateReply, type Reply } from "./respond";
import { parseIntent, type Intent } from "./intent";
import { speak, stopSpeaking as cancelSpeech } from "./speech";
import { isBrightnessCommand, selectTarget, useExperience, type ExecState, type TargetSnapshot } from "@/lib/experience/store";
import type { AssistantInterpretation } from "@/lib/hub/contract";
import { hubClient, useHub } from "@/lib/hub/hub-store";
import { formatPercent, LOCALE_META, translate, useI18n, type Locale, type MessageKey, type Vars } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import { resolveEngine, startSpeech, useSpeechCaps, type SpeechSession } from "@/lib/voice/speech-input";
import { useSettings } from "@/lib/state/settings";
import { stopListening as stopVoicePanelListening } from "@/lib/voice/voice-controller";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  lang: Locale;
  via?: "typed" | "voice";
  /** execution state of the command this reply reports on */
  state?: ExecState;
  /** small note (e.g. "interpreted by <model>") */
  note?: string;
}

export interface Note {
  key: MessageKey;
  vars?: Vars;
}

interface ConversationStore {
  messages: ChatMessage[];
  thinking: boolean;
  listening: boolean;
  /** local hub speech: the recording is being transcribed */
  transcribing: boolean;
  interim: string;
  speaking: boolean;
  speakReplies: boolean;
  voiceNote: Note | null;
  micNote: Note | null;
  llm: { enabled: boolean; model: string | null } | null;
  loadAssistantInfo: () => Promise<void>;
  send: (text: string, via?: "typed" | "voice") => Promise<void>;
  startListening: () => void;
  /** end the recording now and use what was said (push-to-talk "stop") */
  finishListening: () => void;
  /** cancel listening and discard the audio */
  stopListening: () => void;
  setSpeakReplies: (on: boolean) => void;
  stopSpeaking: () => void;
  clear: () => void;
}

const MAX_TEXT = 300;
const LISTEN_MAX_MS = 8000;
let nextId = 0;
let speech: SpeechSession | null = null;

function currentTarget(): TargetSnapshot | null {
  return selectTarget(useExperience.getState(), useHub.getState());
}

function fromLlm(res: AssistantInterpretation, fallbackLang: Locale): Intent {
  const lang = res.language ?? fallbackLang;
  if (!res.valid) return { kind: "unknown", lang };
  switch (res.intent) {
    case "set_brightness":
      return res.value === null ? { kind: "clarify_value", lang } : { kind: "set_brightness", value: Math.max(0, Math.min(100, res.value)), lang };
    case "adjust_brightness":
      return res.value === null || res.value === 0
        ? { kind: "clarify_value", lang }
        : { kind: "adjust_brightness", value: Math.max(-100, Math.min(100, res.value)), lang };
    default:
      return { kind: res.intent, lang };
  }
}

function micNoteFor(code: string): Note | null {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return { key: "assistant.mic.denied" };
    case "no-speech":
      return { key: "assistant.mic.noSpeech" };
    case "language-not-supported":
      return { key: "assistant.mic.language" };
    case "network":
      return { key: "assistant.mic.network" };
    case "unsupported":
      return { key: "assistant.mic.unsupported" };
    case "aborted":
      return null;
    default:
      return { key: "assistant.mic.error", vars: { code } };
  }
}

export const useConversation = create<ConversationStore>()((set, get) => {
  const push = (m: Omit<ChatMessage, "id">) => set((s) => ({ messages: [...s.messages, { ...m, id: ++nextId }].slice(-60) }));

  const say = async (text: string, lang: Locale) => {
    get().stopListening(); // never listen to ourselves
    const { outcome, pick } = await speak(text, lang, {
      onStart: () => set({ speaking: true }),
      onEnd: () => set({ speaking: false }),
    });
    const voiceName = pick.voice ? `${pick.voice.name} (${pick.voice.lang})` : "";
    const voiceNote: Note | null =
      outcome === "started"
        ? pick.fallback
          ? { key: "assistant.voice.fallback", vars: { voice: voiceName } }
          : { key: "assistant.voice.using", vars: { voice: voiceName } }
        : outcome === "blocked"
          ? { key: "assistant.voice.blocked" }
          : outcome === "unsupported"
            ? { key: "assistant.voice.unsupported" }
            : outcome === "no-voice"
              ? { key: "assistant.voice.none" }
              : get().voiceNote;
    set({ voiceNote, ...(outcome === "started" ? {} : { speaking: false }) });
  };

  return {
    messages: [],
    thinking: false,
    listening: false,
    transcribing: false,
    interim: "",
    speaking: false,
    speakReplies: false,
    voiceNote: null,
    micNote: null,
    llm: null,

    loadAssistantInfo: async () => {
      if (useHub.getState().status !== "ready") {
        set({ llm: null });
        return;
      }
      try {
        const info = await hubClient().assistantInfo();
        set({ llm: { enabled: info.llm.enabled, model: info.llm.model } });
      } catch {
        set({ llm: null }); // older hub without the assistant endpoint
      }
    },

    send: async (raw, via = "typed") => {
      const text = raw.trim().slice(0, MAX_TEXT);
      if (!text || get().thinking) return;
      const ui = useI18n.getState().locale;
      push({ role: "user", text, lang: ui, via });
      set({ thinking: true });
      try {
        let intent = parseIntent(text, ui);
        let note: string | undefined;
        if (intent.kind === "unknown" && !intent.negated && get().llm?.enabled && useHub.getState().status === "ready") {
          const lang0 = intent.lang ?? ui;
          const target = currentTarget();
          try {
            const res = await hubClient().assistantInterpret({
              text,
              lang: lang0,
              ...(target
                ? { device: { name: target.name, dimmable: target.dimmable, on: target.state?.on ?? null, brightness: target.state?.brightness ?? null } }
                : {}),
            });
            if (res.valid && res.intent !== "unknown") {
              intent = fromLlm(res, lang0);
              note = translate(intent.lang ?? lang0, "assistant.llm.used", { model: res.model ?? "LLM" });
            }
          } catch {
            note = translate(lang0, "assistant.llm.error");
          }
        }

        const lang = intent.lang ?? ui;
        const pct = (n: number) => formatPercent(n, lang);
        let reply: Reply | null = conversationalReply(intent, pct);
        let state: ExecState | undefined;
        if (!reply) {
          const target = currentTarget();
          if (intent.kind === "query_state") {
            if (target?.kind === "hub" && !target.simulated) await useHub.getState().refresh(target.id);
            reply = stateReply(currentTarget(), pct);
          } else {
            const cmd = commandForIntent(intent);
            if (!cmd) reply = { key: "assistant.reply.notUnderstood" };
            else if (!target) reply = { key: "assistant.reply.noTarget" };
            else if (isBrightnessCommand(cmd) && !target.dimmable) reply = { key: "assistant.reply.notDimmable" };
            else {
              const exec = await useExperience.getState().execute(cmd, "assistant");
              state = exec.state;
              reply = executionReply(cmd, exec, currentTarget() ?? target, pct, (category) => translate(lang, `errors.${category}.message`));
            }
          }
        }
        const replyText = translate(lang, reply.key, reply.vars);
        push({ role: "assistant", text: replyText, lang, state, note });
        if (get().speakReplies) void say(replyText, lang);
      } finally {
        set({ thinking: false });
      }
    },

    startListening: () => {
      if (useAppStore.getState().light.dispatchPaused) {
        set({ micNote: { key: "assistant.mic.paused" } });
        return;
      }
      cancelSpeech();
      stopVoicePanelListening(); // only one microphone user at a time
      speech?.abort();
      set({ speaking: false, micNote: null, interim: "" });
      const engine = resolveEngine(useSettings.getState().voice.engine, useSpeechCaps.getState());
      if (!engine) {
        set({ micNote: { key: "assistant.mic.unsupported" } });
        return;
      }
      speech = startSpeech(
        engine,
        { lang: LOCALE_META[useI18n.getState().locale].recognition, maxDurationMs: LISTEN_MAX_MS },
        {
          onListening: (listening) => set(listening ? { listening } : { listening, interim: "" }),
          onInterim: (interim) => set({ interim }),
          onTranscribing: (transcribing) => set({ transcribing }),
          onFinal: (alternatives) => {
            const best = alternatives[0]?.transcript?.trim();
            set({ interim: "" });
            if (best && !get().speaking) void get().send(best, "voice");
          },
          onError: (code, message) =>
            set({ micNote: code.startsWith("hub-stt") ? { key: "assistant.mic.hubError", vars: { message } } : micNoteFor(code), listening: false }),
        },
      );
    },

    finishListening: () => {
      speech?.stop();
    },

    stopListening: () => {
      speech?.abort();
      speech = null;
      set({ listening: false, transcribing: false, interim: "" });
    },

    setSpeakReplies: (on) => {
      if (!on) cancelSpeech();
      set({ speakReplies: on, ...(on ? {} : { speaking: false }) });
    },

    stopSpeaking: () => {
      cancelSpeech();
      set({ speaking: false });
    },

    clear: () => set({ messages: [] }),
  };
});
