"""Port of src/strategies/circuit-breaker.ts."""

from __future__ import annotations

import time
from typing import Awaitable, Callable, Optional, TypeVar

from ..contract import CircuitState, ErrorCategory, MeridianError

T = TypeVar("T")


class CircuitOpenError(MeridianError):
    def __init__(self, provider: str, retry_after: Optional[float] = None) -> None:
        super().__init__(
            f"Circuit breaker is OPEN for provider: {provider}",
            ErrorCategory.PROVIDER,
            provider,
            False,
            "",
            {
                "reason": "circuit_breaker_open",
                "nextAttempt": retry_after if retry_after is not None else "unknown",
            },
        )


def _now_ms() -> float:
    return time.monotonic() * 1000


class ProviderCircuitBreaker:
    def __init__(self, provider: str, config: dict | None = None) -> None:
        config = config or {}
        self.provider = provider
        self.failure_threshold = config.get("failure_threshold", 5)
        self.success_threshold = config.get("success_threshold", 2)
        self.timeout = config.get("timeout", 60000)
        self.volume_threshold = config.get("volume_threshold", 10)
        self.rolling_window_ms = config.get("rolling_window_ms", 60000)
        self.error_threshold_percentage = config.get("error_threshold_percentage", 50)

        self.state = CircuitState.CLOSED
        self.failures = 0
        self.successes = 0
        self.next_attempt: Optional[float] = None
        self._recent: list[tuple[bool, float]] = []  # (success, timestamp_ms)

    async def execute(self, fn: Callable[[], Awaitable[T]]) -> T:
        if self.state == CircuitState.OPEN:
            if self.next_attempt is not None and _now_ms() < self.next_attempt:
                raise CircuitOpenError(self.provider, self.next_attempt)
            self.state = CircuitState.HALF_OPEN
            self.successes = 0

        try:
            result = await fn()
        except Exception:
            self._on_failure()
            raise
        self._on_success()
        return result

    def _on_success(self) -> None:
        self._add_result(True)
        if self.state == CircuitState.HALF_OPEN:
            self.successes += 1
            if self.successes >= self.success_threshold:
                self.state = CircuitState.CLOSED
                self.failures = 0
                self.next_attempt = None
        elif self.state == CircuitState.CLOSED:
            self.failures = 0

    def _on_failure(self) -> None:
        self._add_result(False)
        if self.state == CircuitState.HALF_OPEN:
            self.state = CircuitState.OPEN
            self.failures = 0
            self.next_attempt = _now_ms() + self.timeout
        elif self.state == CircuitState.CLOSED:
            self.failures += 1
            if self._should_open_circuit():
                self.state = CircuitState.OPEN
                self.next_attempt = _now_ms() + self.timeout

    def _should_open_circuit(self) -> bool:
        if len(self._recent) < self.volume_threshold:
            return False
        if self.failures >= self.failure_threshold:
            return True

        window_start = _now_ms() - self.rolling_window_ms
        recent_in_window = [r for r in self._recent if r[1] >= window_start]
        if len(recent_in_window) < self.volume_threshold:
            return False

        failures_in_window = sum(1 for ok, _ in recent_in_window if not ok)
        error_rate = (failures_in_window / len(recent_in_window)) * 100
        return error_rate >= self.error_threshold_percentage

    def _add_result(self, success: bool) -> None:
        self._recent.append((success, _now_ms()))
        window_start = _now_ms() - self.rolling_window_ms
        self._recent = [r for r in self._recent if r[1] >= window_start]

    def get_status(self) -> dict:
        return {
            "state": self.state,
            "failures": self.failures,
            "successes": self.successes,
        }

    def reset(self) -> None:
        self.state = CircuitState.CLOSED
        self.failures = 0
        self.successes = 0
        self.next_attempt = None
        self._recent = []
