"use client";

import { Building2, DoorOpen, Layers, Map as MapIcon, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuthErrorText } from "@/components/auth/auth-forms";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Input } from "@/components/ui/primitives";
import { coreClient, toFailure, useAuth, useCan, type AuthFailure } from "@/lib/core/auth-store";
import { ROOM_KINDS, type BuildingImportTree, type BuildingSnapshot, type Floor, type Room, type RoomKind } from "@/lib/core/contract";
import type { HubDevice } from "@/lib/hub/contract";
import { describeReported } from "@/lib/hub/format";
import { useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";

type T = ReturnType<typeof useT>["t"];

function browserTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** Template trees with names in the user's language (the hub stores whatever names it receives). */
function templateTree(kind: "apartment" | "house" | "office", t: T): BuildingImportTree {
  const room = (k: RoomKind, suffix = "") => ({ name: `${t(`building.roomKind.${k}` as MessageKey)}${suffix}`, kind: k });
  const timezone = browserTimezone();
  if (kind === "office") {
    return {
      sites: [
        {
          name: t("building.names.office"),
          timezone,
          buildings: [
            {
              name: t("building.names.office"),
              kind: "commercial",
              floors: [{ name: t("building.names.groundFloor"), level: 0, rooms: [room("entrance"), room("meeting"), room("office"), room("kitchen"), room("technical")] }],
            },
          ],
        },
      ],
    };
  }
  if (kind === "house") {
    return {
      sites: [
        {
          name: t("building.names.home"),
          timezone,
          buildings: [
            {
              name: t("building.names.house"),
              kind: "residential",
              floors: [
                { name: t("building.names.groundFloor"), level: 0, rooms: [room("entrance"), room("living"), room("kitchen"), room("dining"), room("garage")] },
                { name: t("building.names.firstFloor"), level: 1, rooms: [room("bedroom"), room("bedroom", " 2"), room("bathroom")] },
              ],
            },
          ],
        },
      ],
    };
  }
  return {
    sites: [
      {
        name: t("building.names.home"),
        timezone,
        buildings: [
          {
            name: t("building.names.apartment"),
            kind: "residential",
            floors: [{ name: t("building.names.groundFloor"), level: 0, rooms: [room("entrance"), room("living"), room("kitchen"), room("bedroom"), room("bathroom")] }],
          },
        ],
      },
    ],
  };
}

function DeviceRow({ device, rooms, floors }: { device: HubDevice; rooms: Room[]; floors: Floor[] }) {
  const { t, locale } = useT();
  const canPlace = useCan("device.configure");
  const canControl = useCan("device.control");
  const command = useHub((s) => s.command);
  const busy = useHub((s) => s.busy[device.id] ?? false);
  const reported = device.state.reported;
  const offline = device.connection.status !== "online" && !device.simulated;
  const summary = offline ? t("common.unknown") : describeReported(device.type, reported, locale).join(" · ") || t("common.unknown");
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? "";
  const canSwitch = canControl && device.controlAllowed && device.commands.includes("toggle");
  return (
    <li className="space-y-1.5 rounded-lg border border-ink-800 px-2.5 py-1.5 text-xs" data-testid={`placed-${device.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium text-ink-100" dir="auto">
            {device.name}
          </p>
          <p className="text-ink-400">
            {device.simulated ? `${t("badge.simulation")} · ` : ""}
            {summary}
          </p>
        </div>
        {canSwitch ? (
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={busy} onClick={() => void command(device.id, "toggle", {}, "manual")} aria-label={`${device.name}: ${t("common.on")}/${t("common.off")}`}>
            <Power className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {canPlace ? (
        <select
          aria-label={`${t("building.room")}: ${device.name}`}
          value={device.metadata.roomId ?? ""}
          onChange={(e) =>
            void coreClient()
              .placeDevice(device.id, e.target.value || null)
              .then(() => window.dispatchEvent(new Event("se7enx:building-changed")))
          }
          className="h-8 w-full min-w-0 rounded-lg border border-ink-600 bg-ink-850 px-1.5 text-xs text-ink-100"
          data-testid={`place-${device.id}`}
        >
          <option value="">{t("building.noRoom")}</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {floorName(r.floorId)} · {r.name}
            </option>
          ))}
        </select>
      ) : null}
    </li>
  );
}

function InlineAdd({ label, onAdd, withKind, withLevel }: { label: string; onAdd: (name: string, extra: { kind?: RoomKind; level?: number }) => Promise<void>; withKind?: boolean; withLevel?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RoomKind>("other");
  const [level, setLevel] = useState("0");
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Button>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onAdd(name, { kind: withKind ? kind : undefined, level: withLevel ? Number(level) || 0 : undefined }).then(() => {
      setName("");
      setOpen(false);
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
      <Input aria-label={t("building.field.name")} value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-40" autoFocus />
      {withKind ? (
        <select aria-label={t("building.field.kind")} value={kind} onChange={(e) => setKind(e.target.value as RoomKind)} className="h-8 rounded-lg border border-ink-600 bg-ink-850 px-1.5 text-xs text-ink-100">
          {ROOM_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`building.roomKind.${k}` as MessageKey)}
            </option>
          ))}
        </select>
      ) : null}
      {withLevel ? <Input aria-label={t("building.field.level")} inputMode="numeric" value={level} onChange={(e) => setLevel(e.target.value.replace(/[^0-9-]/g, ""))} className="h-8 w-16" /> : null}
      <Button type="submit" size="sm" disabled={!name.trim()}>
        {t("common.save")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </Button>
    </form>
  );
}

export function BuildingPanel() {
  const { t } = useT();
  const status = useAuth((s) => s.status);
  const canEdit = useCan("building.edit");
  const devices = useHub((s) => s.devices);
  const order = useHub((s) => s.order);
  const [snap, setSnap] = useState<BuildingSnapshot | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const errorText = useAuthErrorText()(error);

  const load = useCallback(() => {
    coreClient()
      .building()
      .then((s) => {
        setSnap(s);
        setError(null);
      })
      .catch((e) => setError(toFailure(e)));
  }, []);
  useEffect(() => {
    if (status !== "signed_in") return;
    load();
    const onChange = () => load();
    window.addEventListener("se7enx:building-changed", onChange);
    return () => window.removeEventListener("se7enx:building-changed", onChange);
  }, [status, load]);

  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(load)
      .catch((e) => setError(toFailure(e)));

  const remove = (collection: "sites" | "buildings" | "floors" | "rooms", id: string, name: string) => {
    if (!window.confirm(t("building.confirmDelete", { name }))) return;
    coreClient()
      .deleteBuildingEntity(collection, id, false)
      .then(load)
      .catch((e) => {
        const f = toFailure(e);
        if (f.code === "NOT_EMPTY" && window.confirm(t("building.confirmCascade", { name }))) {
          void run(() => coreClient().deleteBuildingEntity(collection, id, true));
        } else setError(f);
      });
  };
  const rename = (collection: "sites" | "buildings" | "floors" | "rooms", id: string, current: string) => {
    const name = window.prompt(t("building.rename"), current);
    if (name && name.trim() && name !== current) void run(() => coreClient().updateBuildingEntity(collection, id, { name: name.trim() }));
  };

  const allDevices = useMemo(() => order.map((id) => devices[id]).filter((d): d is HubDevice => Boolean(d)), [order, devices]);

  if (status !== "signed_in") return <Callout tone="neutral">{t("auth.guest.note")}</Callout>;

  const sortedFloors = (buildingId: string) => (snap?.floors ?? []).filter((f) => f.buildingId === buildingId).sort((a, b) => a.level - b.level);
  const roomsOf = (floorId: string) => (snap?.rooms ?? []).filter((r) => r.floorId === floorId);
  const devicesIn = (roomId: string) => allDevices.filter((d) => d.metadata.roomId === roomId);
  const unplaced = allDevices.filter((d) => !d.metadata.roomId || !snap?.rooms.some((r) => r.id === d.metadata.roomId));

  return (
    <div className="space-y-4" data-testid="building-panel">
      <Card>
        <CardHeader
          title={t("building.title")}
          subtitle={t("building.subtitle")}
          icon={<Building2 className="h-4 w-4" />}
          actions={
            <Button size="icon" variant="ghost" onClick={load} aria-label={t("activity.refresh")}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          }
        />
        <div className="space-y-3 p-4 pt-0">
          {!canEdit ? <p className="text-xs text-ink-400">{t("building.readOnly")}</p> : null}
          {errorText ? (
            <p className="text-xs text-danger" role="alert">
              {errorText}
            </p>
          ) : null}
          {snap && snap.sites.length === 0 ? (
            <div className="space-y-3" data-testid="building-empty">
              <p className="text-sm text-ink-100">{t("building.empty")}</p>
              <p className="text-xs text-ink-300">{t("building.emptyHint")}</p>
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  {(["apartment", "house", "office"] as const).map((k) => (
                    <Button key={k} size="sm" variant="secondary" onClick={() => void run(() => coreClient().importBuilding(templateTree(k, t)))} data-testid={`template-${k}`}>
                      <MapIcon className="h-3.5 w-3.5" aria-hidden />
                      {t(`building.templates.${k}`)}
                    </Button>
                  ))}
                  <InlineAdd label={t("building.add.site")} onAdd={(name) => run(() => coreClient().createBuildingEntity("sites", { name, timezone: browserTimezone() }))} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {snap?.sites.map((site) => (
        <section key={site.id} className="space-y-3" data-testid={`site-${site.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-200">
              <MapIcon className="h-4 w-4" aria-hidden />
              <span dir="auto">{site.name}</span>
              {site.timezone ? <span className="text-[10px] font-normal normal-case text-ink-400" dir="ltr">{site.timezone}</span> : null}
            </h2>
            {canEdit ? (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("building.rename")} onClick={() => rename("sites", site.id, site.name)}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("building.delete")} onClick={() => remove("sites", site.id, site.name)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>
          {snap.buildings
            .filter((b) => b.siteId === site.id)
            .map((b) => (
              <Card key={b.id}>
                <CardHeader
                  title={<span dir="auto">{b.name}</span>}
                  subtitle={t(`building.buildingKind.${b.kind}` as MessageKey)}
                  icon={<Building2 className="h-4 w-4" />}
                  actions={
                    canEdit ? (
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("building.rename")} onClick={() => rename("buildings", b.id, b.name)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t("building.delete")} onClick={() => remove("buildings", b.id, b.name)}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    ) : null
                  }
                />
                <div className="space-y-3 p-4 pt-0">
                  {sortedFloors(b.id).map((f) => (
                    <div key={f.id} className="space-y-2 rounded-xl border border-ink-800 p-3" data-testid={`floor-${f.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="flex items-center gap-2 text-sm font-medium text-ink-100">
                          <Layers className="h-4 w-4 text-ink-400" aria-hidden />
                          <span dir="auto">{f.name}</span>
                          <span className="text-[10px] text-ink-400">{t("building.level", { n: f.level })}</span>
                        </p>
                        {canEdit ? (
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("building.rename")} onClick={() => rename("floors", f.id, f.name)}>
                              <Pencil className="h-3 w-3" aria-hidden />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("building.delete")} onClick={() => remove("floors", f.id, f.name)}>
                              <Trash2 className="h-3 w-3" aria-hidden />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {roomsOf(f.id).map((r) => {
                          const inRoom = devicesIn(r.id);
                          return (
                            <div key={r.id} className="space-y-1.5 rounded-lg bg-ink-900/60 p-2.5" data-testid={`room-${r.id}`}>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-start gap-1.5">
                                  <DoorOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden />
                                  <div className="min-w-0">
                                    <p className="break-words text-xs font-medium text-ink-100" dir="auto">
                                      {r.name}
                                    </p>
                                    <p className="text-[10px] text-ink-400">{t("building.devices", { count: inRoom.length })}</p>
                                  </div>
                                </div>
                                {canEdit ? (
                                  <div className="flex shrink-0">
                                    <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={t("building.rename")} onClick={() => rename("rooms", r.id, r.name)}>
                                      <Pencil className="h-3 w-3" aria-hidden />
                                    </Button>
                                    <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={t("building.delete")} onClick={() => remove("rooms", r.id, r.name)}>
                                      <Trash2 className="h-3 w-3" aria-hidden />
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                              {inRoom.length ? (
                                <ul className="space-y-1">
                                  {inRoom.map((d) => (
                                    <DeviceRow key={d.id} device={d} rooms={snap.rooms} floors={snap.floors} />
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-[11px] text-ink-500">{t("building.noDevices")}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {canEdit ? <InlineAdd label={t("building.add.room")} withKind onAdd={(name, x) => run(() => coreClient().createBuildingEntity("rooms", { floorId: f.id, name, kind: x.kind }))} /> : null}
                    </div>
                  ))}
                  {canEdit ? <InlineAdd label={t("building.add.floor")} withLevel onAdd={(name, x) => run(() => coreClient().createBuildingEntity("floors", { buildingId: b.id, name, level: x.level ?? 0 }))} /> : null}
                </div>
              </Card>
            ))}
          {canEdit ? <InlineAdd label={t("building.add.building")} onAdd={(name) => run(() => coreClient().createBuildingEntity("buildings", { siteId: site.id, name }))} /> : null}
        </section>
      ))}

      {snap && snap.sites.length > 0 && unplaced.length > 0 ? (
        <Card>
          <CardHeader title={t("building.unplaced")} icon={<DoorOpen className="h-4 w-4" />} />
          <ul className="space-y-1.5 p-4 pt-0" data-testid="unplaced-devices">
            {unplaced.map((d) => (
              <DeviceRow key={d.id} device={d} rooms={snap.rooms} floors={snap.floors} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
