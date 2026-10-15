from __future__ import annotations

from se7enx_bridge.security import (
    CODE_ALPHABET,
    PairingManager,
    SessionStore,
    SlidingWindowLimiter,
    format_code,
    normalize_code,
)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def test_random_codes_are_single_use_and_rotate() -> None:
    announced: list[str] = []
    clock = Clock()
    pm = PairingManager(None, ttl_s=60, on_new_code=announced.append, clock=clock)
    code = pm.current_code()
    assert len(code) == 8 and all(c in CODE_ALPHABET for c in code)
    assert pm.verify(format_code(code).lower())  # dash and case tolerated
    assert not pm.verify(code)  # single use
    assert len(announced) == 2  # startup + rotation after use


def test_codes_expire() -> None:
    clock = Clock()
    pm = PairingManager(None, ttl_s=60, clock=clock)
    old = pm.current_code()
    clock.t += 61
    assert not pm.verify(old) or pm.current_code() != old


def test_lockout_after_repeated_failures() -> None:
    clock = Clock()
    pm = PairingManager("FIXEDCODE", ttl_s=60, clock=clock, max_failures=3, lockout_s=300)
    for _ in range(3):
        assert not pm.verify("WRONGCODE")
    assert pm.locked_for() > 0
    assert not pm.verify("FIXEDCODE")  # locked even with the right code
    clock.t += 301
    assert pm.verify("FIXEDCODE")


def test_fixed_code_reusable() -> None:
    pm = PairingManager("fixed-code-1", ttl_s=60)
    assert pm.verify("FIXEDCODE1") and pm.verify("fixedcode1")
    assert normalize_code("ab-cd ef") == "ABCDEF"


def test_sessions_expire_hash_tokens_and_cap() -> None:
    clock = Clock()
    store = SessionStore(ttl_s=100, max_sessions=2, clock=clock)
    t1, s1 = store.create("a", "1.1.1.1")
    t2, _ = store.create("b", "1.1.1.1")
    assert t1 not in s1.token_hash  # only the hash is stored
    assert store.authenticate(t1) is s1
    store.create("c", "1.1.1.1")  # evicts the oldest
    assert store.authenticate(t1) is None
    assert store.authenticate(t2) is not None
    clock.t += 101
    assert store.authenticate(t2) is None
    assert store.authenticate("") is None and store.authenticate("x" * 500) is None


def test_revocation_listener() -> None:
    store = SessionStore(ttl_s=100, max_sessions=5)
    revoked = []
    store.on_revoked(revoked.append)
    _, s = store.create("a", "ip")
    store.revoke(s)
    assert revoked == [s]
    assert not store.is_active(s)


def test_sliding_window_limiter() -> None:
    clock = Clock()
    lim = SlidingWindowLimiter(2, 10, clock=clock)
    assert lim.hit("k")[0] and lim.hit("k")[0]
    ok, retry = lim.hit("k")
    assert not ok and 0 < retry <= 10
    assert lim.hit("other")[0]
    clock.t += 10
    assert lim.hit("k")[0]
