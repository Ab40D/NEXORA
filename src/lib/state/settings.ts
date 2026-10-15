"use client";

/**
 * Persisted, NON-SECRET user preferences (localStorage), validated with zod on
 * load. Pairing tokens and Home Assistant tokens are never stored here.
 */
import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_GESTURE_CONFIG, MIN_THRESHOLD_GAP } from "@/lib/gesture/gesture-engine";

export const GestureSettingsSchema = z
  .object({
    onThreshold: z.number().min(0.05).max(0.95),
    offThreshold: z.number().min(0.05).max(0.95),
    dwellMs: z.number().int().min(100).max(3000),
    cooldownMs: z.number().int().min(300).max(10000),
    requireOpenForOff: z.boolean(),
    showLandmarks: z.boolean(),
  })
  .refine((g) => g.onThreshold - g.offThreshold >= MIN_THRESHOLD_GAP - 1e-9, "threshold gap");
export type GestureSettings = z.infer<typeof GestureSettingsSchema>;

export const VoiceSettingsSchema = z.object({
  lang: z.string().min(2).max(12),
  preferOnDevice: z.boolean(),
  handsFree: z.boolean(),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const ConnectionPrefsSchema = z.object({
  bridgeUrl: z.string().max(300),
  hassUrl: z.string().max(300),
  groupAddress: z.string().max(16),
  statusAddress: z.string().max(16),
  dpt: z.enum(["1.001", "5.001"]),
  onLevel: z.number().int().min(1).max(100),
});
export type ConnectionPrefs = z.infer<typeof ConnectionPrefsSchema>;

export const DEFAULT_GESTURE_SETTINGS: GestureSettings = {
  onThreshold: DEFAULT_GESTURE_CONFIG.onThreshold,
  offThreshold: DEFAULT_GESTURE_CONFIG.offThreshold,
  dwellMs: DEFAULT_GESTURE_CONFIG.dwellMs,
  cooldownMs: DEFAULT_GESTURE_CONFIG.cooldownMs,
  requireOpenForOff: DEFAULT_GESTURE_CONFIG.requireOpenForOff,
  showLandmarks: true,
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { lang: "en-US", preferOnDevice: false, handsFree: false };

export const DEFAULT_CONNECTION_PREFS: ConnectionPrefs = {
  bridgeUrl: process.env.NEXT_PUBLIC_DEFAULT_BRIDGE_URL || "http://127.0.0.1:8787",
  hassUrl: "",
  groupAddress: "0/0/1",
  statusAddress: "",
  dpt: "1.001",
  onLevel: 100,
};

interface SettingsStore {
  gesture: GestureSettings;
  voice: VoiceSettings;
  connection: ConnectionPrefs;
  setGesture: (patch: Partial<GestureSettings>) => boolean;
  setVoice: (patch: Partial<VoiceSettings>) => void;
  setConnection: (patch: Partial<ConnectionPrefs>) => void;
  resetGesture: () => void;
}

function safe<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const r = schema.safeParse(value);
  return r.success ? r.data : fallback;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set, get) => ({
      gesture: DEFAULT_GESTURE_SETTINGS,
      voice: DEFAULT_VOICE_SETTINGS,
      connection: DEFAULT_CONNECTION_PREFS,
      setGesture: (patch) => {
        const next = { ...get().gesture, ...patch };
        if (!GestureSettingsSchema.safeParse(next).success) return false;
        set({ gesture: next });
        return true;
      },
      setVoice: (patch) => set({ voice: safe(VoiceSettingsSchema, { ...get().voice, ...patch }, get().voice) }),
      setConnection: (patch) =>
        set({ connection: safe(ConnectionPrefsSchema, { ...get().connection, ...patch }, get().connection) }),
      resetGesture: () => set({ gesture: DEFAULT_GESTURE_SETTINGS }),
    }),
    {
      name: "se7enx.settings.v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ gesture: s.gesture, voice: s.voice, connection: s.connection }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsStore>;
        return {
          ...current,
          gesture: safe(GestureSettingsSchema, p.gesture, current.gesture),
          voice: safe(VoiceSettingsSchema, p.voice, current.voice),
          connection: safe(ConnectionPrefsSchema, p.connection, current.connection),
        };
      },
    },
  ),
);
