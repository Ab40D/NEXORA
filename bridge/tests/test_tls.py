"""Local HTTPS (SE7ENX_TLS=local-ca): CA generation, name constraints, renewal, real handshakes, API."""

from __future__ import annotations

import socket
import ssl
import stat
import threading
from pathlib import Path

import pytest
from cryptography import x509
from fastapi.testclient import TestClient

from se7enx_bridge.api import create_app
from se7enx_bridge.api_tls import create_redirect_app
from se7enx_bridge.config import ConfigError, Settings
from se7enx_bridge.tls import TlsError, ensure_local_tls, normalize_hosts

from .accounts import account_settings


def _handshake(files_cert: Path, files_key: Path, ca: Path, server_hostname: str) -> str:
    """Real TLS handshake over loopback: server presents the hub cert, client trusts only the CA."""
    server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    server_ctx.load_cert_chain(files_cert, files_key)
    client_ctx = ssl.create_default_context(cafile=str(ca))
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            conn, _ = listener.accept()
            with server_ctx.wrap_socket(conn, server_side=True) as tls:
                tls.sendall(b"ok")
        except (OSError, ssl.SSLError) as err:  # client rejected us: that is the test outcome
            errors.append(err)

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    try:
        with (
            socket.create_connection(("127.0.0.1", port), timeout=5) as raw,
            client_ctx.wrap_socket(raw, server_hostname=server_hostname) as tls,
        ):
            return tls.recv(2).decode()
    finally:
        listener.close()
        t.join(timeout=5)


def test_creates_ca_and_server_cert_with_private_keys_protected(tmp_path: Path) -> None:
    files = ensure_local_tls(tmp_path, ["192.168.1.20", "se7enx.local", "localhost", "127.0.0.1"])
    tls_dir = tmp_path / "tls"
    assert stat.S_IMODE((tls_dir / "ca.key").stat().st_mode) == 0o600
    assert stat.S_IMODE((tls_dir / "server.key").stat().st_mode) == 0o600
    assert stat.S_IMODE(tls_dir.stat().st_mode) == 0o700
    ca = x509.load_pem_x509_certificate(files.ca.read_bytes())
    bc = ca.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert bc.ca and bc.path_length == 0
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical
    permitted = {str(n.value) for n in nc.value.permitted_subtrees or []}
    assert {"local", "home.arpa", "localhost", "192.168.0.0/16", "10.0.0.0/8"} <= permitted
    assert set(files.hosts) == {"192.168.1.20", "se7enx.local", "localhost", "127.0.0.1"}
    assert len(files.fingerprint_sha256.split(":")) == 32


def test_real_handshake_trusts_ip_and_local_name(tmp_path: Path) -> None:
    files = ensure_local_tls(tmp_path, ["127.0.0.1", "se7enx.local"])
    assert _handshake(files.cert, files.key, files.ca, "127.0.0.1") == "ok"
    assert _handshake(files.cert, files.key, files.ca, "se7enx.local") == "ok"
    with pytest.raises(ssl.SSLCertVerificationError):
        _handshake(files.cert, files.key, files.ca, "other.local")  # not in the certificate


