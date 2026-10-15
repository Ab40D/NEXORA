"""Command line entry point.

python -m se7enx_bridge              start the bridge (default)
python -m se7enx_bridge scan         search the LAN for KNXnet/IP interfaces
python -m se7enx_bridge check-config validate configuration and print it (secrets masked)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from . import __version__
from .config import ConfigError, Settings


def _setup_logging(level: str) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    if level != "DEBUG":
        logging.getLogger("xknx").setLevel(logging.WARNING)
        logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def _load() -> Settings:
    try:
        return Settings.from_env()
    except ConfigError as err:
        print(f"Configuration error: {err}", file=sys.stderr)
        sys.exit(2)


def cmd_serve(settings: Settings) -> None:
    import uvicorn

    from .api import create_app

    _setup_logging(settings.log_level)
    log = logging.getLogger("se7enx")
    log.info(
        "SE7ENX Bridge %s starting on %s://%s:%s",
        __version__,
        "https" if settings.tls_cert else "http",
        settings.host,
        settings.port,
    )
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning(
            "Listening on %s — the API is reachable from your network. Pairing is required; never expose this port to the internet.",
            settings.host,
        )
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        loop="asyncio",  # xknx is tested on the standard asyncio loop
        log_level=settings.log_level.lower(),
        ssl_certfile=settings.tls_cert,
        ssl_keyfile=settings.tls_key,
        proxy_headers=settings.trust_proxy,
        forwarded_allow_ips="*" if settings.trust_proxy else "127.0.0.1",
        server_header=False,
        timeout_graceful_shutdown=5,
    )


def cmd_scan(settings: Settings) -> None:
    from .knx import KnxService

    _setup_logging("WARNING")

    async def run() -> None:
        found = await KnxService(settings).discover(wait_s=4.0)
        if not found:
            print("No KNXnet/IP interfaces or routers answered (multicast may be blocked on this network).")
            return
        for g in found:
            caps = ", ".join(
                c
                for c, ok in (
                    ("tunnelling TCP", g["supportsTunnellingTcp"]),
                    ("tunnelling UDP", g["supportsTunnelling"]),
                    ("routing", g["supportsRouting"]),
                    ("KNX Secure required", g["requiresSecure"]),
                )
                if ok
            )
            print(f"{g['name']:<32} {g['host']}:{g['port']:<6} {g['individualAddress'] or '?':<10} {caps}")

    asyncio.run(run())


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="se7enx-bridge", description="SE7ENX Bridge — KNX gateway for the SE7ENX Smart Light web app"
    )
    parser.add_argument("command", nargs="?", default="serve", choices=["serve", "scan", "check-config"])
    parser.add_argument("--version", action="version", version=f"se7enx-bridge {__version__}")
    args = parser.parse_args()
    settings = _load()
    if args.command == "scan":
        cmd_scan(settings)
    elif args.command == "check-config":
        print(json.dumps(settings.describe(), indent=2))
    else:
        cmd_serve(settings)


if __name__ == "__main__":
    main()
