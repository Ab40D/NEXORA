"""Read-only KNX USB interface diagnostics.

The KNX library used by the hub (xknx) speaks KNXnet/IP only and has no USB transport. This module
therefore never reports a working USB connection. It reports:

* whether a USB device that looks like a KNX interface is visible to the hub (``/sys/bus/usb``),
* whether HID raw device nodes are visible inside the container (USB passthrough), and
* the supported path: let knxd drive the USB interface (``-b usb:``) and expose KNXnet/IP, then
  configure SE7ENX for KNX/IP tunnelling to that host.

Vendor/product IDs are the exact list from knxd 0.14.73's udev rules. The list is not exhaustive, so
product strings containing "KNX"/"EIB" are matched as well.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Exact vendor:product pairs of USB-HID KNX interfaces, from knxd 0.14.73's udev rules (60-knxd.rules).
KNX_USB_PRODUCTS: dict[tuple[str, str], str] = {
    ("04cc", "0301"): "Schlaps & Partner EIB-USB Data Interface",
    ("0e77", "0111"): "Siemens KNX/EIB-USB Interface (flush mounted)",
    ("0e77", "0112"): "Siemens KNX/EIB-USB Interface (DIN rail)",
    ("0e77", "0102"): "Weinzierl KNX-USB Data Interface (UP)",
    ("0e77", "0103"): "Weinzierl KNX-USB Data Interface",
    ("0e77", "0104"): "Weinzierl KNX-USB Data Interface (DIN rail)",
    ("0e77", "0121"): "Weinzierl KNX-USB Data Interface (Hensel DIN rail)",
    ("0e77", "0141"): "Weinzierl KNX-USB Data Interface (Merlin Gerin UP)",
    ("135e", "0020"): "Insta KNX-USB Data Interface",
    ("135e", "0021"): "Insta KNX-USB Data Interface (Berker)",
    ("135e", "0022"): "Insta KNX-USB Data Interface (Gira)",
    ("135e", "0023"): "Insta KNX-USB Data Interface (Jung)",
    ("135e", "0024"): "Insta KNX-USB Data Interface (Merten)",
    ("135e", "0025"): "Hager KNX-USB Data Interface",
    ("135e", "0026"): "Insta KNX-USB Data Interface (Feller)",
    ("145c", "1330"): "Busch-Jaeger KNX-USB Interface (flush mounted, type 6133)",
    ("147b", "5120"): "ABB KNX-USB Interface (REG)",
    ("16d0", "0490"): "Tapko UIM-KNX 42",
    ("16d0", "0491"): "MDT SCN-USBR.01",
    ("24d5", "0106"): "SATEL KNX-USB Interface",
    ("28c2", "0007"): "Zublin KNX-USB Interface",
    ("28c2", "001a"): "Vimar 01540.1",
}
# Vendor IDs used only by KNX interface makers in that list (other products from them are likely KNX too).
KNX_USB_VENDORS: dict[str, str] = {
    "0e77": "Weinzierl Engineering (OEM for Siemens, Hensel, Merlin Gerin)",
    "135e": "Insta (Gira, JUNG, Berker, Merten, Hager, Feller)",
}
_KEYWORDS = ("knx", "eib")
_MAX_DEVICES = 256

GUIDANCE = (
    "SE7ENX cannot drive a KNX USB interface directly: its KNX library (xknx) supports KNXnet/IP only. "
    "Use the SE7ENX knxd container (deploy/appliance/compose.knx-usb.yaml): knxd drives the USB interface "
    "and offers a KNXnet/IP tunnelling server on a private Docker network, which the hub connects to. "
    "Without Docker, run knxd on the host with '-B single -b usb: -T -S' and choose KNX/IP tunnelling here."
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
