#!/usr/bin/env python3
"""Run the REAL SE7ENX Bridge against the FAKE KNXnet/IP interface in one process.

FOR DEMOS AND AUTOMATED TESTS ONLY. No real KNX hardware is involved: the
bridge tunnels to a simulated interface (reported as "SE7ENX FAKE KNX (TEST
ONLY)") with one simulated switch actuator (switch 0/0/1, status 0/0/2).

    python tools/dev_stack.py --port 8799 --origin http://localhost:3000
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


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--origin", action="append", default=None, help="allowed web origin (repeatable)")
    parser.add_argument("--pairing-code", default=os.environ.get("SE7ENX_PAIRING_CODE", "DEMO-2026"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("xknx").setLevel(logging.WARNING)

    fake = await start_fake_interface("127.0.0.1", 0, actuator=Actuator(switch="0/0/1", status="0/0/2"))
    host, port = fake.address
    logging.getLogger("dev-stack").warning("%s on %s:%s — NOT real hardware", FAKE_NAME, host, port)

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
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
