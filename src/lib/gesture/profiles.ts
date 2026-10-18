"use client";

/**
 * Gesture profiles: which gesture does what, on which target.
 *
 * A profile binds gestures (static poses, plus the classic raise/lower hand height) to actions,
 * and points them at a target: the light selected in the Experience, one hub device, or every
 * capable device in a room. Profiles are validated (Zod) and stored in this browser.
 * Execution always goes through the normal command pipeline (permissions, emergency stop,
 * hub policy); a profile cannot grant anything the signed-in user could not do by hand.
 */
import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { POSES } from "./pose-classifier";

export const GESTURE_IDS = [...POSES, "raise", "lower"] as const;
export type GestureId = (typeof GESTURE_IDS)[number];

export const GESTURE_ACTIONS = [
  "turn_on",
  "turn_off",
  "toggle",
  "brightness_up",
  "brightness_down",
  "open",
  "close",
  "stop",
  "pause_hands_free",
] as const;
export type GestureAction = (typeof GESTURE_ACTIONS)[number];

export const GestureTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("experience") }),
  z.object({ type: z.literal("device"), deviceId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("room"), roomId: z.string().min(1).max(80) }),
]);
export type GestureTarget = z.infer<typeof GestureTargetSchema>;

export const GestureProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  builtin: z.boolean(),
  target: GestureTargetSchema,
  holdMs: z.number().int().min(200).max(3000),
  cooldownMs: z.number().int().min(300).max(10000),
  bindings: z.partialRecord(z.enum(GESTURE_IDS), z.enum(GESTURE_ACTIONS)),
});
export type GestureProfile = z.infer<typeof GestureProfileSchema>;

export const BUILTIN_PROFILES: GestureProfile[] = [
  {
    id: "lights",
    name: "Lights",
    builtin: true,
    target: { type: "experience" },
    holdMs: 500,
    cooldownMs: 1200,
    // open palm stays unbound: it is a common resting/waving pose and must not change anything
    bindings: { thumb_up: "turn_on", thumb_down: "turn_off", pointing_up: "brightness_up", fist: "brightness_down" },
  },
  {
    id: "covers",
    name: "Blinds & shutters",
    builtin: true,
    target: { type: "experience" },
    holdMs: 500,
    cooldownMs: 1500,
    bindings: { thumb_up: "open", thumb_down: "close", open_palm: "stop" },
  },
  {
    id: "classic",
    name: "Hand height (classic)",
    builtin: true,
    target: { type: "experience" },
    holdMs: 450,
    cooldownMs: 1500,
    bindings: { raise: "turn_on", lower: "turn_off" },
  },
];

/** Actions that move or switch something (as opposed to pausing hands-free control). */
export const ACTION_COMMAND: Record<Exclude<GestureAction, "pause_hands_free">, { command: string; params?: Record<string, number> }> = {
  turn_on: { command: "turn_on" },
  turn_off: { command: "turn_off" },
  toggle: { command: "toggle" },
  brightness_up: { command: "adjust_brightness", params: { delta: 20 } },
  brightness_down: { command: "adjust_brightness", params: { delta: -20 } },
  open: { command: "open" },
  close: { command: "close" },
  stop: { command: "stop" },
};

export function validateProfile(p: unknown): { ok: true; profile: GestureProfile } | { ok: false; error: string } {
  const r = GestureProfileSchema.safeParse(p);
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Invalid profile" };
  const bound = Object.values(r.data.bindings).filter(Boolean);
  if (bound.length === 0) return { ok: false, error: "Bind at least one gesture." };
  return { ok: true, profile: r.data };
}

/** Poses that may trigger under a profile (raise/lower are handled by the height engine). */
export function activePoses(p: GestureProfile): (typeof POSES)[number][] {
  return POSES.filter((g) => p.bindings[g]);
}

export function usesHeight(p: GestureProfile): boolean {
  return Boolean(p.bindings.raise || p.bindings.lower);
}

interface ProfileStore {
  activeId: string;
  custom: GestureProfile[];
  setActive: (id: string) => void;
  /** Create or replace a custom profile. Returns an error message when invalid. */
  save: (p: GestureProfile) => string | null;
  remove: (id: string) => void;
}

export const useGestureProfiles = create<ProfileStore>()(
  persist(
    (set, get) => ({
      activeId: "lights",
      custom: [],
      setActive: (id) => set({ activeId: id }),
      save: (p) => {
        const v = validateProfile({ ...p, builtin: false });
        if (!v.ok) return v.error;
        if (BUILTIN_PROFILES.some((b) => b.id === v.profile.id)) return "This name is reserved.";
        set((s) => ({ custom: [...s.custom.filter((c) => c.id !== v.profile.id), v.profile].slice(0, 20) }));
        return null;
      },
      remove: (id) => set((s) => ({ custom: s.custom.filter((c) => c.id !== id), activeId: get().activeId === id ? "lights" : s.activeId })),
    }),
    {
      name: "se7enx.gestures.v1",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // never trust stored data blindly: drop anything that fails validation
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ProfileStore>;
        const custom = Array.isArray(p.custom) ? p.custom.flatMap((c) => (GestureProfileSchema.safeParse(c).success ? [c as GestureProfile] : [])) : [];
        const ids = new Set([...BUILTIN_PROFILES.map((b) => b.id), ...custom.map((c) => c.id)]);
        return { ...current, custom, activeId: typeof p.activeId === "string" && ids.has(p.activeId) ? p.activeId : current.activeId };
      },
    },
  ),
);

export function allProfiles(custom: GestureProfile[]): GestureProfile[] {
  return [...BUILTIN_PROFILES, ...custom];
}

export function getActiveProfile(): GestureProfile {
  const s = useGestureProfiles.getState();
  return allProfiles(s.custom).find((p) => p.id === s.activeId) ?? BUILTIN_PROFILES[0]!;
}

export function useActiveProfile(): GestureProfile {
  const activeId = useGestureProfiles((s) => s.activeId);
  const custom = useGestureProfiles((s) => s.custom);
  return allProfiles(custom).find((p) => p.id === activeId) ?? BUILTIN_PROFILES[0]!;
}
