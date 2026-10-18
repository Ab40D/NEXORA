"""Building model service: validated changes to sites, buildings, floors, rooms and zones.

Rules:
* Every child references an existing parent; names are unique among siblings (case-insensitive).
* Deleting an entity that still has children is refused (409 ``NOT_EMPTY``) unless ``cascade``
  is requested. A cascade removes the descendants, takes the deleted rooms out of zones and
  un-assigns devices from them. Devices themselves are never deleted.
* Imports (templates, Studio) are validated completely before anything is written, so an import
  either applies in full or not at all.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from typing import Any, Protocol

from pydantic import BaseModel

from .building_model import (
    PREFIX,
    Building,
    BuildingImport,
    BuildingInput,
    BuildingModel,
    BuildingPatch,
    Floor,
    FloorInput,
    FloorPatch,
    Room,
    RoomInput,
    RoomPatch,
    Site,
    SiteInput,
    SitePatch,
    Zone,
    ZoneInput,
    ZonePatch,
)

KINDS = ("site", "building", "floor", "room", "zone")
COLLECTION = {"site": "sites", "building": "buildings", "floor": "floors", "room": "rooms", "zone": "zones"}
INPUT: dict[str, type[BaseModel]] = {
    "site": SiteInput,
    "building": BuildingInput,
    "floor": FloorInput,
    "room": RoomInput,
    "zone": ZoneInput,
}
PATCH: dict[str, type[BaseModel]] = {
    "site": SitePatch,
    "building": BuildingPatch,
    "floor": FloorPatch,
    "room": RoomPatch,
    "zone": ZonePatch,
}
MODEL: dict[str, type[BaseModel]] = {"site": Site, "building": Building, "floor": Floor, "room": Room, "zone": Zone}


class BuildingError(Exception):
    def __init__(self, status: int, code: str, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint


class ModelStore(Protocol):
    def get_building(self) -> BuildingModel: ...
    def set_building(self, model: BuildingModel) -> None: ...


class DevicePlacement(Protocol):
    def placement(self) -> dict[str, list[str]]: ...
    def clear_rooms(self, room_ids: set[str]) -> int: ...


def new_id(kind: str) -> str:
    return f"{PREFIX[kind]}-{secrets.token_hex(4)}"


def _dump(entity: BaseModel) -> dict[str, Any]:
    return entity.model_dump(mode="json", by_alias=True, exclude_none=True)


class BuildingService:
    def __init__(
        self, store: ModelStore, devices: DevicePlacement, on_change: Callable[[], None] | None = None
    ) -> None:
        self.store = store
        self.devices = devices
        self.on_change = on_change

    # ------------------------------------------------------------------ queries

    @property
    def model(self) -> BuildingModel:
        return self.store.get_building()

    def snapshot(self) -> dict[str, Any]:
        m = self.model
        placement = self.devices.placement()
        known_rooms = {r.id for r in m.rooms}
        return {
            "sites": [_dump(s) for s in m.sites],
            "buildings": [_dump(b) for b in m.buildings],
            "floors": [_dump(f) for f in sorted(m.floors, key=lambda f: (f.building_id, f.level, f.name.casefold()))],
            "rooms": [_dump(r) for r in m.rooms],
            "zones": [_dump(z) for z in m.zones],
            "placement": {room: ids for room, ids in placement.items() if room in known_rooms},
        }

    def find(self, kind: str, entity_id: str) -> Any:
        for e in getattr(self.model, COLLECTION[kind]):
            if e.id == entity_id:
                return e
        return None

    def require(self, kind: str, entity_id: str) -> Any:
        e = self.find(kind, entity_id)
        if e is None:
            raise BuildingError(404, "NOT_FOUND", f"No {kind} with id {entity_id!r}.")
        return e

    def room_path(self, room_id: str) -> dict[str, Any] | None:
        """Room → floor → building → site, for display and for the assistant."""
        m = self.model
        room = next((r for r in m.rooms if r.id == room_id), None)
        if room is None:
            return None
        floor = next((f for f in m.floors if f.id == room.floor_id), None)
        building = next((b for b in m.buildings if floor and b.id == floor.building_id), None)
        site = next((s for s in m.sites if building and s.id == building.site_id), None)
        return {
            "room": _dump(room),
            "floor": _dump(floor) if floor else None,
            "building": _dump(building) if building else None,
            "site": _dump(site) if site else None,
        }

    # ------------------------------------------------------------------ validation helpers

    def _parent_key(self, kind: str) -> tuple[str, str] | None:
        return {
            "building": ("site", "site_id"),
            "floor": ("building", "building_id"),
            "room": ("floor", "floor_id"),
            "zone": ("building", "building_id"),
        }.get(kind)

    def _siblings(self, m: BuildingModel, kind: str, entity: Any) -> list[Any]:
        items = getattr(m, COLLECTION[kind])
        parent = self._parent_key(kind)
        if parent is None:
            return [e for e in items if e.id != entity.id]
        attr = parent[1]
        return [e for e in items if e.id != entity.id and getattr(e, attr) == getattr(entity, attr)]

    def _check(self, m: BuildingModel, kind: str, entity: Any) -> None:
        parent = self._parent_key(kind)
        if parent is not None:
            pkind, attr = parent
            if not any(p.id == getattr(entity, attr) for p in getattr(m, COLLECTION[pkind])):
                raise BuildingError(422, "PARENT_NOT_FOUND", f"The {pkind} {getattr(entity, attr)!r} does not exist.")
        if any(s.name.casefold() == entity.name.casefold() for s in self._siblings(m, kind, entity)):
            raise BuildingError(409, "NAME_TAKEN", f"A {kind} named {entity.name!r} already exists here.")
        if kind == "zone":
            floors = {f.id for f in m.floors if f.building_id == entity.building_id}
            rooms = {r.id for r in m.rooms if r.floor_id in floors}
            unknown = [rid for rid in entity.room_ids if rid not in rooms]
            if unknown:
                raise BuildingError(422, "ROOM_NOT_IN_BUILDING", f"Rooms not in this building: {', '.join(unknown)}.")
            entity.room_ids = list(dict.fromkeys(entity.room_ids))
        if kind == "room":
            old = next((r for r in m.rooms if r.id == entity.id), None)
            if old is not None and old.floor_id != entity.floor_id:
                floor_bldg = {f.id: f.building_id for f in m.floors}
                if floor_bldg.get(old.floor_id) != floor_bldg.get(entity.floor_id):
                    raise BuildingError(
                        422, "MOVE_ACROSS_BUILDINGS", "Rooms can only move between floors of the same building."
                    )

    def _commit(self, m: BuildingModel) -> None:
        validated = BuildingModel.model_validate(m.model_dump())  # enforces list limits
        self.store.set_building(validated)
        if self.on_change:
            self.on_change()

    # ------------------------------------------------------------------ changes

    def create(self, kind: str, data: BaseModel) -> dict[str, Any]:
        m = self.model.model_copy(deep=True)
        entity = MODEL[kind].model_validate({"id": new_id(kind), **data.model_dump()})
        self._check(m, kind, entity)
        getattr(m, COLLECTION[kind]).append(entity)
        self._commit(m)
        return _dump(entity)

    def update(self, kind: str, entity_id: str, patch: BaseModel) -> dict[str, Any]:
        m = self.model.model_copy(deep=True)
        items = getattr(m, COLLECTION[kind])
        index = next((i for i, e in enumerate(items) if e.id == entity_id), None)
        if index is None:
            raise BuildingError(404, "NOT_FOUND", f"No {kind} with id {entity_id!r}.")
        changes = patch.model_dump(exclude_unset=True)
        updated = MODEL[kind].model_validate({**items[index].model_dump(), **changes})
        self._check(m, kind, updated)
        items[index] = updated
        self._commit(m)
        return _dump(updated)

    def _descendants(self, m: BuildingModel, kind: str, entity_id: str) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {k: set() for k in KINDS}
        out[kind].add(entity_id)
        if kind == "site":
            out["building"] |= {b.id for b in m.buildings if b.site_id == entity_id}
        if kind in ("site", "building"):
            out["floor"] |= {f.id for f in m.floors if f.building_id in out["building"]}
            out["zone"] |= {z.id for z in m.zones if z.building_id in out["building"]}
        if kind in ("site", "building", "floor"):
            out["room"] |= {r.id for r in m.rooms if r.floor_id in out["floor"]}
        return out

    def delete(self, kind: str, entity_id: str, *, cascade: bool = False) -> dict[str, Any]:
        m = self.model.model_copy(deep=True)
        if self.find(kind, entity_id) is None:
            raise BuildingError(404, "NOT_FOUND", f"No {kind} with id {entity_id!r}.")
        doomed = self._descendants(m, kind, entity_id)
        children = sum(len(v) for k, v in doomed.items() if k != kind) if kind != "zone" else 0
        if children and not cascade:
            raise BuildingError(
                409,
                "NOT_EMPTY",
                f"This {kind} still contains {children} item(s).",
                "Delete or move them first, or confirm deleting everything inside.",
            )
        for k, ids in doomed.items():
            setattr(m, COLLECTION[k], [e for e in getattr(m, COLLECTION[k]) if e.id not in ids])
        for zone in m.zones:
            zone.room_ids = [rid for rid in zone.room_ids if rid not in doomed["room"]]
        unassigned = self.devices.clear_rooms(doomed["room"]) if doomed["room"] else 0
        self._commit(m)
        return {"deleted": {COLLECTION[k]: len(v) for k, v in doomed.items() if v}, "unassignedDevices": unassigned}

    def import_tree(self, tree: BuildingImport) -> dict[str, Any]:
        m = self.model.model_copy(deep=True)
        created: dict[str, list[str]] = {c: [] for c in COLLECTION.values()}
        for site_tree in tree.sites:
            if site_tree.id is not None:
                if not any(s.id == site_tree.id for s in m.sites):
                    raise BuildingError(422, "PARENT_NOT_FOUND", f"The site {site_tree.id!r} does not exist.")
                site_id = site_tree.id
            else:
                if site_tree.name is None:
                    raise BuildingError(422, "VALIDATION_ERROR", "A new site needs a name.")
                site = Site(
                    id=new_id("site"), name=site_tree.name, timezone=site_tree.timezone, address=site_tree.address
                )
                self._check(m, "site", site)
                m.sites.append(site)
                created["sites"].append(site.id)
                site_id = site.id
            for b_tree in site_tree.buildings:
                building = Building(id=new_id("building"), site_id=site_id, name=b_tree.name, kind=b_tree.kind)
                self._check(m, "building", building)
                m.buildings.append(building)
                created["buildings"].append(building.id)
                for f_tree in b_tree.floors:
                    floor = Floor(id=new_id("floor"), building_id=building.id, name=f_tree.name, level=f_tree.level)
                    self._check(m, "floor", floor)
                    m.floors.append(floor)
                    created["floors"].append(floor.id)
                    for r_tree in f_tree.rooms:
                        room = Room(
                            id=new_id("room"),
                            floor_id=floor.id,
                            name=r_tree.name,
                            kind=r_tree.kind,
                            aliases=r_tree.aliases,
                        )
                        self._check(m, "room", room)
                        m.rooms.append(room)
                        created["rooms"].append(room.id)
        self._commit(m)
        return {"created": {k: v for k, v in created.items() if v}}

    def assignable_room(self, room_id: str | None) -> str | None:
        if room_id is not None and self.find("room", room_id) is None:
            raise BuildingError(422, "ROOM_NOT_FOUND", f"The room {room_id!r} does not exist.")
        return room_id
