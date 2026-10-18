"""Protocol-level FAKE Shelly devices (Gen1 HTTP API and Gen2+ JSON-RPC) for tests and demos.

Built from the official local API documentation (shelly-api-docs.shelly.cloud):
* Gen1: ``GET /shelly``, ``/status``, ``/settings``, ``/relay/N``, ``/light/N``, ``/roller/N``,
  optional HTTP Basic auth.
* Gen2+: ``GET /shelly``, ``POST /rpc`` JSON-RPC frames, optional digest auth (SHA-256,
  user ``admin``, realm = device id). ``/shelly`` and ``Shelly.GetDeviceInfo`` stay unauthenticated.

These fakes are NOT real hardware. Their device names start with "FAKE" so they cannot be mistaken
for a real device. Run one for manual testing:

    python tools/fake_shelly.py --gen 2 --switches 2 --port 8081 [--password secret]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import secrets
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _parse_digest(header: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in header[len("Digest ") :].split(","):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


class FakeShellyGen2:
    """Gen2+ device (Plus/Pro/Gen3/Gen4 share this RPC model)."""

    def __init__(
        self,
        *,
        model: str = "SNSW-102P16EU",
        app: str = "Plus2PM",
        gen: int = 2,
        device_id: str = "shellyplus2pm-fake000001",
        password: str | None = None,
        switches: int = 0,
        lights: int = 0,
        covers: int = 0,
        metering: bool = True,
        pos_control: bool = True,
        dim_methods: bool = True,
        extra_components: tuple[str, ...] = (),
        profile: str | None = None,
    ) -> None:
        self.model, self.app, self.gen, self.device_id = model, app, gen, device_id
        self.profile = profile  # multi-profile devices (e.g. 2PM: "switch" / "cover") report it in GetDeviceInfo
        self.password = password
        self.metering = metering
        self.dim_methods = dim_methods
        self.nonce = base64.b64encode(secrets.token_bytes(12)).decode()
        self.requests: list[str] = []
        self.status: dict[str, dict[str, Any]] = {}
        for i in range(switches):
            st: dict[str, Any] = {"id": i, "source": "init", "output": False}
            if metering:
                st.update(
                    apower=0.0,
                    voltage=230.4,
                    current=0.0,
                    aenergy={"total": 1234.5, "by_minute": [0, 0, 0], "minute_ts": 0},
                )
            st["temperature"] = {"tC": 41.2, "tF": 106.2}
            self.status[f"switch:{i}"] = st
        for i in range(lights):
            st = {"id": i, "source": "init", "output": False, "brightness": 50}
            if metering:
                st.update(apower=0.0, aenergy={"total": 10.0, "by_minute": [0, 0, 0], "minute_ts": 0})
            self.status[f"light:{i}"] = st
        for i in range(covers):
            st = {"id": i, "source": "init", "state": "stopped", "pos_control": pos_control, "last_direction": None}
            if pos_control:
                st["current_pos"] = 50
            if metering:
                st.update(apower=0.0, aenergy={"total": 48.9, "by_minute": [0, 0, 0], "minute_ts": 0})
            self.status[f"cover:{i}"] = st
        for comp in extra_components:  # e.g. "input:0", "rgb:0": present but not controllable here
            self.status[comp] = {"id": int(comp.split(":")[1])}
        self.app_asgi = Starlette(routes=[Route("/shelly", self._shelly), Route("/rpc", self._rpc, methods=["POST"])])

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self.app_asgi(scope, receive, send)

    # ------------------------------------------------------------------ helpers

    def info(self) -> dict[str, Any]:
        return {
            "name": None,
            "id": self.device_id,
            "mac": self.device_id.split("-")[-1].upper(),
            "slot": 0,
            "model": self.model,
            "gen": self.gen,
            "fw_id": "20260901-000000/1.7.1-fake",
            "ver": "1.7.1",
            "app": self.app,
            "auth_en": self.password is not None,
            "auth_domain": self.device_id if self.password else None,
            **({"profile": self.profile} if self.profile else {}),
        }

    def _challenge(self) -> Response:
        return Response(
            status_code=401,
            headers={
                "WWW-Authenticate": f'Digest qop="auth", realm="{self.device_id}", nonce="{self.nonce}", algorithm=SHA-256'
            },
        )

    def _authorized(self, request: Request) -> bool:
        if self.password is None:
            return True
        header = request.headers.get("authorization", "")
        if not header.startswith("Digest "):
            return False
        d = _parse_digest(header)
        if d.get("username") != "admin" or d.get("realm") != self.device_id or d.get("nonce") != self.nonce:
            return False
        ha1 = _sha256(f"admin:{self.device_id}:{self.password}")
        ha2 = _sha256(f"{request.method}:{d.get('uri', '')}")
        expected = _sha256(f"{ha1}:{d['nonce']}:{d.get('nc', '')}:{d.get('cnonce', '')}:{d.get('qop', '')}:{ha2}")
        return secrets.compare_digest(expected, d.get("response", ""))

    def methods(self) -> list[str]:
        names = ["Shelly.GetDeviceInfo", "Shelly.GetStatus", "Shelly.GetConfig", "Shelly.ListMethods"]
        kinds = {k.split(":")[0] for k in self.status}
        if "switch" in kinds:
            names += ["Switch.Set", "Switch.Toggle", "Switch.GetStatus"]
        if "light" in kinds:
            names += ["Light.Set", "Light.Toggle", "Light.GetStatus"]
            if self.dim_methods:
                names += ["Light.DimUp", "Light.DimDown", "Light.DimStop"]
        if "cover" in kinds:
            names += ["Cover.Open", "Cover.Close", "Cover.Stop", "Cover.GoToPosition", "Cover.GetStatus"]
        return names

    def advance_covers(self) -> None:
        """Finish any cover movement (as if the motor reached its target)."""
        for key, st in self.status.items():
            if key.startswith("cover:") and st["state"] in ("opening", "closing"):
                target = st.pop("target_pos", 100 if st["state"] == "opening" else 0)
                if st.get("pos_control"):
                    st["current_pos"] = target
                st["state"] = "open" if target == 100 else "closed" if target == 0 else "stopped"

    # ------------------------------------------------------------------ routes

    async def _shelly(self, _request: Request) -> JSONResponse:
        self.requests.append("GET /shelly")
        return JSONResponse(self.info())

    async def _rpc(self, request: Request) -> Response:
        frame = await request.json()
        method, params, rid = frame.get("method"), frame.get("params") or {}, frame.get("id")
        if method != "Shelly.GetDeviceInfo" and not self._authorized(request):
            return self._challenge()
        self.requests.append(f"{method} {params}")
        try:
            result = self._dispatch(method, params)
        except _RpcError as err:
            return JSONResponse({"id": rid, "src": self.device_id, "error": {"code": err.code, "message": err.message}})
        return JSONResponse({"id": rid, "src": self.device_id, "result": result})

    def _component(self, kind: str, params: dict[str, Any]) -> dict[str, Any]:
        cid = params.get("id")
        st = self.status.get(f"{kind}:{cid}")
        if st is None:
            raise _RpcError(-105, f"Argument 'id', value {cid} not found!")
        return st

    def _dispatch(self, method: str, p: dict[str, Any]) -> Any:
        if method not in self.methods():
            raise _RpcError(404, f"No handler for {method}")
        if method == "Shelly.GetDeviceInfo":
            return self.info()
        if method == "Shelly.GetStatus":
            return {**{k: dict(v) for k, v in self.status.items()}, "sys": {"uptime": 1234}}
        if method == "Shelly.ListMethods":
            return {"methods": self.methods()}
        if method == "Shelly.GetConfig":
            return {}
        kind, action = method.split(".")
        st = self._component(kind.lower(), p)
        if action == "GetStatus":
            return dict(st)
        if kind == "Switch":
            was = st["output"]
            st["output"] = (not was) if action == "Toggle" else bool(p["on"])
            st["source"] = "HTTP_in"
            if self.metering:
                st["apower"] = 61.5 if st["output"] else 0.0
            return {"was_on": was}
        if kind == "Light":
            was = st["output"]
            if action == "Toggle":
                st["output"] = not was
            elif action == "Set":
                if "on" in p:
                    st["output"] = bool(p["on"])
                if "brightness" in p:
                    st["brightness"] = int(p["brightness"])
            elif action == "DimUp":
                st["brightness"] = min(100, st["brightness"] + 10)
            elif action == "DimDown":
                st["brightness"] = max(0, st["brightness"] - 10)
            return {"was_on": was} if action in ("Set", "Toggle") else None
        if kind == "Cover":
            if action == "Open":
                st["state"], st["last_direction"] = "opening", "open"
            elif action == "Close":
                st["state"], st["last_direction"] = "closing", "close"
            elif action == "Stop":
                st["state"] = "stopped"
            elif action == "GoToPosition":
                if not st.get("pos_control"):
                    raise _RpcError(-103, "Cover is not calibrated!")
                pos = int(p["pos"])
                st["target_pos"] = pos
                st["state"] = "opening" if pos >= st.get("current_pos", 0) else "closing"
            return None
        raise _RpcError(404, f"No handler for {method}")  # pragma: no cover


class _RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


class FakeShellyGen1:
    """Gen1 device: relays (+ meters), dimmer lights, or rollers (Shelly 2.5 roller mode)."""

    def __init__(
        self,
        *,
        type_: str = "SHSW-25",
        mac: str = "FAKE01A2B3C4",
        username: str = "admin",
        password: str | None = None,
        relays: int = 2,
        meters: bool = True,
        lights: int = 0,
        rollers: int = 0,
        mode: str | None = None,
        positioning: bool = True,
    ) -> None:
        self.type, self.mac, self.username, self.password = type_, mac, username, password
        self.mode = mode or ("roller" if rollers else "relay" if relays else None)
        self.requests: list[str] = []
        self.relays = [{"ison": False, "has_timer": False, "overpower": False, "source": "init"} for _ in range(relays)]
        self.meters = (
            [
                {"power": 0.0, "overpower": 0.0, "is_valid": True, "timestamp": 0, "counters": [0, 0, 0], "total": 6000}
                for _ in range(max(relays, rollers))
            ]
            if meters
            else []
        )
        self.lights = [{"ison": False, "source": "init", "brightness": 40, "mode": "white"} for _ in range(lights)]
        self.rollers = [
            {
                "state": "stop",
                "power": 0.0,
                "is_valid": True,
                "current_pos": 50 if positioning else -1,
                "positioning": positioning,
                "last_direction": "open",
                "calibrating": False,
            }
            for _ in range(rollers)
        ]
        self.app_asgi = Starlette(
            routes=[
                Route("/shelly", self._shelly),
                Route("/status", self._status),
                Route("/settings", self._settings),
                Route("/relay/{n:int}", self._relay),
                Route("/light/{n:int}", self._light),
                Route("/roller/{n:int}", self._roller),
            ]
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self.app_asgi(scope, receive, send)

    def _authorized(self, request: Request) -> bool:
        if self.password is None:
            return True
        header = request.headers.get("authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, _, pw = base64.b64decode(header[6:]).decode().partition(":")
        except ValueError:
            return False
        return secrets.compare_digest(f"{user}:{pw}", f"{self.username}:{self.password}")

    def _deny(self) -> Response:
        return Response("401 Unauthorized", status_code=401, headers={"WWW-Authenticate": 'Basic realm="FAKE-Shelly"'})

    async def _shelly(self, _r: Request) -> JSONResponse:
        self.requests.append("GET /shelly")
        body: dict[str, Any] = {
            "type": self.type,
            "mac": self.mac,
            "auth": self.password is not None,
            "fw": "20230913-112003/v1.14.0-fake",
            "longid": 1,
            "discoverable": False,
        }
        if self.relays:
            body["num_outputs"] = len(self.relays)
        if self.meters:
            body["num_meters"] = len(self.meters)
        if self.rollers:
            body["num_rollers"] = len(self.rollers)
        if self.mode:
            body["mode"] = self.mode
        return JSONResponse(body)

    async def _status(self, r: Request) -> Response:
        if not self._authorized(r):
            return self._deny()
        self.requests.append("GET /status")
        body: dict[str, Any] = {"mac": self.mac, "uptime": 1234, "wifi_sta": {"connected": True, "ip": "fake"}}
        if self.relays:
            body["relays"] = self.relays
        if self.meters:
            body["meters"] = self.meters
        if self.lights:
            body["lights"] = self.lights
        if self.rollers:
            body["rollers"] = self.rollers
        return JSONResponse(body)

    async def _settings(self, r: Request) -> Response:
        if not self._authorized(r):
            return self._deny()
        return JSONResponse(
            {"device": {"type": self.type, "mac": self.mac, "hostname": f"FAKE-{self.mac}"}, "mode": self.mode}
        )

    async def _relay(self, r: Request) -> Response:
        if not self._authorized(r):
            return self._deny()
        n = r.path_params["n"]
        self.requests.append(f"GET /relay/{n}?{r.url.query}")
        if self.mode == "roller":
            return JSONResponse({"error": "Device mode is not relay!"}, status_code=400)
        if n >= len(self.relays):
            return Response("Not found", status_code=404)
        relay = self.relays[n]
        turn = r.query_params.get("turn")
        if turn in ("on", "off"):
            relay["ison"] = turn == "on"
        elif turn == "toggle":
            relay["ison"] = not relay["ison"]
        if self.meters:
            self.meters[n]["power"] = 25.0 if relay["ison"] else 0.0
        return JSONResponse(relay)

    async def _light(self, r: Request) -> Response:
        if not self._authorized(r):
            return self._deny()
        n = r.path_params["n"]
        self.requests.append(f"GET /light/{n}?{r.url.query}")
        if n >= len(self.lights):
            return Response("Not found", status_code=404)
        light, q = self.lights[n], r.query_params
        if q.get("turn") in ("on", "off"):
            light["ison"] = q["turn"] == "on"
        elif q.get("turn") == "toggle":
            light["ison"] = not light["ison"]
        if "brightness" in q:
            light["brightness"] = int(q["brightness"])
        if q.get("dim") in ("up", "down"):
            step = int(q.get("step", 10))
            light["brightness"] = max(0, min(100, light["brightness"] + (step if q["dim"] == "up" else -step)))
        return JSONResponse(light)

    async def _roller(self, r: Request) -> Response:
        if not self._authorized(r):
            return self._deny()
        n = r.path_params["n"]
        self.requests.append(f"GET /roller/{n}?{r.url.query}")
        if self.mode != "roller" or n >= len(self.rollers):
            return Response("Not found", status_code=404)
        roller, go = self.rollers[n], r.query_params.get("go")
        if go == "to_pos":
            if not roller["positioning"]:
                return JSONResponse({"error": "Calibration required"}, status_code=400)
            roller["state"] = "open" if int(r.query_params["roller_pos"]) >= roller["current_pos"] else "close"
            roller["current_pos"] = int(r.query_params["roller_pos"])
            roller["state"] = "stop"
        elif go in ("open", "close"):
            roller["state"] = go
        elif go == "stop":
            roller["state"] = "stop"
        return JSONResponse(roller)


def main() -> None:  # pragma: no cover - manual demo helper
    import uvicorn

    parser = argparse.ArgumentParser(description="Run a FAKE Shelly device (not real hardware)")
    parser.add_argument("--gen", type=int, choices=[1, 2, 3, 4], default=2)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--password", default=None)
    parser.add_argument("--switches", type=int, default=1)
    parser.add_argument("--lights", type=int, default=0)
    parser.add_argument("--covers", type=int, default=0)
    args = parser.parse_args()
    if args.gen == 1:
        app: Any = FakeShellyGen1(relays=args.switches, lights=args.lights, rollers=args.covers, password=args.password)
    else:
        app = FakeShellyGen2(
            gen=args.gen, switches=args.switches, lights=args.lights, covers=args.covers, password=args.password
        )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
