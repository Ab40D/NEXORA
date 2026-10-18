"use client";

import { create } from "zustand";

export type PanelTab = "experience" | "connect" | "control" | "gesture" | "voice" | "history" | "devices" | "building" | "activity" | "settings";
export type AuthDialogView = "signin" | "register" | "reset";

/** localStorage key remembering that the welcome intro was seen (first visit only, Replay any time). */
export const INTRO_SEEN_KEY = "se7enx.intro.v1";

interface UiStore {
  wizardOpen: boolean;
  tab: PanelTab;
  /** null until decided after hydration (avoids a flash of the intro for returning visitors) */
  introOpen: boolean | null;
  openWizard: () => void;
  closeWizard: () => void;
  setTab: (tab: PanelTab) => void;
  openIntro: () => void;
  closeIntro: () => void;
  /** Sign-in dialog (guests choosing to sign in; remote web app). */
  authDialog: AuthDialogView | null;
  openAuth: (view?: AuthDialogView) => void;
  closeAuth: () => void;
}

export const useUi = create<UiStore>((set) => ({
  wizardOpen: false,
  tab: "experience",
  introOpen: null,
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
  setTab: (tab) => set({ tab }),
  authDialog: null,
  openAuth: (view = "signin") => set({ authDialog: view }),
  closeAuth: () => set({ authDialog: null }),
  openIntro: () => set({ introOpen: true }),
  closeIntro: () => {
    try {
      localStorage.setItem(INTRO_SEEN_KEY, "seen");
    } catch {
      /* private mode: the intro may show again next time */
    }
    set({ introOpen: false });
  },
}));

/** Decide on the first visit whether the intro opens (called once after hydration). */
export function initIntro(): void {
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_SEEN_KEY) === "seen";
  } catch {
    seen = false;
  }
  if (useUi.getState().introOpen === null) useUi.setState({ introOpen: !seen });
}
