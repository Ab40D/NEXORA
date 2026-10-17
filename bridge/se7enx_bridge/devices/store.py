"""Persistent hub configuration.

Layout of ``SE7ENX_DATA_DIR``:

* ``config.json``: devices and integration settings. **No secrets**, safe to back up or share
  (``export()`` produces the same content).
* ``config.json.bak``: the previous version, written before every change.
* ``secrets.json``: credentials (Home Assistant token, device passwords), mode 0600, never
  returned by the API, never logged, never exported.

Writes are atomic (temp file + fsync + rename). Without a data directory the store keeps
everything in memory (development / tests) and logs that nothing will persist.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, TypeAdapter, ValidationError

from .model import ApiModel, DeviceConfig, ShellyDevice

log = logging.getLogger("se7enx.store")

CONFIG_FILE = "config.json"
SECRETS_FILE = "secrets.json"
SCHEMA_VERSION = 1


class StoreError(Exception):
    pass


class HomeAssistantSettings(ApiModel):
    url: str | None = Field(default=None, max_length=300)
    verify_tls: bool = True


class KnxInterfaceSettings(ApiModel):
    """KNX/IP interface configured in the UI (KNX Secure stays environment-only)."""

    connection_type: Literal["tunneling", "tunneling_tcp", "routing"] | None = None
    gateway_ip: str | None = Field(default=None, max_length=45)
    gateway_port: int = Field(default=3671, ge=1, le=65535)
    route_back: bool = False


class HubConfig(ApiModel):
    version: Literal[1] = SCHEMA_VERSION
    devices: list[DeviceConfig] = Field(default_factory=list, max_length=500)
    homeassistant: HomeAssistantSettings = Field(default_factory=HomeAssistantSettings)
    knx: KnxInterfaceSettings = Field(default_factory=KnxInterfaceSettings)


_HUB_CONFIG = TypeAdapter(HubConfig)


def _atomic_write(path: Path, text: str, mode: int) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.chmod(tmp, mode)
    os.replace(tmp, path)


class ConfigStore:
    def __init__(self, data_dir: str | Path | None) -> None:
        self.data_dir = Path(data_dir) if data_dir else None
        self.config = HubConfig()
        self._secrets: dict[str, Any] = {}

    @property
    def persistent(self) -> bool:
        return self.data_dir is not None

    # ------------------------------------------------------------------ load / save

    def load(self) -> None:
        if self.data_dir is None:
            log.warning("SE7ENX_DATA_DIR is not set: device configuration lives in memory and is lost on restart.")
            return
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            raise StoreError(f"Cannot create data directory {self.data_dir}: {err.strerror}") from err
        cfg_path = self.data_dir / CONFIG_FILE
        if cfg_path.exists():
            try:
                raw = json.loads(cfg_path.read_text(encoding="utf-8"))
                self.config = _HUB_CONFIG.validate_python(raw)
            except (json.JSONDecodeError, ValidationError) as err:
                # Fail fast instead of silently overwriting the user's configuration.
                raise StoreError(
                    f"{cfg_path} is invalid ({err.__class__.__name__}). Fix it or restore {CONFIG_FILE}.bak."
                ) from err
        sec_path = self.data_dir / SECRETS_FILE
        if sec_path.exists():
            mode = stat.S_IMODE(sec_path.stat().st_mode)
            if mode & 0o077:
                log.warning("%s was readable by other users (mode %o): restricting it to 0600.", sec_path, mode)
                os.chmod(sec_path, 0o600)
            try:
                data = json.loads(sec_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as err:
                raise StoreError(f"{sec_path} is not valid JSON") from err
            if not isinstance(data, dict):
                raise StoreError(f"{sec_path} must contain a JSON object")
            self._secrets = data
        self._drop_orphan_secrets()

    def save(self) -> None:
        if self.data_dir is None:
            return
        cfg_path = self.data_dir / CONFIG_FILE
        if cfg_path.exists():
            shutil.copy2(cfg_path, cfg_path.with_name(CONFIG_FILE + ".bak"))
        text = json.dumps(self.config.model_dump(mode="json", by_alias=True, exclude_none=True), indent=2)
        _atomic_write(cfg_path, text + "\n", 0o640)
        _atomic_write(self.data_dir / SECRETS_FILE, json.dumps(self._secrets, indent=2) + "\n", 0o600)

    # ------------------------------------------------------------------ devices

    def find(self, device_id: str) -> DeviceConfig | None:
        return next((d for d in self.config.devices if d.id == device_id), None)

    def put_device(self, device: DeviceConfig) -> None:
        self.config.devices = [d for d in self.config.devices if d.id != device.id] + [device]

    def remove_device(self, device_id: str) -> None:
        self.config.devices = [d for d in self.config.devices if d.id != device_id]
        self._secrets.get("devices", {}).pop(device_id, None)

    # ------------------------------------------------------------------ secrets

    def device_secret(self, device_id: str) -> dict[str, str]:
        return dict(self._secrets.get("devices", {}).get(device_id, {}))

    def set_device_secret(self, device_id: str, values: dict[str, str] | None) -> None:
        devices = self._secrets.setdefault("devices", {})
        if values:
            devices[device_id] = dict(values)
        else:
            devices.pop(device_id, None)

    def ha_token(self) -> str | None:
        token = self._secrets.get("homeassistant", {}).get("token")
        return token if isinstance(token, str) and token else None

    def set_ha_token(self, token: str | None) -> None:
        if token:
            self._secrets["homeassistant"] = {"token": token}
        else:
            self._secrets.pop("homeassistant", None)

    def _drop_orphan_secrets(self) -> None:
        ids = {d.id for d in self.config.devices}
        devices = self._secrets.get("devices", {})
        for orphan in [k for k in devices if k not in ids]:
            devices.pop(orphan, None)

    # ------------------------------------------------------------------ export

    def export(self) -> dict[str, Any]:
        """Configuration backup without any credential. Devices that need credentials are flagged."""
        data = self.config.model_dump(mode="json", by_alias=True, exclude_none=True)
        secret_ids = set(self._secrets.get("devices", {}))
        for dev in data["devices"]:
            if dev["id"] in secret_ids:
                dev["credentialsRequired"] = True
        data["homeassistant"]["tokenRequired"] = self.ha_token() is not None
        data["exportedWithoutSecrets"] = True
        return data


def credentials_needed(device: DeviceConfig) -> bool:
    return isinstance(device, ShellyDevice)
