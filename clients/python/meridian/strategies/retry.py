"""Port of src/strategies/retry.ts."""

from __future__ import annotations

import asyncio
import random
from typing import Awaitable, Callable, TypeVar

from ..contract import IdempotencyLevel

T = TypeVar("T")


class RetryStrategy:
    def __init__(self, config: dict | None = None) -> None:
        config = config or {}
        self.max_retries: int = config.get("max_retries", 0)
        self.base_delay: float = config.get("base_delay", 1000)
        self.max_delay: float = config.get("max_delay", 30000)
        self.jitter: bool = config.get("jitter", True)

    async def execute(
        self,
        fn: Callable[[], Awaitable[T]],
        idempotency_level: IdempotencyLevel,
        has_idempotency_key: bool,
        attempt: int = 0,
    ) -> T:
        try:
            return await fn()
        except Exception as error:  # noqa: BLE001 — mirror the TS catch-all
            if attempt >= self.max_retries:
                raise
            if not self._is_explicitly_retryable(error):
                raise
            if not self._is_idempotency_proven(idempotency_level, has_idempotency_key):
                raise

            delay_ms = self._calculate_delay(attempt)
            await asyncio.sleep(delay_ms / 1000)
            return await self.execute(
                fn, idempotency_level, has_idempotency_key, attempt + 1
            )

    @staticmethod
    def _is_explicitly_retryable(error: Exception) -> bool:
        return getattr(error, "retryable", None) is True

    @staticmethod
    def _is_idempotency_proven(
        idempotency_level: IdempotencyLevel, has_idempotency_key: bool
    ) -> bool:
        if idempotency_level in (IdempotencyLevel.SAFE, IdempotencyLevel.IDEMPOTENT):
            return True
        if idempotency_level == IdempotencyLevel.CONDITIONAL:
            return has_idempotency_key
        return False

    def _calculate_delay(self, attempt: int) -> float:
        delay = self.base_delay * (2**attempt)
        if self.jitter:
            delay += random.random() * 1000
        return min(delay, self.max_delay)