def test_name_constraints_block_public_names_even_if_signed(tmp_path: Path) -> None:
    """A certificate for a public name signed by the CA (e.g. after a key leak) must not verify."""
    from se7enx_bridge import tls as tls_mod

    files = ensure_local_tls(tmp_path, ["127.0.0.1"])
    ca, ca_key = tls_mod._load_ca(files.ca, tmp_path / "tls" / "ca.key")
    evil, evil_key = tls_mod._issue_server(ca, ca_key, ("example.com",))
    from cryptography.hazmat.primitives import serialization

    cert_path, key_path = tmp_path / "evil.pem", tmp_path / "evil.key"
    cert_path.write_bytes(evil.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        evil_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    with pytest.raises(ssl.SSLCertVerificationError):
        _handshake(cert_path, key_path, files.ca, "example.com")


def test_reuses_and_reissues(tmp_path: Path) -> None:
    a = ensure_local_tls(tmp_path, ["192.168.1.20"])
    b = ensure_local_tls(tmp_path, ["192.168.1.20"])
    assert a.cert.read_bytes() == b.cert.read_bytes()  # unchanged hosts: same certificate
    c = ensure_local_tls(tmp_path, ["192.168.1.20", "10.0.0.7"])
    assert c.fingerprint_sha256 == a.fingerprint_sha256  # same CA: devices stay trusted
    assert set(c.hosts) == {"192.168.1.20", "10.0.0.7"}


def test_rejects_public_ips_and_unsignable_names(tmp_path: Path) -> None:
    with pytest.raises(TlsError, match="Public IP"):
        ensure_local_tls(tmp_path, ["8.8.8.8"])
    ensure_local_tls(tmp_path, ["hub.example.org"])  # custom name: added to the CA constraints at creation
    with pytest.raises(TlsError, match="name constraints"):
        ensure_local_tls(tmp_path, ["other.example.org"])
    with pytest.raises(TlsError):
        normalize_hosts(["not a host!"])


def test_config_parsing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for key in ("SE7ENX_TLS", "SE7ENX_TLS_HOSTS", "SE7ENX_HTTP_REDIRECT_PORT", "SE7ENX_TLS_CERT", "SE7ENX_TLS_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SE7ENX_TLS", "local-ca")
    monkeypatch.setenv("SE7ENX_TLS_HOSTS", "192.168.1.20, hub.lan")
    monkeypatch.setenv("SE7ENX_HTTP_REDIRECT_PORT", "8780")
    s = Settings.from_env()
    assert s.tls_mode == "local-ca" and s.tls_hosts == ("192.168.1.20", "hub.lan") and s.http_redirect_port == 8780
    monkeypatch.setenv("SE7ENX_TLS", "maybe")
    with pytest.raises(ConfigError):
        Settings.from_env()
    monkeypatch.setenv("SE7ENX_TLS", "off")
    with pytest.raises(ConfigError, match="needs HTTPS"):
        Settings.from_env()


def test_tls_api_serves_only_public_material(tmp_path: Path) -> None:
    files = ensure_local_tls(tmp_path, ["testserver", "127.0.0.1"])
    settings = account_settings(tmp_path, tls_mode="local-ca", tls_cert=str(files.cert), tls_key=str(files.key))
    with TestClient(create_app(settings)) as c:
        st = c.get("/api/v1/tls").json()
        assert st["mode"] == "local-ca" and st["caDownload"] is True
        assert st["fingerprintSha256"] == files.fingerprint_sha256
        assert st["requestHostCovered"] is True and "testserver" in st["certificateHosts"]
        r = c.get("/api/v1/tls/ca.crt")
        assert r.status_code == 200 and r.headers["content-type"] == "application/x-x509-ca-cert"
        assert r.content == files.ca.read_bytes() and b"PRIVATE KEY" not in r.content
        page = c.get("/setup/ca")
        assert page.status_code == 200 and files.fingerprint_sha256 in page.text
        assert "script" not in page.text.lower()
        assert "Strict-Transport-Security" not in r.headers  # never HSTS-pin a local CA


def test_tls_api_without_local_ca(tmp_path: Path) -> None:
    with TestClient(create_app(account_settings(tmp_path))) as c:
        assert c.get("/api/v1/tls").json()["mode"] == "off"
        assert c.get("/api/v1/tls/ca.crt").status_code == 404
        assert c.get("/setup/ca").status_code == 404


def test_redirect_helper(tmp_path: Path) -> None:
    ensure_local_tls(tmp_path, ["192.168.1.20"])
    settings = account_settings(
        tmp_path, tls_mode="local-ca", allowed_hosts=("auto",), port=8787, http_redirect_port=8780
    )
    c = TestClient(create_redirect_app(settings), base_url="http://192.168.1.20:8780")
    r = c.get("/devices?x=1", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "https://192.168.1.20:8787/devices?x=1"
    page = c.get("/")
    assert page.status_code == 200 and "https://192.168.1.20:8787/" in page.text
    assert c.get("/api/v1/tls/ca.crt").status_code == 200
    evil = c.get("/", headers={"Host": "evil.example.com"}, follow_redirects=False)
    assert evil.status_code == 421  # no open redirect to arbitrary hosts
    assert c.post("/api/v1/auth/login", follow_redirects=False).status_code == 308  # no API over HTTP
