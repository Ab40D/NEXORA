"""Adapter contract. Protocol-specific logic lives in adapters; the registry and UI never see it."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal, Protocol

from ..model import Capability, CommandResult, ConnectionState, DeviceCommand, DeviceConfig

IntegrationState = Literal[
    "not_configured", "connecting", "connected", "degraded", "disconnected", "auth_failed", "error"
]


class AdapterCallbacks(Protocol):
    def device_state(self, device_id: str, reported: dict[str, Any], source: str) -> None: ...

    def device_connection(
        self,
        device_id: str,
        status: ConnectionState,
        error: dict[str, str] | None = None,
        *,
        capabilities: frozenset[Capability] | None = None,
        model: str | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None: ...

    def integration_changed(self, name: str) -> None: ...


@dataclass
class IntegrationStatus:
    name: str
    state: IntegrationState
    detail: str = ""
    last_success_at: float | None = None
    last_error: dict[str, str] | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        def iso(ts: float | None) -> str | None:
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None

        return {
            "name": self.name,
            "state": self.state,
            "detail": self.detail,
            "lastSuccessAt": iso(self.last_success_at),
            "lastError": self.last_error,
            **self.extra,
        }


def error_info(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


class DeviceAdapter(ABC):
    integration: ClassVar[str]

    def __init__(self, callbacks: AdapterCallbacks) -> None:
        self.cb = callbacks

    async def start(self) -> None:  # noqa: B027 - optional hook
        pass

    async def stop(self) -> None:  # noqa: B027 - optional hook
        pass

    @abstractmethod
    async def sync(self, devices: list[DeviceConfig]) -> None:
        """(Re)configure the adapter with the current set of its devices."""

    @abstractmethod
    def capabilities(self, device: DeviceConfig) -> frozenset[Capability]:
        """Capabilities known from configuration (adapters may refine them at runtime)."""

    @abstractmethod
    async def execute(self, device: DeviceConfig, cmd: DeviceCommand) -> CommandResult: ...

    async def refresh(self, device: DeviceConfig) -> None:  # noqa: B027 - optional hook
        """Ask the device for fresh state (best effort)."""

    @abstractmethod
    def status(self) -> IntegrationStatus: ...
