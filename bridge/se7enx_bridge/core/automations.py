"""Automations and scenes: validated definitions, dry-run, scheduler, run traces.

* Definitions are strict (pydantic, unknown keys rejected) and *compiled* against the live device
  registry before they are saved: unknown devices, unsupported commands, invalid parameters and
  risky patterns are reported with a path, so the editor can point at the problem.
* Every command goes through ``DeviceRegistry.execute`` (source ``automation``/``scene``): the
  emergency stop, "real control enabled", per-device rate limits and the KNX address allowlist
  apply exactly as for a click. Nothing bypasses the Core.
* No uncontrolled repeats: one run at a time per automation, a cooldown between runs, device
  triggers fire on *changes* only, and a run stops at the first failed action.
* Dry-run evaluates triggers/conditions against the current state and lists what *would* be sent,
  without sending anything.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import time
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..devices.model import CommandName, DeviceCommand, DeviceError
from .db import Database

log = logging.getLogger("se7enx.automations")

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
Day = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
PROPERTIES = ("on", "brightness", "position", "value", "connection")
MAX_TOTAL_DELAY_S = 3600


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def _hhmm(v: str) -> str:
    if not HHMM.match(v):
        raise ValueError("use 24-hour HH:MM")
    return v


class TimeTrigger(_Strict):
    type: Literal["time"]
    at: str
    days: list[Day] = Field(default_factory=lambda: list(DAYS), min_length=1, max_length=7)
    _v = field_validator("at")(lambda cls, v: _hhmm(v))


class DeviceStateTrigger(_Strict):
    type: Literal["device_state"]
    device_id: str = Field(alias="deviceId", min_length=1, max_length=48)
    property: Literal["on", "brightness", "position", "value", "connection"]
    equals: bool | int | float | str | None = None
    above: float | None = None
    below: float | None = None


class ManualTrigger(_Strict):
    type: Literal["manual"]


Trigger = Annotated[TimeTrigger | DeviceStateTrigger | ManualTrigger, Field(discriminator="type")]


class TimeWindowCondition(_Strict):
    type: Literal["time_window"]
    after: str
    before: str
    _a = field_validator("after")(lambda cls, v: _hhmm(v))
    _b = field_validator("before")(lambda cls, v: _hhmm(v))


class WeekdayCondition(_Strict):
    type: Literal["weekday"]
    days: list[Day] = Field(min_length=1, max_length=7)


class DeviceStateCondition(_Strict):
    type: Literal["device_state"]
    device_id: str = Field(alias="deviceId", min_length=1, max_length=48)
    property: Literal["on", "brightness", "position", "value", "connection"]
    equals: bool | int | float | str | None = None
    above: float | None = None
    below: float | None = None


Condition = Annotated[TimeWindowCondition | WeekdayCondition | DeviceStateCondition, Field(discriminator="type")]


class CommandAction(_Strict):
    type: Literal["command"]
    device_id: str = Field(alias="deviceId", min_length=1, max_length=48)
    command: CommandName
    params: dict[str, Any] = Field(default_factory=dict)


class SceneAction(_Strict):
    type: Literal["scene"]
    scene_id: str = Field(alias="sceneId", min_length=1, max_length=48)


class NotifyAction(_Strict):
    type: Literal["notify"]
    level: Literal["info", "warning", "critical"] = "info"
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(default="", max_length=300)


class DelayAction(_Strict):
    type: Literal["delay"]
    seconds: int = Field(ge=1, le=MAX_TOTAL_DELAY_S)


Action = Annotated[CommandAction | SceneAction | NotifyAction | DelayAction, Field(discriminator="type")]


class AutomationDefinition(_Strict):
    triggers: list[Trigger] = Field(min_length=1, max_length=5)
    conditions: list[Condition] = Field(default_factory=list, max_length=10)
    actions: list[Action] = Field(min_length=1, max_length=20)
    cooldown_s: int = Field(default=30, ge=0, le=86400, alias="cooldownS")


class SceneDefinition(_Strict):
    actions: list[CommandAction] = Field(min_length=1, max_length=30)


# ------------------------------------------------------------------------------------- compiler


def _issue(path: str, message: str, severity: str = "error") -> dict[str, str]:
    return {"path": path, "message": message, "severity": severity}


def pydantic_issues(err: ValidationError, prefix: str = "") -> list[dict[str, str]]:
    out = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e["loc"] if not (isinstance(p, str) and p in ("function-after",)))
        out.append(_issue(f"{prefix}{loc}", e["msg"]))
    return out


def _check_command(
    devices: dict[str, dict[str, Any]], a: CommandAction, path: str, issues: list[dict[str, str]]
) -> None:
    d = devices.get(a.device_id)
    if d is None:
        issues.append(_issue(f"{path}.deviceId", f"Unknown device '{a.device_id}'."))
        return
    if a.command not in d["commands"]:
        supported = ", ".join(d["commands"]) or "none (read-only)"
        issues.append(_issue(f"{path}.command", f"{d['name']} does not support '{a.command}'. Supported: {supported}."))
        return
    try:
        DeviceCommand(command=a.command, params=a.params, request_id="validate", source="automation")
    except ValidationError as err:
        issues.append(_issue(f"{path}.params", err.errors()[0]["msg"]))
    if not d["simulated"] and not d["controlEnabled"]:
        issues.append(
            _issue(
                f"{path}.deviceId",
                f"Real control of {d['name']} is not enabled: this action will be refused.",
                "warning",
            )
        )


def compile_definition(
    raw: Any, devices: dict[str, dict[str, Any]], scenes: dict[str, dict[str, Any]]
) -> tuple[AutomationDefinition | None, list[dict[str, str]]]:
    """Validate structure and meaning. Returns (definition or None, issues)."""
    try:
        defn = AutomationDefinition.model_validate(raw)
    except ValidationError as err:
        return None, pydantic_issues(err)
    issues: list[dict[str, str]] = []
    trigger_devices: set[str] = set()
    for i, t in enumerate(defn.triggers):
        if isinstance(t, DeviceStateTrigger):
            if t.device_id not in devices:
                issues.append(_issue(f"triggers.{i}.deviceId", f"Unknown device '{t.device_id}'."))
            if t.equals is None and t.above is None and t.below is None and t.property != "connection":
                issues.append(_issue(f"triggers.{i}", "Fires on every change of this property.", "warning"))
            trigger_devices.add(t.device_id)
    for i, c in enumerate(defn.conditions):
        if isinstance(c, DeviceStateCondition) and c.device_id not in devices:
            issues.append(_issue(f"conditions.{i}.deviceId", f"Unknown device '{c.device_id}'."))
    total_delay = 0
    for i, a in enumerate(defn.actions):
        path = f"actions.{i}"
        if isinstance(a, CommandAction):
            _check_command(devices, a, path, issues)
            if a.device_id in trigger_devices:
                issues.append(
                    _issue(
                        path,
                        "This action changes a device that also triggers this automation. The cooldown limits repeats.",
                        "warning",
                    )
                )
        elif isinstance(a, SceneAction) and a.scene_id not in scenes:
            issues.append(_issue(f"{path}.sceneId", f"Unknown scene '{a.scene_id}'."))
        elif isinstance(a, DelayAction):
            total_delay += a.seconds
    if total_delay > MAX_TOTAL_DELAY_S:
        issues.append(_issue("actions", f"Delays add up to {total_delay} s (max {MAX_TOTAL_DELAY_S} s)."))
    return defn, issues


def compile_scene(raw: Any, devices: dict[str, dict[str, Any]]) -> tuple[SceneDefinition | None, list[dict[str, str]]]:
    try:
        scene = SceneDefinition.model_validate(raw)
    except ValidationError as err:
        return None, pydantic_issues(err)
    issues: list[dict[str, str]] = []
    for i, a in enumerate(scene.actions):
        _check_command(devices, a, f"actions.{i}", issues)
    return scene, issues


def has_errors(issues: list[dict[str, str]]) -> bool:
    return any(i["severity"] == "error" for i in issues)


# ------------------------------------------------------------------------------------- evaluation


def _value(device: dict[str, Any] | None, prop: str) -> Any:
    if device is None:
        return None
    if prop == "connection":
        return device["connection"]["status"]
    return device["state"]["reported"].get(prop)


def _matches(value: Any, equals: Any, above: float | None, below: float | None) -> bool:
    if equals is not None and value != equals:
        return False
    if above is not None and not (isinstance(value, int | float) and not isinstance(value, bool) and value > above):
        return False
    return not (
        below is not None and not (isinstance(value, int | float) and not isinstance(value, bool) and value < below)
    )


def _in_window(now: datetime, after: str, before: str) -> bool:
    cur = now.strftime("%H:%M")
    return after <= cur < before if after <= before else (cur >= after or cur < before)  # wraps midnight


def evaluate_conditions(
    defn: AutomationDefinition, devices: dict[str, dict[str, Any]], now: datetime
) -> tuple[bool, list[dict[str, Any]]]:
    trace = []
    ok_all = True
    for i, c in enumerate(defn.conditions):
        if isinstance(c, TimeWindowCondition):
            ok = _in_window(now, c.after, c.before)
            detail = f"{now:%H:%M} in {c.after}-{c.before}"
        elif isinstance(c, WeekdayCondition):
            ok = DAYS[now.weekday()] in c.days
            detail = f"{DAYS[now.weekday()]} in {','.join(c.days)}"
        else:
            value = _value(devices.get(c.device_id), c.property)
            ok = _matches(value, c.equals, c.above, c.below)
            detail = f"{c.device_id}.{c.property} = {value!r}"
        trace.append({"step": f"conditions.{i}", "ok": ok, "detail": detail})
        ok_all = ok_all and ok
    return ok_all, trace


# ------------------------------------------------------------------------------------- engine


class AutomationEngine:
    """Storage, scheduler and executor. ``registry`` is a DeviceRegistry; ``notify`` posts notifications."""

    TICK_S = 15.0

    def __init__(
        self,
        db: Database,
        registry: Any,
        notify: Callable[..., Any],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db = db
        self.registry = registry
        self.notify = notify
        self.clock = clock
        self._running: set[str] = set()
        self._fired_minutes: dict[str, str] = {}
        self._last_values: dict[tuple[str, str], Any] = {}
        self._tasks: list[asyncio.Task[None]] = []
        self._runs: set[asyncio.Task[Any]] = set()  # strong references to fire-and-forget runs
        self.broker: Any = None

    def _spawn(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._runs.add(task)
        task.add_done_callback(self._runs.discard)

    # ---- storage
    def devices(self) -> dict[str, dict[str, Any]]:
        return {d["id"]: d for d in self.registry.list_json()}

    def scenes_raw(self) -> dict[str, dict[str, Any]]:
        return {r["id"]: self._scene_json(r) for r in self.db.all("SELECT * FROM scenes ORDER BY name")}

    @staticmethod
    def _scene_json(r: Any) -> dict[str, Any]:
        return {
            "id": r["id"],
            "name": r["name"],
            "actions": json.loads(r["actions"]),
            "updatedAt": _iso(r["updated_at"]),
        }

    def _auto_json(self, r: Any) -> dict[str, Any]:
        last = self.db.one(
            "SELECT status, started_at, kind FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1",
            (r["id"],),
        )
        return {
            "id": r["id"],
            "name": r["name"],
            "enabled": bool(r["enabled"]),
            "definition": json.loads(r["definition"]),
            "updatedAt": _iso(r["updated_at"]),
            "lastRun": {"status": last["status"], "at": _iso(last["started_at"]), "kind": last["kind"]}
            if last
            else None,
        }

    def list(self) -> list[dict[str, Any]]:
        return [self._auto_json(r) for r in self.db.all("SELECT * FROM automations ORDER BY name")]

    def get(self, automation_id: str) -> dict[str, Any]:
        r = self.db.one("SELECT * FROM automations WHERE id = ?", (automation_id,))
        if r is None:
            raise DeviceError("AUTOMATION_NOT_FOUND", "No such automation.", status=404)
        return self._auto_json(r)

    def save(
        self, automation_id: str | None, name: str, enabled: bool, definition: AutomationDefinition, actor: str | None
    ) -> dict[str, Any]:
        now = self.clock()
        body = definition.model_dump(mode="json", by_alias=True)
        if automation_id is None:
            automation_id = f"auto-{secrets.token_hex(4)}"
            self.db.execute(
                "INSERT INTO automations (id, name, enabled, definition, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (automation_id, name, int(enabled), json.dumps(body), actor, now, now),
            )
        else:
            self.get(automation_id)
            self.db.execute(
                "UPDATE automations SET name = ?, enabled = ?, definition = ?, updated_at = ? WHERE id = ?",
                (name, int(enabled), json.dumps(body), now, automation_id),
            )
        return self.get(automation_id)

    def delete(self, automation_id: str) -> None:
        self.get(automation_id)
        self.db.execute("DELETE FROM automations WHERE id = ?", (automation_id,))
        self.db.execute("DELETE FROM automation_runs WHERE automation_id = ?", (automation_id,))

    def runs(self, automation_id: str, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.db.all(
            "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?", (automation_id, limit)
        )
        return [
            {
                "id": r["id"],
                "kind": r["kind"],
                "trigger": r["trigger"],
                "status": r["status"],
                "startedAt": _iso(r["started_at"]),
                "finishedAt": _iso(r["finished_at"]),
                "trace": json.loads(r["trace"]),
                "actor": r["actor"],
            }
            for r in rows
        ]

    def save_scene(self, scene_id: str | None, name: str, scene: SceneDefinition, actor: str | None) -> dict[str, Any]:
        now = self.clock()
        actions = json.dumps([a.model_dump(mode="json", by_alias=True) for a in scene.actions])
        if scene_id is None:
            scene_id = f"scene-{secrets.token_hex(4)}"
            self.db.execute(
                "INSERT INTO scenes (id, name, actions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (scene_id, name, actions, actor, now, now),
            )
        else:
            self.scene(scene_id)
            self.db.execute(
                "UPDATE scenes SET name = ?, actions = ?, updated_at = ? WHERE id = ?", (name, actions, now, scene_id)
            )
        return self.scene(scene_id)

    def scene(self, scene_id: str) -> dict[str, Any]:
        r = self.db.one("SELECT * FROM scenes WHERE id = ?", (scene_id,))
        if r is None:
            raise DeviceError("SCENE_NOT_FOUND", "No such scene.", status=404)
        return self._scene_json(r)

    def delete_scene(self, scene_id: str) -> None:
        self.scene(scene_id)
        users = [
            a["name"] for a in self.list() if any(x.get("sceneId") == scene_id for x in a["definition"]["actions"])
        ]
        if users:
            raise DeviceError(
                "SCENE_IN_USE",
                f"Used by: {', '.join(users)}.",
                hint="Remove it from those automations first.",
                status=409,
            )
        self.db.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))

    # ---- execution
    async def _command(
        self, a: CommandAction, run_id: str, idx: str, source: str, client: str, dry: bool, trace: list[dict[str, Any]]
    ) -> bool:
        devices = self.devices()
        d = devices.get(a.device_id)
        label = d["name"] if d else a.device_id
        if dry:
            current = d["state"]["reported"] if d else None
            trace.append(
                {
                    "step": idx,
                    "ok": True,
                    "detail": f"would send {a.command} {a.params or ''} to {label} (now {current})".strip(),
                }
            )
            return True
        cmd = DeviceCommand(command=a.command, params=a.params, request_id=f"{run_id}-{idx}"[:64], source=source)
        try:
            res = await self.registry.execute(a.device_id, cmd, client)
        except DeviceError as err:
            trace.append({"step": idx, "ok": False, "detail": f"{label}: {err.code} — {err.message}"})
            return False
        outcome = res["outcome"]
        trace.append({"step": idx, "ok": True, "detail": f"{label}: {a.command} → {outcome}", "outcome": outcome})
        return True

    async def run_scene(
        self, scene_id: str, *, client: str, dry: bool = False, source: str = "scene"
    ) -> dict[str, Any]:
        scene = self.scene(scene_id)
        defn = SceneDefinition.model_validate({"actions": scene["actions"]})
        trace: list[dict[str, Any]] = []
        run_id = f"s{secrets.token_hex(3)}"
        ok = True
        for i, a in enumerate(defn.actions):
            if not await self._command(a, run_id, f"actions.{i}", source, client, dry, trace):
                ok = False
                break
        return {"scene": scene["id"], "status": ("dry_run" if dry else "succeeded") if ok else "failed", "trace": trace}

    async def run(self, automation_id: str, *, trigger: str, actor: str | None, dry: bool = False) -> dict[str, Any]:
        auto = self.get(automation_id)
        defn = AutomationDefinition.model_validate(auto["definition"])
        started = self.clock()
        kind = "dry_run" if dry else ("manual" if trigger == "manual" else "automatic")
        trace: list[dict[str, Any]] = [{"step": "trigger", "ok": True, "detail": trigger}]
        if not dry:
            if automation_id in self._running:
                return self._record(
                    automation_id,
                    kind,
                    trigger,
                    started,
                    "skipped",
                    [*trace, {"step": "mode", "ok": False, "detail": "already running"}],
                    actor,
                )
            last = self.db.one("SELECT last_run_at FROM automations WHERE id = ?", (automation_id,))
            if trigger != "manual" and last and last["last_run_at"] and started - last["last_run_at"] < defn.cooldown_s:
                return self._record(
                    automation_id,
                    kind,
                    trigger,
                    started,
                    "skipped",
                    [*trace, {"step": "cooldown", "ok": False, "detail": f"{defn.cooldown_s} s cooldown"}],
                    actor,
                )
        devices = self.devices()
        ok, ctrace = evaluate_conditions(defn, devices, datetime.fromtimestamp(started).astimezone())
        trace += ctrace
        if not ok:
            return self._record(automation_id, kind, trigger, started, "conditions_not_met", trace, actor)
        if not dry:
            self._running.add(automation_id)
            self.db.execute("UPDATE automations SET last_run_at = ? WHERE id = ?", (started, automation_id))
        status = "dry_run" if dry else "succeeded"
        client = f"automation {auto['name']}"
        run_id = f"a{secrets.token_hex(3)}"
        try:
            for i, a in enumerate(defn.actions):
                idx = f"actions.{i}"
                if isinstance(a, CommandAction):
                    if not await self._command(a, run_id, idx, "automation", client, dry, trace):
                        status = "failed"
                        break
                elif isinstance(a, SceneAction):
                    res = await self.run_scene(a.scene_id, client=client, dry=dry, source="automation")
                    trace += [{**t, "step": f"{idx}.{t['step']}"} for t in res["trace"]]
                    if res["status"] == "failed":
                        status = "failed"
                        break
                elif isinstance(a, NotifyAction):
                    if not dry:
                        self.notify(
                            a.level, "automation", a.title, a.body, target_type="automation", target_id=automation_id
                        )
                    trace.append(
                        {"step": idx, "ok": True, "detail": f"{'would notify' if dry else 'notified'}: {a.title}"}
                    )
                elif isinstance(a, DelayAction):
                    trace.append(
                        {"step": idx, "ok": True, "detail": f"{'would wait' if dry else 'waited'} {a.seconds} s"}
                    )
                    if not dry:
                        await asyncio.sleep(a.seconds)
        finally:
            self._running.discard(automation_id)
        if status == "failed":
            self.notify(
                "warning",
                "automation",
                f"Automation failed: {auto['name']}",
                next((t["detail"] for t in reversed(trace) if not t["ok"]), ""),
                target_type="automation",
                target_id=automation_id,
                audience="perm:automation.view",
                dedupe_key=f"automation-failed:{automation_id}",
            )
        return self._record(automation_id, kind, trigger, started, status, trace, actor)

    def _record(
        self,
        automation_id: str,
        kind: str,
        trigger: str,
        started: float,
        status: str,
        trace: list[dict[str, Any]],
        actor: str | None,
    ) -> dict[str, Any]:
        with self.db.transaction() as conn:
            cur = conn.execute(
                "INSERT INTO automation_runs (automation_id, kind, trigger, started_at, finished_at, status, trace, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    automation_id,
                    kind,
                    trigger[:120],
                    started,
                    self.clock(),
                    status,
                    json.dumps(trace, default=str)[:20000],
                    actor,
                ),
            )
            run_id = int(cur.lastrowid or 0)
            conn.execute(
                "DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 100)",
                (automation_id, automation_id),
            )
        log.info("automation %s run %s: %s (%s)", automation_id, kind, status, trigger)
        return {
            "id": run_id,
            "automationId": automation_id,
            "kind": kind,
            "trigger": trigger,
            "status": status,
            "trace": trace,
        }

    # ---- scheduler
    def start(self, broker: Any) -> None:
        self.broker = broker
        for d in self.registry.list_json():  # baseline: device triggers fire on changes, not on start-up
            for prop in PROPERTIES:
                self._last_values[(d["id"], prop)] = _value(d, prop)
        self._tasks = [asyncio.create_task(self._time_loop()), asyncio.create_task(self._device_loop())]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await t
        self._tasks = []

    def _enabled(self) -> list[dict[str, Any]]:
        return [a for a in self.list() if a["enabled"]]

    async def tick_time(self, now: datetime | None = None) -> list[str]:
        now = now or datetime.fromtimestamp(self.clock()).astimezone()
        minute = now.strftime("%Y%m%d%H%M")
        fired = []
        for auto in self._enabled():
            for i, t in enumerate(auto["definition"]["triggers"]):
                if (
                    t["type"] != "time"
                    or t["at"] != now.strftime("%H:%M")
                    or DAYS[now.weekday()] not in t.get("days", DAYS)
                ):
                    continue
                key = f"{auto['id']}:{i}"
                if self._fired_minutes.get(key) == minute:
                    continue
                self._fired_minutes[key] = minute
                fired.append(auto["id"])
                self._spawn(self.run(auto["id"], trigger=f"time {t['at']}", actor="scheduler"))
        return fired

    async def _time_loop(self) -> None:
        while True:
            try:
                await self.tick_time()
            except Exception:  # pragma: no cover - never let the scheduler die
                log.exception("time trigger evaluation failed")
            await asyncio.sleep(self.TICK_S)

    def on_device(self, device: dict[str, Any]) -> list[str]:
        fired = []
        changed: dict[str, Any] = {}
        for prop in PROPERTIES:
            value = _value(device, prop)
            key = (device["id"], prop)
            if self._last_values.get(key, object()) != value:
                changed[prop] = value
            self._last_values[key] = value
        if not changed:
            return fired
        for auto in self._enabled():
            for t in auto["definition"]["triggers"]:
                if t["type"] != "device_state" or t["deviceId"] != device["id"] or t["property"] not in changed:
                    continue
                if _matches(changed[t["property"]], t.get("equals"), t.get("above"), t.get("below")):
                    fired.append(auto["id"])
                    self._spawn(
                        self.run(
                            auto["id"],
                            trigger=f"{device['id']}.{t['property']} = {changed[t['property']]!r}",
                            actor="device",
                        )
                    )
                    break
        return fired

    async def _device_loop(self) -> None:
        sub = self.broker.subscribe()
        try:
            while True:
                ev = await sub.get()
                if ev.type == "device.state":
                    try:
                        self.on_device(ev.data)
                    except Exception:  # pragma: no cover
                        log.exception("device trigger evaluation failed")
        finally:
            sub.close()


def _iso(ts: float | None) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None
