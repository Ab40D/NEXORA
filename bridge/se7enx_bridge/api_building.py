"""Building model API: sites, buildings, floors, rooms, zones and device placement.

Reading requires ``building.view``; changes require ``building.edit``; placing a device in a room
requires ``device.configure``. Every change is recorded in the audit ledger.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query, Request
from fastapi.responses import Response
from pydantic import Field, ValidationError

from .auth import Auth, client_ip
from .core.audit import AuditLog
from .core.building import COLLECTION, INPUT, PATCH, BuildingError, BuildingService
from .core.building_model import ROOM_ID_PATTERN, BuildingImport
from .core.rbac import PERMISSIONS
from .devices.model import DEVICE_ID_PATTERN, ApiModel
from .devices.registry import DeviceRegistry
from .errors import ApiError, error_response
from .security import Session

KIND_BY_COLLECTION = {v: k for k, v in COLLECTION.items()}
CollectionPath = Path(pattern=r"^(sites|buildings|floors|rooms|zones)$")
EntityId = Path(pattern=r"^(site|bldg|floor|room|zone)-[0-9a-f]{8}$")


class RoomAssignment(ApiModel):
    room_id: str | None = Field(default=None, pattern=ROOM_ID_PATTERN)


def _validated(model: type[ApiModel] | Any, body: dict[str, Any]) -> Any:
    try:
        return model.model_validate(body)
    except ValidationError as err:
        first = err.errors()[0] if err.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", []))
        raise ApiError(
            422, "VALIDATION_ERROR", f"Invalid request{f' ({loc})' if loc else ''}: {first.get('msg', 'invalid')}"
        ) from err


def build_building_router(
    *, auth: Auth, building: BuildingService, registry: DeviceRegistry, audit: AuditLog
) -> APIRouter:
    r = APIRouter(prefix="/api/v1")
    need = {p: auth.require(p) for p in PERMISSIONS}

    def record(
        session: Session, request: Request, action: str, kind: str, entity_id: str | None, details: dict[str, Any]
    ) -> None:
        audit.record(
            action,
            actor=auth.actor(session),
            source="ui",
            ip=client_ip(request),
            target_type=kind,
            target_id=entity_id,
            details=details,
        )

    @r.get("/building")
    async def get_building(_s: Session = Depends(need["building.view"])) -> dict[str, Any]:
        return building.snapshot()

    @r.post("/building/import", status_code=201)
    async def import_building(
        body: BuildingImport, request: Request, session: Session = Depends(need["building.edit"])
    ) -> dict[str, Any]:
        result = building.import_tree(body)
        record(
            session, request, "building.imported", "building", None, {k: len(v) for k, v in result["created"].items()}
        )
        return {**result, **building.snapshot()}

    @r.post("/building/{collection}", status_code=201)
    async def create_entity(
        request: Request,
        collection: str = CollectionPath,
        body: dict[str, Any] = Body(...),
        session: Session = Depends(need["building.edit"]),
    ) -> dict[str, Any]:
        kind = KIND_BY_COLLECTION[collection]
        entity = building.create(kind, _validated(INPUT[kind], body))
        record(session, request, f"{kind}.created", kind, entity["id"], {"name": entity["name"]})
        return entity

    @r.patch("/building/{collection}/{entity_id}")
    async def update_entity(
        request: Request,
        collection: str = CollectionPath,
        entity_id: str = EntityId,
        body: dict[str, Any] = Body(...),
        session: Session = Depends(need["building.edit"]),
    ) -> dict[str, Any]:
        kind = KIND_BY_COLLECTION[collection]
        patch = _validated(PATCH[kind], body)
        entity = building.update(kind, entity_id, patch)
        record(
            session, request, f"{kind}.updated", kind, entity_id, patch.model_dump(exclude_unset=True, by_alias=True)
        )
        return entity

    @r.delete("/building/{collection}/{entity_id}")
    async def delete_entity(
        request: Request,
        collection: str = CollectionPath,
        entity_id: str = EntityId,
        cascade: bool = Query(False),
        session: Session = Depends(need["building.edit"]),
    ) -> dict[str, Any]:
        kind = KIND_BY_COLLECTION[collection]
        result = building.delete(kind, entity_id, cascade=cascade)
        record(session, request, f"{kind}.deleted", kind, entity_id, {"cascade": cascade, **result})
        return result

    @r.put("/devices/{device_id}/room")
    async def place_device(
        body: RoomAssignment,
        request: Request,
        device_id: str = Path(pattern=DEVICE_ID_PATTERN, max_length=48),
        session: Session = Depends(need["device.configure"]),
    ) -> dict[str, Any]:
        room_id = building.assignable_room(body.room_id)
        device = registry.set_room(device_id, room_id)
        record(session, request, "device.placed", "device", device_id, {"roomId": room_id})
        return device

    return r


def building_exception_handlers() -> dict[type[Exception], Callable[[Any, Exception], Awaitable[Response]]]:
    async def on_building(_r: Any, e: Exception) -> Response:
        assert isinstance(e, BuildingError)
        return error_response(e.status, e.code, e.message, e.hint)

    return {BuildingError: on_building}
