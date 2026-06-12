"""Port of src/strategies/rate-limit.ts (token bucket with adaptive backoff)."""

from __future__ import annotations

import asyncio
import time

from ..contract import RateLimitInfo


def _now_ms() -> float:
    return time.monotonic() * 1000


class RateLimiter:
    def __init__(self, config: dict | None = None) -> None:
        config = config or {}
        self.tokens_per_second: float = config.get("tokens_per_second", 10)
        self.max_tokens: float = config.get("max_tokens", 100)
        self.adaptive_backoff: bool = config.get("adaptive_backoff", True)
        self.queue_size: int = config.get("queue_size", 50)

        self.tokens: float = self.max_tokens
        self.last_refill: float = _now_ms()
        self._waiters = 0

    async def acquire(self) -> None:
        self._refill()
        if self.tokens >= 1:
            self.tokens -= 1
            return

        if self.queue_size and self._waiters >= self.queue_size:
            raise RuntimeError("Rate limit queue is full")

        self._waiters += 1
        try:
            while True:
                self._refill()
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait_s = (1 / self.tokens_per_second) if self.tokens_per_second > 0 else 0.05
                await asyncio.sleep(wait_s)
        finally:
            self._waiters -= 1

    def _refill(self) -> None:
        now = _now_ms()
        elapsed = max(0.0, (now - self.last_refill) / 1000)
        tokens_to_add = elapsed * self.tokens_per_second
        if tokens_to_add > 0:
            self.tokens = min(self.max_tokens, self.tokens + tokens_to_add)
            self.last_refill = now

    def update_from_headers(self, rate_limit_info: RateLimitInfo) -> None:
        if not self.adaptive_backoff:
            return
        remaining = rate_limit_info.remaining
        limit = rate_limit_info.limit
        if limit <= 0:
            return

        utilization = (limit - remaining) / limit
        if utilization > 0.8:
            self.tokens_per_second = max(1, self.tokens_per_second * 0.5)

        reset_ms = rate_limit_info.reset.timestamp() * 1000
        time_until_reset = reset_ms - (time.time() * 1000)
        if time_until_reset > 0 and remaining < limit:
            tokens_needed = limit - remaining
            new_rate = tokens_needed / (time_until_reset / 1000)
            if 0 < new_rate < self.tokens_per_second:
                self.tokens_per_second = new_rate

    def handle_429(self, retry_after_seconds: float) -> None:
        if self.adaptive_backoff:
            self.last_refill = _now_ms() + retry_after_seconds * 1000

    def reset(self) -> None:
        self.tokens = self.max_tokens
        self.last_refill = _now_ms()
