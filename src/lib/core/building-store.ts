"use client";

/**
 * Building model cache (sites, buildings, floors, rooms, zones, device placement) for the
 * signed-in user. Read via the Core API; writes stay in the building screens, which call
 * `load()` afterwards. The hub filters nothing secret here, but only users with
 * `building.view` can read it.
 */
import { create } from "zustand";
import { coreClient, useAuth } from "./auth-store";
import type { BuildingSnapshot, Room } from "./contract";

interface BuildingStore {
  snapshot: BuildingSnapshot | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  load: () => Promise<BuildingSnapshot | null>;
  clear: () => void;
}

export const useBuilding = create<BuildingStore>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  loadedAt: null,
  load: async () => {
    if (!useAuth.getState().can("building.view")) {
      set({ snapshot: null, error: null });
      return null;
    }
    if (get().loading) return get().snapshot;
    set({ loading: true, error: null });
    try {
      const snapshot = await coreClient().building();
      set({ snapshot, loading: false, loadedAt: Date.now() });
      return snapshot;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
  clear: () => set({ snapshot: null, loadedAt: null, error: null }),
}));

export function roomById(snapshot: BuildingSnapshot | null, id: string): Room | undefined {
  return snapshot?.rooms.find((r) => r.id === id);
}

/** "Floor · Room" label for pickers. */
export function roomLabel(snapshot: BuildingSnapshot | null, room: Room): string {
  const floor = snapshot?.floors.find((f) => f.id === room.floorId);
  return floor ? `${floor.name} · ${room.name}` : room.name;
}
