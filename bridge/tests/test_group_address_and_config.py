from __future__ import annotations

import json
from pathlib import Path

import pytest

from se7enx_bridge.config import ConfigError, Settings
from se7enx_bridge.group_address import (
    GroupAddressError,
    GroupAddressPolicy,
    ga_matches,
    parse_group_address,
    validate_pattern,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "group-address-vectors.json").read_text())


@pytest.mark.parametrize("v", VECTORS["valid"], ids=lambda v: repr(v["input"]))
def test_valid_group_addresses(v: dict) -> None:
    p = parse_group_address(v["input"])
    assert (p.raw, p.canonical, p.style) == (v["raw"], v["canonical"], v["style"])


@pytest.mark.parametrize("v", VECTORS["invalid"], ids=lambda v: repr(v["input"]))
def test_invalid_group_addresses(v: dict) -> None:
    with pytest.raises(GroupAddressError) as exc:
        parse_group_address(v["input"])
    assert exc.value.code == v["code"]


def test_non_string_rejected() -> None:
    with pytest.raises(GroupAddressError):
        parse_group_address(123)


@pytest.mark.parametrize(
    ("ga", "pattern", "expected"),
    [
        ("0/0/1", "0/0/1", True),
        ("0/0/2", "0/0/1", False),
        ("1/2/30", "1/2/*", True),
        ("1/3/30", "1/2/*", False),
        ("0/0/5", "0/0/1-9", True),
        ("0/0/10", "0/0/1-9", False),
        ("31/7/255", "*", True),
    ],
)
def test_allowlist_matching(ga: str, pattern: str, expected: bool) -> None:
    assert ga_matches(ga, pattern) is expected


def test_policy_default_deny() -> None:
    assert GroupAddressPolicy(()).allows("0/0/1") is False
    assert GroupAddressPolicy(("0/0/*",)).allows("0/0/1") is True


@pytest.mark.parametrize("bad", ["1/2", "1/2/3/4", "32/0/0", "1/8/0", "1/2/300", "1/2/9-3", "a/b/c", "1/2/1-300"])
def test_invalid_patterns(bad: str) -> None:
    with pytest.raises(ValueError):
        validate_pattern(bad)


# ----------------------------------------------------------------------------- config


def env(**kv: str) -> dict[str, str]:
    return {f"SE7ENX_{k}": v for k, v in kv.items()}


def test_safe_defaults() -> None:
    s = Settings.from_env({})
    assert s.host == "127.0.0.1"
    assert s.allowed_group_addresses == ()
    assert s.allow_client_gateway is False
    assert s.enable_docs is False
    assert s.connection_type == "automatic"


def test_gateway_implies_tunneling() -> None:
    s = Settings.from_env(env(KNX_GATEWAY_IP="192.168.1.20"))
    assert s.connection_type == "tunneling"
    assert s.gateway_port == 3671


@pytest.mark.parametrize(
    "bad",
    [
        env(ALLOWED_ORIGINS="*"),
        env(ALLOWED_ORIGINS="null"),
        env(ALLOWED_ORIGINS="https://ok.example/path"),
        env(ALLOWED_ORIGINS="ftp://x"),
        env(ALLOWED_GROUP_ADDRESSES="1/2/3,bogus"),
        env(KNX_CONNECTION_TYPE="tunneling"),
        env(KNX_CONNECTION_TYPE="carrier-pigeon"),
        env(PORT="99999"),
        env(PAIRING_CODE="short"),
        env(TLS_CERT="/nonexistent.pem"),
        env(KNX_CONNECTION_TYPE="tunneling_tcp_secure", KNX_GATEWAY_IP="10.0.0.2"),
        env(KNX_BACKBONE_KEY="xyz"),
        env(ENABLE_DOCS="maybe"),
    ],
)
def test_invalid_config_refused(bad: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env(bad)


def test_origins_normalized_and_secrets_masked() -> None:
    s = Settings.from_env(
        env(ALLOWED_ORIGINS="HTTPS://App.Example.com/, http://localhost:3000", PAIRING_CODE="abcd-efgh")
    )
    assert s.allowed_origins == ("https://app.example.com", "http://localhost:3000")
    assert s.pairing_code == "ABCDEFGH"
    described = json.dumps(s.describe())
    assert "ABCDEFGH" not in described
