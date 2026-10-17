"""Bridge configuration from environment variables (prefix ``SE7ENX_``).

Safe defaults: bind to loopback only, no wildcard origins, default-deny group
address policy, browser-supplied gateway settings disabled, API docs off.
"""

from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import urlsplit

from .group_address import validate_pattern
from .hosts import HostPatternError, validate_host_pattern

CONNECTION_TYPES = ("automatic", "tunneling", "tunneling_tcp", "tunneling_tcp_secure", "routing", "routing_secure")
PRIVATE_NETWORKS = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")
_CODE_RE = re.compile(r"^[A-Z0-9]{8,32}$")


class ConfigError(ValueError):
    """Invalid configuration — the bridge refuses to start."""


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8787
    bridge_name: str = "SE7ENX Bridge"
    allowed_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    pairing_code: str | None = None
    pairing_ttl_s: int = 900
    session_ttl_s: int = 12 * 3600
    max_sessions: int = 10
    allowed_group_addresses: tuple[str, ...] = ()
    connection_type: str = "automatic"
    gateway_ip: str | None = None
    gateway_port: int = 3671
    local_ip: str | None = None
    route_back: bool = False
    individual_address: str | None = None
    multicast_group: str = "224.0.23.12"
    multicast_port: int = 3671
    autoconnect: bool = True
    keyring_path: str | None = None
    keyring_password: str | None = field(default=None, repr=False)
    secure_user_id: int | None = None
    secure_user_password: str | None = field(default=None, repr=False)
    secure_device_auth_password: str | None = field(default=None, repr=False)
    backbone_key: str | None = field(default=None, repr=False)
    allow_client_gateway: bool = False
    client_gateway_cidrs: tuple[ipaddress.IPv4Network, ...] = tuple(ipaddress.IPv4Network(n) for n in PRIVATE_NETWORKS)
    enable_discovery: bool = True
    enable_docs: bool = False
    tls_cert: str | None = None
    tls_key: str | None = None
    trust_proxy: bool = False
    command_limit: int = 6
    command_window_s: float = 10.0
    global_command_limit: int = 20
    log_level: str = "INFO"
    # --- local hub (device registry, appliance) ---
    data_dir: str | None = None  # persistent config.json / secrets.json; None = in memory only
    ui_dir: str | None = None  # static web UI served on the same origin (appliance image)
    allowed_hosts: tuple[str, ...] | None = None  # None = Host header not checked (legacy default)
    sample_devices: bool = False  # add simulated demo devices when the device list is empty
    ha_url: str | None = None
    ha_token: str | None = field(default=None, repr=False)
    ha_verify_tls: bool = True
    shelly_poll_s: int = 5
    device_min_interval_ms: int = 300

    @property
    def secure(self) -> bool:
        return self.connection_type in ("tunneling_tcp_secure", "routing_secure") or bool(self.keyring_path)

    def with_overrides(self, **kwargs: object) -> Settings:
        return replace(self, **kwargs)  # type: ignore[arg-type]

    def describe(self) -> dict[str, object]:
        """Effective configuration with secrets masked (for `check-config`)."""
        return {
            "host": self.host,
            "port": self.port,
            "tls": bool(self.tls_cert),
            "allowed_origins": list(self.allowed_origins),
            "allowed_group_addresses": list(self.allowed_group_addresses) or "(none — all commands denied)",
            "connection_type": self.connection_type,
            "gateway": f"{self.gateway_ip}:{self.gateway_port}" if self.gateway_ip else None,
            "local_ip": self.local_ip,
            "route_back": self.route_back,
            "autoconnect": self.autoconnect,
            "knx_secure": self.secure,
            "keyring_password": "***" if self.keyring_password else None,
            "allow_client_gateway": self.allow_client_gateway,
            "client_gateway_cidrs": [str(n) for n in self.client_gateway_cidrs],
            "discovery": self.enable_discovery,
            "docs": self.enable_docs,
            "pairing_code": "fixed (SE7ENX_PAIRING_CODE)" if self.pairing_code else "random, rotating",
            "session_ttl_h": self.session_ttl_s / 3600,
            "data_dir": self.data_dir or "(none — device configuration is not persisted)",
            "ui_dir": self.ui_dir,
            "allowed_hosts": list(self.allowed_hosts) if self.allowed_hosts is not None else "(not checked)",
            "sample_devices": self.sample_devices,
            "homeassistant_url": self.ha_url,
            "homeassistant_token": "***" if self.ha_token else None,
            "shelly_poll_s": self.shelly_poll_s,
            "device_min_interval_ms": self.device_min_interval_ms,
        }

    # ------------------------------------------------------------------ parsing

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = dict(os.environ if env is None else env)

        def get(name: str) -> str | None:
            v = e.get(f"SE7ENX_{name}")
            return v.strip() if v is not None and v.strip() != "" else None

        def as_bool(name: str, default: bool) -> bool:
            v = get(name)
            if v is None:
                return default
            if v.lower() in ("1", "true", "yes", "on"):
                return True
            if v.lower() in ("0", "false", "no", "off"):
                return False
            raise ConfigError(f"SE7ENX_{name} must be true or false (got {v!r})")

        def as_int(name: str, default: int, lo: int, hi: int) -> int:
            v = get(name)
            if v is None:
                return default
            try:
                n = int(v)
            except ValueError as err:
                raise ConfigError(f"SE7ENX_{name} must be an integer (got {v!r})") from err
            if not lo <= n <= hi:
                raise ConfigError(f"SE7ENX_{name} must be between {lo} and {hi} (got {n})")
            return n

        def as_list(name: str) -> list[str] | None:
            v = get(name)
            if v is None:
                return None
            return [x.strip() for x in v.split(",") if x.strip()]

        d = cls()
        kwargs: dict[str, object] = {}

        kwargs["host"] = get("HOST") or d.host
        kwargs["port"] = as_int("PORT", d.port, 1, 65535)
        kwargs["bridge_name"] = (get("BRIDGE_NAME") or d.bridge_name)[:64]

        origins = as_list("ALLOWED_ORIGINS")
        if origins is not None:
            norm: list[str] = []
            for o in origins:
                if o in ("*", "null"):
                    raise ConfigError(
                        "SE7ENX_ALLOWED_ORIGINS must list explicit origins; '*' and 'null' are not allowed"
                    )
                parts = urlsplit(o)
                if (
                    parts.scheme not in ("http", "https")
                    or not parts.netloc
                    or parts.path not in ("", "/")
                    or parts.query
                ):
                    raise ConfigError(
                        f"Invalid origin {o!r} in SE7ENX_ALLOWED_ORIGINS (expected e.g. https://app.example.com)"
                    )
                norm.append(f"{parts.scheme}://{parts.netloc}".lower())
            if not norm:
                raise ConfigError("SE7ENX_ALLOWED_ORIGINS must not be empty")
            kwargs["allowed_origins"] = tuple(dict.fromkeys(norm))

        code = get("PAIRING_CODE")
        if code is not None:
            code_n = re.sub(r"[^A-Za-z0-9]", "", code).upper()
            if not _CODE_RE.match(code_n):
                raise ConfigError(
                    "SE7ENX_PAIRING_CODE must contain 8-32 letters/digits (dashes and spaces are ignored)"
                )
            kwargs["pairing_code"] = code_n
        kwargs["pairing_ttl_s"] = as_int("PAIRING_TTL_MIN", d.pairing_ttl_s // 60, 1, 24 * 60) * 60
        kwargs["session_ttl_s"] = as_int("SESSION_TTL_HOURS", d.session_ttl_s // 3600, 1, 24 * 7) * 3600
        kwargs["max_sessions"] = as_int("MAX_SESSIONS", d.max_sessions, 1, 100)

        gas = as_list("ALLOWED_GROUP_ADDRESSES")
        if gas is not None:
            try:
                kwargs["allowed_group_addresses"] = tuple(validate_pattern(p) for p in gas)
            except ValueError as err:
                raise ConfigError(f"SE7ENX_ALLOWED_GROUP_ADDRESSES: {err}") from err

        ct = (get("KNX_CONNECTION_TYPE") or "").lower() or None
        gw = get("KNX_GATEWAY_IP")
        if ct is None:
            ct = "tunneling" if gw else "automatic"
        if ct not in CONNECTION_TYPES:
            raise ConfigError(f"SE7ENX_KNX_CONNECTION_TYPE must be one of {', '.join(CONNECTION_TYPES)}")
        if ct.startswith("tunneling") and not gw:
            raise ConfigError(f"SE7ENX_KNX_GATEWAY_IP is required for connection type {ct!r}")
        kwargs["connection_type"] = ct
        kwargs["gateway_ip"] = gw
        kwargs["gateway_port"] = as_int("KNX_GATEWAY_PORT", d.gateway_port, 1, 65535)
        local_ip = get("KNX_LOCAL_IP")
        if local_ip is not None:
            try:
                ipaddress.IPv4Address(local_ip)
            except ValueError as err:
                raise ConfigError("SE7ENX_KNX_LOCAL_IP must be an IPv4 address") from err
        kwargs["local_ip"] = local_ip
        kwargs["route_back"] = as_bool("KNX_ROUTE_BACK", d.route_back)
        ia = get("KNX_INDIVIDUAL_ADDRESS")
        if ia is not None and not re.match(r"^\d{1,2}\.\d{1,2}\.\d{1,3}$", ia):
            raise ConfigError("SE7ENX_KNX_INDIVIDUAL_ADDRESS must look like 1.1.250")
        kwargs["individual_address"] = ia
        kwargs["multicast_group"] = get("KNX_MULTICAST_GROUP") or d.multicast_group
        kwargs["multicast_port"] = as_int("KNX_MULTICAST_PORT", d.multicast_port, 1, 65535)
        kwargs["autoconnect"] = as_bool("KNX_AUTOCONNECT", d.autoconnect)

        kwargs["keyring_path"] = get("KNX_KEYRING_PATH")
        kwargs["keyring_password"] = get("KNX_KEYRING_PASSWORD")
        uid = get("KNX_SECURE_USER_ID")
        kwargs["secure_user_id"] = int(uid) if uid and uid.isdigit() else None
        kwargs["secure_user_password"] = get("KNX_SECURE_USER_PASSWORD")
        kwargs["secure_device_auth_password"] = get("KNX_SECURE_DEVICE_AUTH_PASSWORD")
        bb = get("KNX_BACKBONE_KEY")
        if bb is not None and not re.match(r"^[0-9a-fA-F]{32}$", bb):
            raise ConfigError("SE7ENX_KNX_BACKBONE_KEY must be 32 hex characters")
        kwargs["backbone_key"] = bb
        if kwargs["keyring_path"] and not Path(str(kwargs["keyring_path"])).is_file():
            raise ConfigError("SE7ENX_KNX_KEYRING_PATH does not point to a file")
        if kwargs["keyring_path"] and not kwargs["keyring_password"]:
            raise ConfigError("SE7ENX_KNX_KEYRING_PASSWORD is required with SE7ENX_KNX_KEYRING_PATH")
        if ct == "tunneling_tcp_secure" and not (
            kwargs["keyring_path"] or (kwargs["secure_user_id"] and kwargs["secure_user_password"])
        ):
            raise ConfigError(
                "tunneling_tcp_secure requires a keyring (SE7ENX_KNX_KEYRING_PATH/PASSWORD) or user id + password"
            )
        if ct == "routing_secure" and not (kwargs["keyring_path"] or kwargs["backbone_key"]):
            raise ConfigError("routing_secure requires a keyring or SE7ENX_KNX_BACKBONE_KEY")

        kwargs["allow_client_gateway"] = as_bool("ALLOW_CLIENT_GATEWAY_CONFIG", d.allow_client_gateway)
        cidrs = as_list("CLIENT_GATEWAY_CIDRS")
        if cidrs is not None:
            try:
                kwargs["client_gateway_cidrs"] = tuple(ipaddress.IPv4Network(c, strict=False) for c in cidrs)
            except ValueError as err:
                raise ConfigError(f"SE7ENX_CLIENT_GATEWAY_CIDRS: {err}") from err
        kwargs["enable_discovery"] = as_bool("ENABLE_DISCOVERY", d.enable_discovery)
        kwargs["enable_docs"] = as_bool("ENABLE_DOCS", d.enable_docs)

        cert, key = get("TLS_CERT"), get("TLS_KEY")
        if bool(cert) != bool(key):
            raise ConfigError("Set both SE7ENX_TLS_CERT and SE7ENX_TLS_KEY (or neither)")
        for name, path in (("SE7ENX_TLS_CERT", cert), ("SE7ENX_TLS_KEY", key)):
            if path and not Path(path).is_file():
                raise ConfigError(f"{name} does not point to a file")
        kwargs["tls_cert"], kwargs["tls_key"] = cert, key
        kwargs["trust_proxy"] = as_bool("TRUST_PROXY", d.trust_proxy)
        kwargs["command_limit"] = as_int("COMMAND_LIMIT", d.command_limit, 1, 100)
        kwargs["command_window_s"] = float(as_int("COMMAND_WINDOW_S", int(d.command_window_s), 1, 3600))
        kwargs["global_command_limit"] = as_int("GLOBAL_COMMAND_LIMIT", d.global_command_limit, 1, 1000)
        lvl = (get("LOG_LEVEL") or d.log_level).upper()
        if lvl not in ("DEBUG", "INFO", "WARNING", "ERROR"):
            raise ConfigError("SE7ENX_LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR")
        kwargs["log_level"] = lvl

        # --- local hub ---
        kwargs["data_dir"] = get("DATA_DIR")
        ui_dir = get("UI_DIR")
        if ui_dir and not Path(ui_dir, "index.html").is_file():
            raise ConfigError("SE7ENX_UI_DIR must point to a directory containing index.html")
        kwargs["ui_dir"] = ui_dir
        hosts = as_list("ALLOWED_HOSTS")
        if hosts is not None:
            try:
                kwargs["allowed_hosts"] = tuple(dict.fromkeys(validate_host_pattern(h) for h in hosts))
            except HostPatternError as err:
                raise ConfigError(f"SE7ENX_ALLOWED_HOSTS: {err}") from err
        kwargs["sample_devices"] = as_bool("SAMPLE_DEVICES", d.sample_devices)
        ha_url = get("HA_URL")
        if ha_url:
            try:
                kwargs["ha_url"] = normalize_ha_url(ha_url)
            except ValueError as err:
                raise ConfigError(f"SE7ENX_HA_URL: {err}") from err
        token, token_file = get("HA_TOKEN"), get("HA_TOKEN_FILE")
        if token and token_file:
            raise ConfigError("Set SE7ENX_HA_TOKEN or SE7ENX_HA_TOKEN_FILE, not both")
        if token_file:
            try:
                token = Path(token_file).read_text(encoding="utf-8").strip()
            except OSError as err:
                raise ConfigError(f"SE7ENX_HA_TOKEN_FILE cannot be read: {err.strerror}") from err
            if not token:
                raise ConfigError("SE7ENX_HA_TOKEN_FILE is empty")
        if token and not kwargs.get("ha_url"):
            raise ConfigError("SE7ENX_HA_TOKEN requires SE7ENX_HA_URL")
        kwargs["ha_token"] = token
        kwargs["ha_verify_tls"] = as_bool("HA_VERIFY_TLS", d.ha_verify_tls)
        kwargs["shelly_poll_s"] = as_int("SHELLY_POLL_S", d.shelly_poll_s, 2, 300)
        kwargs["device_min_interval_ms"] = as_int("DEVICE_MIN_INTERVAL_MS", d.device_min_interval_ms, 0, 10_000)

        return cls(**kwargs)  # type: ignore[arg-type]


def normalize_ha_url(value: str) -> str:
    """Home Assistant base URL: http(s), a host, no credentials, query or fragment."""
    parts = urlsplit(value.strip())
    if parts.scheme not in ("http", "https"):
        raise ValueError("must start with http:// or https://")
    if not parts.hostname:
        raise ValueError("must include a host, e.g. http://homeassistant.local:8123")
    if parts.username or parts.password:
        raise ValueError("must not contain credentials")
    if parts.query or parts.fragment:
        raise ValueError("must not contain a query or fragment")
    path = parts.path.rstrip("/")
    return f"{parts.scheme}://{parts.netloc}{path}"
