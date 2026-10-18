"use client";

import { Bot, Mic, MicOff, Send, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { useConversation } from "@/lib/assistant/conversation";
import { synthesisSupported } from "@/lib/assistant/speech";
import { useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useIsClient } from "@/lib/device";
import { useAppStore } from "@/lib/state/store";
import { cn } from "@/lib/utils";
import { resolveEngine, useSpeechCaps } from "@/lib/voice/speech-input";
import { useSettings } from "@/lib/state/settings";
import { EXEC_VIEW } from "./exec-view";

const EXAMPLES: MessageKey[] = ["assistant.example1", "assistant.example2", "assistant.example3"];

export function AssistantChat() {
  const { t } = useT();
  const messages = useConversation((s) => s.messages);
  const thinking = useConversation((s) => s.thinking);
  const listening = useConversation((s) => s.listening);
  const interim = useConversation((s) => s.interim);
  const speaking = useConversation((s) => s.speaking);
  const speakReplies = useConversation((s) => s.speakReplies);
  const voiceNote = useConversation((s) => s.voiceNote);
  const micNote = useConversation((s) => s.micNote);
  const llm = useConversation((s) => s.llm);
  const { send, startListening, finishListening, stopListening, setSpeakReplies, stopSpeaking, clear, loadAssistantInfo } = useConversation.getState();
  const caps = useSpeechCaps();
  const enginePref = useSettings((s) => s.voice.engine);
  const hubStatus = useHub((s) => s.status);
  const transcribing = useConversation((s) => s.transcribing);
  useEffect(() => {
    void useSpeechCaps.getState().refresh();
  }, [hubStatus]);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const isClient = useIsClient(); // support is only known in the browser (avoids hydration mismatches)
  const micSupported = isClient && resolveEngine(enginePref, caps) !== null;
  const ttsSupported = isClient && synthesisSupported();

  useEffect(() => {
    void loadAssistantInfo();
  }, [hubStatus, loadAssistantInfo]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, thinking]);

  // emergency stop ends listening and speaking immediately
  useEffect(() => {
    if (paused) {
      stopListening();
      stopSpeaking();
    }
  }, [paused, stopListening, stopSpeaking]);

  const submit = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setText("");
    void send(v, "typed");
  };

  return (
    <Card className="flex flex-col p-4 sm:p-5" data-testid="assistant-chat">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-ink-50">
            <Bot className="h-4 w-4 text-accent" aria-hidden />
            {t("assistant.title")}
          </h3>
          <p className="text-xs text-ink-300">{t("assistant.subtitle")}</p>
        </div>
        <Badge tone={llm?.enabled ? "accent" : "neutral"} className="shrink-0">
          <span data-testid="assistant-provider">{llm?.enabled ? t("assistant.llm.on", { model: llm.model ?? "LLM" }) : t("assistant.llm.off")}</span>
        </Badge>
      </div>

      <div ref={listRef} className="scrollbar-thin mt-3 max-h-80 min-h-32 space-y-2 overflow-y-auto pe-1" aria-live="polite" data-testid="chat-log">
        {messages.length === 0 ? (
          <p className="max-w-[85%] rounded-2xl rounded-ss-sm bg-ink-800 px-3 py-2 text-sm text-ink-100" dir="auto">
            {t("assistant.reply.greeting")}
          </p>
        ) : null}
        {messages.map((m) => {
          const exec = m.state ? EXEC_VIEW[m.state] : null;
          return (
            <div key={m.id} className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start")} data-role={m.role}>
              <span className="sr-only">{m.role === "user" ? t("assistant.you") : t("assistant.se7enx")}:</span>
              <p
                dir="auto"
                lang={m.lang === "dz" ? "ar-DZ" : m.lang}
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                  m.role === "user" ? "rounded-se-sm bg-accent/15 text-ink-50" : "rounded-ss-sm bg-ink-800 text-ink-100",
                )}
              >
                {m.role === "user" && m.via === "voice" ? <Mic className="me-1 inline h-3 w-3 opacity-60" aria-hidden /> : null}
                {m.text}
              </p>
              {exec ? (
                <span
                  className={cn(
                    "mt-0.5 text-[10px]",
                    exec.tone === "danger" ? "text-danger" : exec.tone === "warn" ? "text-warn" : exec.tone === "sim" ? "text-sim" : "text-ink-400",
                  )}
                  data-testid="chat-exec"
                >
                  {t(exec.key)}
                </span>
              ) : null}
              {m.note ? <span className="mt-0.5 text-[10px] text-ink-400">{m.note}</span> : null}
            </div>
          );
        })}
        {thinking ? <p className="animate-pulse text-xs text-ink-400">{t("assistant.thinking")}</p> : null}
        {listening ? (
          <p className="text-xs text-accent" dir="auto">
            {t("assistant.listening")} {interim}
          </p>
        ) : null}
        {transcribing ? (
          <p className="animate-pulse text-xs text-ink-300" data-testid="chat-transcribing">
            {t("voice.engine.transcribing")}
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-ink-400">{t("assistant.examplesTitle")}</span>
        {EXAMPLES.map((k) => (
          <button
            key={k}
            type="button"
            dir="auto"
            onClick={() => submit(t(k))}
            disabled={thinking}
            className="rounded-full border border-ink-600 px-2.5 py-1 text-[11px] text-ink-200 hover:border-accent/60 hover:text-ink-50 disabled:opacity-50"
          >
            {t(k)}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          placeholder={t("assistant.placeholder")}
          aria-label={t("assistant.placeholder")}
          data-testid="chat-input"
          className="h-10 min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-900 px-3 text-sm text-ink-50 placeholder:text-ink-400 focus-visible:border-accent focus-visible:outline-none"
        />
        <Button type="submit" variant="primary" size="icon" disabled={thinking || !text.trim()} aria-label={t("assistant.send")} data-testid="chat-send">
          <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
        </Button>
        {micSupported ? (
          <Button
            type="button"
            variant={listening ? "danger" : "secondary"}
            size="icon"
            onClick={() => (listening ? finishListening() : startListening())}
            disabled={transcribing}
            aria-pressed={listening}
            aria-label={listening ? t("assistant.micStop") : t("assistant.micStart")}
            data-testid="chat-mic"
          >
            {listening ? <Square className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
          </Button>
        ) : (
          <span title={t("assistant.mic.unsupported")} className="inline-flex h-10 w-10 items-center justify-center text-ink-500">
            <MicOff className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t("assistant.mic.unsupported")}</span>
          </span>
        )}
      </form>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-400">
        <div className="flex flex-wrap items-center gap-2">
          {ttsSupported ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSpeakReplies(!speakReplies)} aria-pressed={speakReplies} data-testid="chat-speak">
              {speakReplies ? <Volume2 className="h-3.5 w-3.5" aria-hidden /> : <VolumeX className="h-3.5 w-3.5" aria-hidden />}
              {t("assistant.speakReplies")}
            </Button>
          ) : (
            <span>{t("assistant.voice.unsupported")}</span>
          )}
          {speaking ? (
            <Button type="button" variant="ghost" size="sm" onClick={stopSpeaking}>
              <Square className="h-3 w-3" aria-hidden />
              {t("assistant.stopSpeaking")}
            </Button>
          ) : null}
        </div>
        {messages.length ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t("assistant.clear")}
          </Button>
        ) : null}
      </div>
      <div className="space-y-0.5 text-[11px]" aria-live="polite">
        {micNote ? <p className="text-warn">{t(micNote.key, micNote.vars)}</p> : null}
        {voiceNote ? <p className="text-ink-400">{t(voiceNote.key, voiceNote.vars)}</p> : null}
        {micSupported ? <p className="text-ink-500">{t("assistant.mic.note")}</p> : null}
      </div>
    </Card>
  );
}
