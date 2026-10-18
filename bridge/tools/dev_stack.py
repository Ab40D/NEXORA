#!/usr/bin/env python3
"""Run the REAL SE7ENX Bridge against the FAKE KNXnet/IP interface in one process.

FOR DEMOS AND AUTOMATED TESTS ONLY. No real KNX hardware is involved: the
bridge tunnels to a simulated interface (reported as "SE7ENX FAKE KNX (TEST
ONLY)") with one simulated switch actuator (switch 0/0/1, status 0/0/2).

    python tools/dev_stack.py --port 8799 --origin http://localhost:3000

Once the bridge is listening, a banner shows the **Bridge URL** to enter in the web app.
The fake interface listens on a random UDP port. The bridge connects to it by itself; that
address is never the bridge URL.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import uvicorn  # noqa: E402
from fake_knx_interface import FAKE_NAME, Actuator, start_fake_interface  # noqa: E402

from se7enx_bridge.api import create_app  # noqa: E402
from se7enx_bridge.config import Settings  # noqa: E402

SWITCH_GA = "0/0/1"
STATUS_GA = "0/0/2"


def bridge_url(host: str, port: int) -> tuple[str, str | None]:
    """The URL to enter in a browser on this computer, plus a note for other devices."""
    if host in ("0.0.0.0", "::", ""):
        return f"http://127.0.0.1:{port}", f"from other devices: http://<this computer's LAN IP>:{port}"
    shown = f"[{host}]" if ":" in host else host
    return f"http://{shown}:{port}", None


def banner(*, url: str, other: str | None, code: str, origins: tuple[str, ...], knx: tuple[str, int]) -> str:
    rule = "─" * 78
    label = "   {:<42}{}".format
    lines = [
        rule,
        " SE7ENX dev stack — DEMO / TESTS ONLY (no real KNX hardware)",
        "",
        label("Bridge URL — enter this in the web app:", url),
    ]
    if other:
        lines.append(label("", f"({other})"))
    lines += [
        label("Pairing code:", code),
        label("Web app origins allowed:", ", ".join(origins)),
        label("Light (simulated actuator):", f"switch {SWITCH_GA} · status {STATUS_GA}"),
        "",
        f"   Internal only: fake KNX interface on udp://{knx[0]}:{knx[1]}",
        "   The bridge connects to it by itself. It is NOT the bridge URL; do not enter it in the app.",
        "",
        "   In the app: Connect → Connect to the hub → Local KNX Bridge → Bridge URL → pairing code.",
        rule,
    ]
    return "\n".join(lines)


async def announce_when_listening(server: uvicorn.Server, text: str) -> None:
    """Print the banner only once uvicorn has really bound the port."""
    while not server.started:
        if server.should_exit:
            return
        await asyncio.sleep(0.05)
    print(text, flush=True)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--origin", action="append", default=None, help="allowed web origin (repeatable)")
    parser.add_argument("--pairing-code", default=os.environ.get("SE7ENX_PAIRING_CODE", "DEMO-2026"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("xknx").setLevel(logging.WARNING)

    fake = await start_fake_interface("127.0.0.1", 0, actuator=Actuator(switch=SWITCH_GA, status=STATUS_GA))
    host, port = fake.address
    logging.getLogger("dev-stack").warning(
        "%s on udp://%s:%s — internal: the bridge connects to it; this is NOT the bridge URL", FAKE_NAME, host, port
    )

    origins = tuple(
        args.origin
        or ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3100", "http://127.0.0.1:3100"]
    )
    settings = Settings(
        host=args.host,
        port=args.port,
        allowed_origins=origins,
        pairing_code="".join(c for c in args.pairing_code.upper() if c.isalnum()),
        allowed_group_addresses=("0/0/1-9",),
        connection_type="tunneling",
        gateway_ip=host,
        gateway_port=port,
        local_ip="127.0.0.1",
    )
    server = uvicorn.Server(
        uvicorn.Config(create_app(settings), host=args.host, port=args.port, log_level="warning", loop="asyncio")
    )
    url, other = bridge_url(args.host, args.port)
    text = banner(url=url, other=other, code=args.pairing_code.upper(), origins=origins, knx=(host, port))
    announce = asyncio.create_task(announce_when_listening(server, text))
    try:
        await server.serve()
    except SystemExit:
        print(
            f"\nCould not start the bridge on {url} (see the error above). If the port is already in use, for example "
            "by another bridge or the SE7ENX Docker appliance, stop it or choose another port with --port.",
            file=sys.stderr,
            flush=True,
        )
        raise
    finally:
        announce.cancel()


if __name__ == "__main__":
    asyncio.run(main())
