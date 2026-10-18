"""Building model: sites, buildings, floors, rooms, zones, device placement, import, persistence."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app

from .accounts import Api, account_settings, add_sim_light, owner_api, user_api


def build_home(api: Api) -> dict[str, str]:
    site = api.post("/building/sites", {"name": "Home", "timezone": "Africa/Algiers"}).json()
    house = api.post("/building/buildings", {"siteId": site["id"], "name": "House", "kind": "residential"}).json()
    ground = api.post("/building/floors", {"buildingId": house["id"], "name": "Ground floor", "level": 0}).json()
    first = api.post("/building/floors", {"buildingId": house["id"], "name": "First floor", "level": 1}).json()
    living = api.post(
        "/building/rooms",
        {"floorId": ground["id"], "name": "Living room", "kind": "living", "aliases": ["Salon", "الصالون"]},
    ).json()
    bedroom = api.post("/building/rooms", {"floorId": first["id"], "name": "Bedroom", "kind": "bedroom"}).json()
    return {
        "site": site["id"],
        "house": house["id"],
        "ground": ground["id"],
        "first": first["id"],
        "living": living["id"],
        "bedroom": bedroom["id"],
    }


def test_create_hierarchy_validate_names_and_parents() -> None:
    with TestClient(create_app(account_settings())) as c:
        api = owner_api(c)
        ids = build_home(api)
        snap = api.get("/building").json()
        assert [f["name"] for f in snap["floors"]] == ["Ground floor", "First floor"]  # sorted by level
        room = next(r for r in snap["rooms"] if r["id"] == ids["living"])
        assert room["aliases"] == ["Salon", "الصالون"] and room["kind"] == "living"

        dup = api.post("/building/rooms", {"floorId": ids["ground"], "name": "living ROOM"})
        assert dup.status_code == 409 and dup.json()["error"]["code"] == "NAME_TAKEN"
        assert api.post("/building/rooms", {"floorId": ids["first"], "name": "Living room"}).status_code == 201
        orphan = api.post("/building/rooms", {"floorId": "floor-00000000", "name": "X"})
        assert orphan.status_code == 422 and orphan.json()["error"]["code"] == "PARENT_NOT_FOUND"
        bad_tz = api.post("/building/sites", {"name": "Office", "timezone": "Mars/Olympus"})
        assert bad_tz.status_code == 422
        renamed = api.patch(f"/building/rooms/{ids['living']}", {"name": "Lounge", "aliases": []})
        assert renamed.status_code == 200 and renamed.json()["name"] == "Lounge" and renamed.json()["aliases"] == []


def test_zones_only_contain_rooms_of_their_building() -> None:
    with TestClient(create_app(account_settings())) as c:
        api = owner_api(c)
        ids = build_home(api)
        zone = api.post(
            "/building/zones",
            {
                "buildingId": ids["house"],
                "name": "All lights",
                "kind": "lighting",
                "roomIds": [ids["living"], ids["living"], ids["bedroom"]],
            },
        )
        assert zone.status_code == 201 and zone.json()["roomIds"] == [ids["living"], ids["bedroom"]]
        other = api.post("/building/buildings", {"siteId": ids["site"], "name": "Garage block"}).json()
        bad = api.post("/building/zones", {"buildingId": other["id"], "name": "Z", "roomIds": [ids["living"]]})
        assert bad.status_code == 422 and bad.json()["error"]["code"] == "ROOM_NOT_IN_BUILDING"


def test_device_placement_and_cascade_delete() -> None:
    with TestClient(create_app(account_settings())) as c:
        api = owner_api(c)
        ids = build_home(api)
        add_sim_light(api, "lamp")
        api.post("/building/zones", {"buildingId": ids["house"], "name": "Night", "roomIds": [ids["bedroom"]]})
        placed = api.put("/devices/lamp/room", {"roomId": ids["bedroom"]})
        assert placed.status_code == 200 and placed.json()["metadata"]["roomId"] == ids["bedroom"]
        assert api.get("/building").json()["placement"] == {ids["bedroom"]: ["lamp"]}
        assert api.put("/devices/lamp/room", {"roomId": "room-00000000"}).json()["error"]["code"] == "ROOM_NOT_FOUND"

        refused = api.delete(f"/building/floors/{ids['first']}")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "NOT_EMPTY"
        done = api.delete(f"/building/floors/{ids['first']}", params={"cascade": "true"})
        assert done.status_code == 200 and done.json() == {"deleted": {"floors": 1, "rooms": 1}, "unassignedDevices": 1}
        assert "roomId" not in api.get("/devices/lamp").json()["metadata"]
        snap = api.get("/building").json()
        assert snap["zones"][0]["roomIds"] == [] and snap["placement"] == {}
        assert api.get("/devices").json()["devices"][0]["id"] == "lamp"  # devices are never deleted


def test_import_is_atomic() -> None:
    with TestClient(create_app(account_settings())) as c:
        api = owner_api(c)
        tree: dict[str, Any] = {
            "sites": [
                {
                    "name": "Office",
                    "timezone": "Europe/Paris",
                    "buildings": [
                        {
                            "name": "HQ",
                            "kind": "commercial",
                            "floors": [
                                {
                                    "name": "Level 0",
                                    "level": 0,
                                    "rooms": [
                                        {"name": "Reception", "kind": "entrance"},
                                        {"name": "Meeting room", "kind": "meeting"},
                                    ],
                                },
                                {"name": "Level 1", "level": 1, "rooms": [{"name": "Open space", "kind": "office"}]},
                            ],
                        }
                    ],
                }
            ]
        }
        r = api.post("/building/import", tree)
        assert r.status_code == 201, r.text
        assert {k: len(v) for k, v in r.json()["created"].items()} == {
            "sites": 1,
            "buildings": 1,
            "floors": 2,
            "rooms": 3,
        }
        tree["sites"][0]["name"] = "Office 2"
        tree["sites"][0]["buildings"][0]["floors"][1]["rooms"].append({"name": "OPEN SPACE"})  # duplicate → rejected
        bad = api.post("/building/import", tree)
        assert bad.status_code == 409
        assert [s["name"] for s in api.get("/building").json()["sites"]] == ["Office"]  # nothing written


def test_building_permissions() -> None:
    with TestClient(create_app(account_settings())) as c:
        owner = owner_api(c)
        ids = build_home(owner)
        add_sim_light(owner)
        tech = user_api(c, owner, "technician")
        assert tech.get("/building").status_code == 200
        assert tech.post("/building/rooms", {"floorId": ids["ground"], "name": "Hall"}).status_code == 403
        assert tech.put("/devices/lamp/room", {"roomId": ids["living"]}).status_code == 403
        eng = user_api(c, owner, "engineer")
        assert eng.put("/devices/lamp/room", {"roomId": ids["living"]}).status_code == 200


def test_building_and_placement_persist_and_v1_configs_upgrade(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(
        json.dumps(
            {"version": 1, "devices": [{"integration": "simulated", "id": "lamp", "name": "Lamp", "type": "light"}]}
        )
    )
    with TestClient(create_app(account_settings(tmp_path))) as c:
        api = owner_api(c)
        assert api.get("/devices").json()["devices"][0]["id"] == "lamp"
        ids = build_home(api)
        api.put("/devices/lamp/room", {"roomId": ids["living"]})
        token = api.token
    saved = json.loads((tmp_path / "config.json").read_text())
    assert saved["version"] == 2 and len(saved["building"]["rooms"]) == 2
    assert saved["devices"][0]["metadata"]["roomId"] == ids["living"]
    with TestClient(create_app(account_settings(tmp_path))) as c:
        snap = Api(c, token).get("/building").json()
        assert snap["placement"] == {ids["living"]: ["lamp"]}
