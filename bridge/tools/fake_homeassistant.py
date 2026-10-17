"""FAKE Home Assistant (WebSocket API subset + REST ping) for tests and demos. NOT a real HA.

Implements the messages SE7ENX uses: ``auth_required`` / ``auth`` / ``auth_ok`` / ``auth_invalid``,
``get_states``, ``get_config``, ``subscribe_events`` (``state_changed``), ``call_service`` and
``ping``. Service calls change the fake entity states and emit ``state_changed`` events like HA
does. Controls let tests drop connections, suppress feedback or fail services.

    python tools/fake_homeassistant.py --port 8123 --token dev-token
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

HA_VERSION = "2026.10.0-fake"


def default_entities() -> dict[str, dict[str, Any]]:
    return {
        "light.kitchen": {
            "state": "off",
            "attributes": {
                "friendly_name": "FAKE Kitchen",
                "supported_color_modes": ["brightness"],
                "brightness": None,
            },
        },
        "light.porch": {
            "state": "on",
            "attributes": {"friendly_name": "FAKE Porch", "supported_color_modes": ["onoff"]},
        },
        "switch.fan": {"state": "off", "attributes": {"friendly_name": "FAKE Fan"}},
        "cover.garage": {
            "state": "closed",
            "attributes": {"friendly_name": "FAKE Garage", "current_position": 0, "supported_features": 15},
        },
        "sensor.hall_temperature": {
            "state": "21.4",
            "attributes": {
                "friendly_name": "FAKE Hall temperature",
                "unit_of_measurement": "°C",
                "device_class": "temperature",
            },
        },
        "lock.front_door": {"state": "locked", "attributes": {"friendly_name": "FAKE Front door"}},
    }


class FakeHomeAssistant:
    def __init__(self, token: str = "fake-token", entities: dict[str, dict[str, Any]] | None = None) -> None:
        self.token = token
        self.entities = entities or default_entities()
        self.emit_feedback = True  # set False: services succeed but no state_changed arrives
        self.fail_services = False
        self.brightness_override: int | None = None  # a light that clamps/limits brightness
        self.calls: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = []
        self.auth_attempts = 0
        self._clients: set[WebSocket] = set()
        self._subs: dict[WebSocket, int] = {}
        self.app = Starlette(
            routes=[
                WebSocketRoute("/api/websocket", self._ws),
                Route("/api/", self._rest_root),
                # test controls (FAKE only, not part of Home Assistant)
                Route("/_fake/drop", self._ctl_drop, methods=["POST"]),
                Route("/_fake/state", self._ctl_state, methods=["POST"]),
                Route("/_fake/options", self._ctl_options, methods=["POST"]),
                Route("/_fake/info", self._ctl_info),
            ]
        )

    async def _ctl_drop(self, _r: Request) -> JSONResponse:
        await self.drop_connections()
        return JSONResponse({"dropped": True})

    async def _ctl_state(self, r: Request) -> JSONResponse:
        body = await r.json()
        await self.set_state(body["entity_id"], body["state"], **(body.get("attributes") or {}))
        return JSONResponse({"ok": True})

    async def _ctl_options(self, r: Request) -> JSONResponse:
        body = await r.json()
        self.emit_feedback = bool(body.get("emit_feedback", self.emit_feedback))
        self.fail_services = bool(body.get("fail_services", self.fail_services))
        if "brightness_override" in body:
            self.brightness_override = body["brightness_override"]
        return JSONResponse({"ok": True})

    async def _ctl_info(self, _r: Request) -> JSONResponse:
        return JSONResponse({"calls": self.calls, "auth_attempts": self.auth_attempts, "clients": len(self._clients)})

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self.app(scope, receive, send)

    def state(self, entity_id: str) -> dict[str, Any]:
        e = self.entities[entity_id]
        return {
            "entity_id": entity_id,
            "state": e["state"],
            "attributes": copy.deepcopy(e["attributes"]),
            "last_changed": "2026-10-17T10:00:00+00:00",
            "last_updated": "2026-10-17T10:00:00+00:00",
            "context": {"id": "fake"},
        }

    async def drop_connections(self) -> None:
        """Simulate a Home Assistant restart: close every WebSocket."""
        for ws in list(self._clients):
            with contextlib.suppress(Exception):
                await ws.close(code=1012)

    async def set_state(self, entity_id: str, state: str, **attributes: Any) -> None:
        old = self.state(entity_id)
        self.entities[entity_id]["state"] = state
        self.entities[entity_id]["attributes"].update(attributes)
        new = self.state(entity_id)
        for ws, sub_id in list(self._subs.items()):
            with contextlib.suppress(Exception):
                await ws.send_json(
                    {
                        "id": sub_id,
                        "type": "event",
                        "event": {
                            "event_type": "state_changed",
                            "data": {"entity_id": entity_id, "old_state": old, "new_state": new},
                        },
                    }
                )

    async def _rest_root(self, request: Request) -> JSONResponse:
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return JSONResponse({"message": "Unauthorized"}, status_code=401)
        return JSONResponse({"message": "API running."})

    async def _ws(self, ws: WebSocket) -> None:
        await ws.accept()
        await ws.send_json({"type": "auth_required", "ha_version": HA_VERSION})
        try:
            msg = await ws.receive_json()
            self.auth_attempts += 1
            if msg.get("type") != "auth" or msg.get("access_token") != self.token:
                await ws.send_json({"type": "auth_invalid", "message": "Invalid access token or password"})
                await ws.close()
                return
            await ws.send_json({"type": "auth_ok", "ha_version": HA_VERSION})
            self._clients.add(ws)
            while True:
                msg = await ws.receive_json()
                await self._handle(ws, msg)
        except WebSocketDisconnect:
            pass
        finally:
            self._clients.discard(ws)
            self._subs.pop(ws, None)

    async def _handle(self, ws: WebSocket, msg: dict[str, Any]) -> None:
        mid, typ = msg.get("id"), msg.get("type")
        if typ == "ping":
            await ws.send_json({"id": mid, "type": "pong"})
        elif typ == "get_states":
            await ws.send_json(
                {"id": mid, "type": "result", "success": True, "result": [self.state(e) for e in self.entities]}
            )
        elif typ == "get_config":
            await ws.send_json(
                {
                    "id": mid,
                    "type": "result",
                    "success": True,
                    "result": {"version": HA_VERSION, "location_name": "FAKE Home"},
                }
            )
        elif typ == "subscribe_events":
            self._subs[ws] = mid
            await ws.send_json({"id": mid, "type": "result", "success": True, "result": None})
        elif typ == "call_service":
            await self._call_service(ws, mid, msg)
        else:
            await ws.send_json(
                {
                    "id": mid,
                    "type": "result",
                    "success": False,
                    "error": {"code": "unknown_command", "message": f"Unknown command {typ}"},
                }
            )

    async def _call_service(self, ws: WebSocket, mid: int, msg: dict[str, Any]) -> None:
        domain, service = msg.get("domain", ""), msg.get("service", "")
        data, target = msg.get("service_data") or {}, msg.get("target") or {}
        self.calls.append((domain, service, data, target))
        entity_id = target.get("entity_id")
        if self.fail_services:
            await ws.send_json(
                {
                    "id": mid,
                    "type": "result",
                    "success": False,
                    "error": {"code": "home_assistant_error", "message": "FAKE failure"},
                }
            )
            return
        if entity_id not in self.entities or not entity_id.startswith(f"{domain}."):
            await ws.send_json(
                {
                    "id": mid,
                    "type": "result",
                    "success": False,
                    "error": {"code": "not_found", "message": f"Entity {entity_id} not found"},
                }
            )
            return
        await ws.send_json(
            {"id": mid, "type": "result", "success": True, "result": {"context": {"id": "fake"}, "response": None}}
        )
        if not self.emit_feedback:
            return
        await asyncio.sleep(0.05)
        e = self.entities[entity_id]
        if domain in ("light", "switch", "input_boolean"):
            on = {"turn_on": True, "turn_off": False}.get(service, e["state"] != "on")
            attrs: dict[str, Any] = {}
            if domain == "light" and "brightness" in e["attributes"]:
                pct = data.get("brightness_pct", 100 if on else None)
                if on and self.brightness_override is not None:
                    pct = self.brightness_override
                attrs["brightness"] = round(pct * 255 / 100) if on and pct is not None else None
            await self.set_state(entity_id, "on" if on else "off", **attrs)
        elif domain == "cover":
            pos = {"open_cover": 100, "close_cover": 0}.get(
                service, data.get("position", e["attributes"].get("current_position"))
            )
            if service == "stop_cover":
                pos = e["attributes"].get("current_position")
            await self.set_state(entity_id, "open" if pos and pos > 0 else "closed", current_position=pos)


def main() -> None:  # pragma: no cover - manual demo helper
    import uvicorn

    parser = argparse.ArgumentParser(description="Run a FAKE Home Assistant (not a real HA)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    uvicorn.run(FakeHomeAssistant(token=args.token), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
