"""The dev stack must show the bridge URL, never only the fake KNX interface's address.

Regression: the dev stack used to print one address only, the fake KNXnet/IP interface on a random
UDP port (e.g. 127.0.0.1:57096). People entered it in the web app as the bridge URL and got
"Cannot reach the SE7ENX Bridge".
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from .conftest import ROOT

TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

import dev_stack  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _run(args: list[str], *, wait_for_port: int | None, lifetime_s: float) -> tuple[int, str]:
    proc = subprocess.Popen(
        [sys.executable, str(TOOLS / "dev_stack.py"), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=Path(ROOT),
    )
    try:
        if wait_for_port is None:  # expected to exit on its own
            out, _ = proc.communicate(timeout=lifetime_s)
            return proc.returncode, out
        deadline = time.monotonic() + lifetime_s
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{wait_for_port}/api/v1/health", timeout=1).close()
                time.sleep(0.5)  # the banner is printed by a task polling every 50 ms
                break
            except OSError:
                if proc.poll() is not None:
                    break
                time.sleep(0.1)
        if proc.poll() is None:
            proc.terminate()
        out, _ = proc.communicate(timeout=15)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
    return proc.returncode, out


def test_banner_shows_the_bridge_url_and_marks_the_fake_interface_internal() -> None:
    port = _free_port()
    _, out = _run(["--port", str(port), "--pairing-code", "TEST-1234"], wait_for_port=port, lifetime_s=30)
    assert f"Bridge URL — enter this in the web app:   http://127.0.0.1:{port}" in out
    assert "Pairing code:                             TEST-1234" in out
    assert "http://localhost:3000" in out  # allowed web origins are listed
    internal = [line for line in out.splitlines() if "fake KNX interface on udp://" in line]
    assert internal, out
    assert "Internal only" in internal[0]
    assert "NOT the bridge URL" in out
    # The banner only appears once the port is bound, after the startup logs.
    assert out.index("Bridge URL") > out.index("SE7ENX FAKE KNX")


def test_port_in_use_explains_what_to_do() -> None:
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        port = int(blocker.getsockname()[1])
        code, out = _run(["--port", str(port)], wait_for_port=None, lifetime_s=20)
    assert code != 0
    assert "Bridge URL" not in out  # never claim a URL that is not listening
    assert f"Could not start the bridge on http://127.0.0.1:{port}" in out
    assert "--port" in out


def test_bridge_url_for_wildcard_and_ipv6_hosts() -> None:
    assert dev_stack.bridge_url("127.0.0.1", 8787) == ("http://127.0.0.1:8787", None)
    url, other = dev_stack.bridge_url("0.0.0.0", 8787)
    assert url == "http://127.0.0.1:8787"
    assert other is not None and "LAN IP" in other and ":8787" in other
    assert dev_stack.bridge_url("::1", 8799)[0] == "http://[::1]:8799"
