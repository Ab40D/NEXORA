"use client";

/** Verification levels of all devices (simulated / configured / connected / verified), from the hub. */
import { create } from "zustand";
import type { VerificationLevel } from "./contract";
import { hubClient, useHub } from "./hub-store";

interface CommissioningStore {
  levels: Record<string, { level: VerificationLevel; verifiedAt: string | null }>;
  supported: boolean;
  refresh: () => Promise<void>;
}

export const useCommissioning = create<CommissioningStore>((set) => ({
  levels: {},
  supported: true,
  refresh: async () => {
    if (useHub.getState().status !== "ready") return;
    try {
      set({ levels: await hubClient().commissioningLevels(), supported: true });
    } catch {
      set({ supported: false }); // older hub or no permission
    }
  },
}));
