"use client";

import { create } from "zustand";

export type PanelTab = "control" | "gesture" | "voice" | "history" | "devices";

interface UiStore {
  wizardOpen: boolean;
  tab: PanelTab;
  openWizard: () => void;
  closeWizard: () => void;
  setTab: (tab: PanelTab) => void;
}

export const useUi = create<UiStore>((set) => ({
  wizardOpen: false,
  tab: "control",
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
  setTab: (tab) => set({ tab }),
}));
