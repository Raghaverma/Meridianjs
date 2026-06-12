"""Port of src/strategies/idempotency.ts."""

from __future__ import annotations

import re
from typing import Optional

from ..contract import IdempotencyConfig, IdempotencyLevel


class IdempotencyResolver:
    def __init__(
        self,
        config: Optional[IdempotencyConfig] = None,
        default_level: IdempotencyLevel = IdempotencyLevel.SAFE,
    ) -> None:
        self.config = config or IdempotencyConfig()
        self.default_level = default_level

    def get_idempotency_level(self, method: str, endpoint: str) -> IdempotencyLevel:
        operation_key = f"{method} {endpoint}"
        override = self._find_override(operation_key)
        if override is not None:
            return override
        if method.upper() in self.config.default_safe_operations:
            return IdempotencyLevel.SAFE
        return self.default_level

    def _find_override(self, operation_key: str) -> Optional[IdempotencyLevel]:
        overrides = self.config.operation_overrides
        if operation_key in overrides:
            return overrides[operation_key]
        for pattern, level in overrides.items():
            if self._matches_pattern(pattern, operation_key):
                return level
        return None

    @staticmethod
    def _matches_pattern(pattern: str, operation_key: str) -> bool:
        # Replace :param segments with a non-slash wildcard, mirroring the TS regex.
        regex_pattern = re.sub(r":[\w-]+", "[^/]+", pattern)
        return re.fullmatch(regex_pattern, operation_key) is not None
