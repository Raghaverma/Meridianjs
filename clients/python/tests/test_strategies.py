from __future__ import annotations

import asyncio

import pytest

from meridian.contract import ErrorCategory, IdempotencyLevel, MeridianError
from meridian.providers.github import GitHubAdapter
from meridian.strategies.circuit_breaker import CircuitOpenError, ProviderCircuitBreaker
from meridian.strategies.idempotency import IdempotencyResolver
from meridian.strategies.rate_limit import RateLimiter
from meridian.strategies.retry import RetryStrategy


def _fast_retry(max_retries: int) -> RetryStrategy:
    return RetryStrategy({"max_retries": max_retries, "base_delay": 1, "jitter": False})


async def test_retry_retries_retryable_until_success():
    calls = {"n": 0}

    async def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise MeridianError("temporary", ErrorCategory.NETWORK, "p", True)
        return "ok"

    out = await _fast_retry(3).execute(fn, IdempotencyLevel.SAFE, False)
    assert out == "ok"
    assert calls["n"] == 3


async def test_retry_skips_non_retryable():
    calls = {"n": 0}

    async def fn():
        calls["n"] += 1
        raise MeridianError("nope", ErrorCategory.VALIDATION, "p", False)

    with pytest.raises(MeridianError):
        await _fast_retry(3).execute(fn, IdempotencyLevel.SAFE, False)
    assert calls["n"] == 1


async def test_retry_unsafe_is_never_retried_even_if_retryable():
    calls = {"n": 0}

    async def fn():
        calls["n"] += 1
        raise MeridianError("temporary", ErrorCategory.NETWORK, "p", True)

    with pytest.raises(MeridianError):
        await _fast_retry(3).execute(fn, IdempotencyLevel.UNSAFE, False)
    assert calls["n"] == 1


async def test_retry_conditional_requires_idempotency_key():
    async def fn():
        raise MeridianError("temporary", ErrorCategory.NETWORK, "p", True)

    # Without a key, CONDITIONAL is not retried.
    calls = {"n": 0}

    async def counted():
        calls["n"] += 1
        await fn()

    with pytest.raises(MeridianError):
        await _fast_retry(2).execute(counted, IdempotencyLevel.CONDITIONAL, False)
    assert calls["n"] == 1


async def test_circuit_opens_after_failure_threshold():
    cb = ProviderCircuitBreaker("p", {"failure_threshold": 3, "volume_threshold": 3})

    async def fail():
        raise RuntimeError("boom")

    for _ in range(3):
        with pytest.raises(RuntimeError):
            await cb.execute(fail)

    with pytest.raises(CircuitOpenError):
        await cb.execute(fail)


async def test_rate_limiter_consumes_and_refills():
    rl = RateLimiter({"max_tokens": 1, "tokens_per_second": 10000})
    await rl.acquire()  # consume the only token
    # High refill rate means the next acquire completes quickly.
    await asyncio.wait_for(rl.acquire(), timeout=1.0)


def test_idempotency_resolver_overrides_and_patterns():
    resolver = IdempotencyResolver(GitHubAdapter().get_idempotency_config())
    assert resolver.get_idempotency_level("GET", "/repos/x/y") == IdempotencyLevel.SAFE
    assert (
        resolver.get_idempotency_level("POST", "/repos/octocat/hello/pulls")
        == IdempotencyLevel.CONDITIONAL
    )
    assert (
        resolver.get_idempotency_level("DELETE", "/repos/octocat/hello")
        == IdempotencyLevel.IDEMPOTENT
    )
    assert resolver.get_idempotency_level("GET", "/search/code") == IdempotencyLevel.UNSAFE
