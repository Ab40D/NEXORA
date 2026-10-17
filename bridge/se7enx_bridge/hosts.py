"""Network policies: Host-header allowlist (DNS-rebinding defence) and local device addresses.

* ``HostPolicy`` decides which ``Host`` headers the hub answers. ``auto`` accepts IP literals,
  ``localhost`` and the reserved local suffixes ``.local`` / ``.home.arpa``. Those are names a
  remote attacker cannot point at your LAN through DNS rebinding. Extra hostnames can be listed
  explicitly.
* ``check_device_host`` keeps user-supplied device addresses (Shelly IPs, ...) inside private
  networks so the hub cannot be used as a proxy to the internet. There is no scanning: only
  explicitly entered hosts are ever contacted.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket

AUTO = "auto"
_AUTO_SUFFIXES = (".local", ".home.arpa")
_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
# Carrier-grade NAT space; also used by Tailscale for tailnet addresses.
_SHARED_SPACE = ipaddress.ip_network("100.64.0.0/10")


class HostPatternError(ValueError):
    pass


def is_hostname(text: str) -> bool:
    if not text or len(text) > 253:
        return False
    return all(_LABEL.match(label) for label in text.split("."))


def ip_literal(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(text.strip("[]"))
    except ValueError:
        return None


def validate_host_pattern(value: str) -> str:
    """Normalise one ``SE7ENX_ALLOWED_HOSTS`` entry: ``auto``, a hostname, ``*.domain`` or an IP."""
    v = value.strip().lower()
    if v == AUTO:
        return v
    if v.startswith("*."):
        if is_hostname(v[2:]):
            return v
        raise HostPatternError(f"invalid wildcard host pattern {value!r}")
    ip = ip_literal(v)
    if ip is not None:
        return str(ip)
    if is_hostname(v):
        return v
    raise HostPatternError(f"invalid host {value!r}")


def split_host_header(value: str) -> str:
    """Return the lower-cased host part of a ``Host`` header (port and IPv6 brackets removed)."""
    v = value.strip().lower()
    if v.startswith("["):
        end = v.find("]")
        return v[1:end] if end > 0 else v
    if v.count(":") == 1:
        return v.split(":", 1)[0]
    return v  # bare host, or a bare IPv6 literal without brackets


class HostPolicy:
    def __init__(self, patterns: tuple[str, ...]) -> None:
        self.patterns = patterns

    def allows(self, host_header: str | None) -> bool:
        if not host_header:
            return False
        host = split_host_header(host_header)
        if not host:
            return False
        for p in self.patterns:
            if p == AUTO:
                if host == "localhost" or host.endswith(_AUTO_SUFFIXES) or ip_literal(host) is not None:
                    return True
            elif p.startswith("*."):
                if host.endswith(p[1:]):
                    return True
            elif host == p:
                return True
        return False


# --------------------------------------------------------------------------- device hosts


class DeviceHostError(ValueError):
    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


def _address_is_local(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_reserved:
        return False
    if isinstance(ip, ipaddress.IPv4Address) and ip in _SHARED_SPACE:
        return True
    return ip.is_private or ip.is_link_local


def normalize_device_host(value: str) -> str:
    v = value.strip().lower()
    if not v or len(v) > 253 or "/" in v or "@" in v or " " in v:
        raise DeviceHostError("Enter the device's IP address or local hostname, e.g. 192.168.1.40.")
    ip = ip_literal(v)
    if ip is not None:
        return str(ip)
    if not is_hostname(v):
        raise DeviceHostError(f"{value!r} is not a valid IP address or hostname.")
    return v


async def check_device_host(host: str) -> str:
    """Validate and resolve a device host. Returns the address to contact (IP string).

    Only private, link-local or shared-space (100.64/10) addresses are accepted. Loopback is
    refused, so the hub cannot be pointed at its own or the host's local services.
    """
    h = normalize_device_host(host)
    ip = ip_literal(h)
    if ip is not None:
        if not _address_is_local(ip):
            raise DeviceHostError(
                f"{h} is not a local network address.",
                "SE7ENX only talks to devices on your local network (e.g. 192.168.x.x, 10.x.x.x).",
            )
        return str(ip)
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(loop.getaddrinfo(h, None, type=socket.SOCK_STREAM), timeout=3.0)
    except (TimeoutError, OSError) as err:
        raise DeviceHostError(f"Cannot resolve {h}.", "Use the device's IP address instead.") from err
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(_address_is_local(ipaddress.ip_address(a.split("%", 1)[0])) for a in addresses):
        raise DeviceHostError(f"{h} does not resolve to a local network address.", "Use the device's local IP address.")
    return sorted(addresses)[0]
