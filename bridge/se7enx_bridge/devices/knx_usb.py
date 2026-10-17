"""Read-only KNX USB interface diagnostics.

The KNX library used by the hub (xknx) speaks KNXnet/IP only and has no USB transport. This module
therefore never reports a working USB connection. It reports:

* whether a USB device that looks like a KNX interface is visible to the hub (``/sys/bus/usb``),
* whether HID raw device nodes are visible inside the container (USB passthrough), and
* the supported path: let knxd drive the USB interface (``-b usb:``) and expose KNXnet/IP, then
  configure SE7ENX for KNX/IP tunnelling to that host.

Vendor/product IDs come from knxd's udev rules and published ``lsusb`` output. The list is not
exhaustive, so product strings containing "KNX"/"EIB" are matched as well.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Vendor IDs owned by KNX interface manufacturers (whole vendor is a match).
KNX_USB_VENDORS: dict[str, str] = {
    "0e77": "Weinzierl Engineering (also OEM for Siemens, Hensel, Merlin Gerin)",
    "135e": "Insta (Gira, JUNG, Berker, Feller)",
    "147b": "ABB STOTZ-KONTAKT",
    "0908": "Siemens",
    "16de": "Schneider Electric",
}
# Specific vendor:product pairs listed in knxd's udev rules where the vendor ID is shared.
KNX_USB_PRODUCTS: dict[tuple[str, str], str] = {
    ("145c", "1330"): "KNX USB interface (listed in knxd udev rules)",
    ("145c", "1490"): "KNX USB interface (listed in knxd udev rules)",
    ("16d0", "0490"): "KNX USB interface (listed in knxd udev rules)",
    ("16d0", "0492"): "KNX USB interface (listed in knxd udev rules)",
    ("04cc", "0301"): "KNX USB interface (listed in knxd udev rules)",
    ("0681", "0014"): "KNX USB interface (listed in knxd udev rules)",
}
_KEYWORDS = ("knx", "eib")
_MAX_DEVICES = 256

GUIDANCE = (
    "SE7ENX cannot drive a KNX USB interface directly: its KNX library (xknx) supports KNXnet/IP only. "
    "Run knxd on the host computer (it drives the USB interface with '-b usb:'), enable its KNXnet/IP "
    "tunnelling server, then choose KNX/IP here and enter the host's IP address."
)


def _read(path: Path, limit: int = 128) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()[:limit]
    except OSError:
        return None


def scan_usb(
    sys_root: str | os.PathLike[str] = "/sys/bus/usb/devices", dev_root: str | os.PathLike[str] = "/dev"
) -> dict[str, Any]:
    """Return a JSON-ready diagnostic report. Never touches the devices themselves."""
    root = Path(sys_root)
    sysfs_visible = root.is_dir()
    candidates: list[dict[str, Any]] = []
    usb_count = 0
    if sysfs_visible:
        try:
            entries = sorted(root.iterdir())[:_MAX_DEVICES]
        except OSError:
            entries = []
        for entry in entries:
            vendor = (_read(entry / "idVendor", 8) or "").lower()
            product_id = (_read(entry / "idProduct", 8) or "").lower()
            if not vendor:
                continue  # interfaces/hubs without descriptors
            usb_count += 1
            manufacturer = _read(entry / "manufacturer")
            product = _read(entry / "product")
            text = f"{manufacturer or ''} {product or ''}".lower()
            reason: str | None = None
            if (vendor, product_id) in KNX_USB_PRODUCTS:
                reason = KNX_USB_PRODUCTS[(vendor, product_id)]
            elif vendor in KNX_USB_VENDORS:
                reason = KNX_USB_VENDORS[vendor]
            elif any(k in text for k in _KEYWORDS):
                reason = "product name mentions KNX/EIB"
            if reason:
                candidates.append(
                    {
                        "vendorId": vendor,
                        "productId": product_id,
                        "manufacturer": manufacturer,
                        "product": product,
                        "match": reason,
                    }
                )
    dev = Path(dev_root)
    try:
        hidraw = sorted(p.name for p in dev.glob("hidraw*"))[:32]
    except OSError:
        hidraw = []
    if candidates and not hidraw:
        status = "detected_no_access"
        message = (
            "A KNX USB interface is visible, but no HID device node is available to the hub "
            "(USB passthrough not configured). Either way, SE7ENX cannot use it directly."
        )
    elif candidates:
        status = "detected_unsupported"
        message = "A KNX USB interface is visible, but direct USB communication is not supported."
    elif not sysfs_visible:
        status = "not_visible"
        message = "USB devices are not visible to the hub (typical inside a container)."
    else:
        status = "not_detected"
        message = "No KNX USB interface was detected."
    return {
        "supported": False,  # direct USB is never supported by this hub; never claim a connection
        "status": status,
        "message": message,
        "guidance": GUIDANCE,
        "devices": candidates,
        "usbDevicesSeen": usb_count,
        "sysfsVisible": sysfs_visible,
        "hidrawNodes": hidraw,
    }
