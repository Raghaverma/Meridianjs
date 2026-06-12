"""ProviderAdapter ABC — port of the ProviderAdapter interface in src/core/types.ts."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .contract import (
    AdapterInput,
    AuthConfig,
    AuthToken,
    BuiltRequest,
    Headers,
    IdempotencyConfig,
    MeridianError,
    NormalizedResponse,
    RateLimitInfo,
    RawResponse,
)
from .strategies.pagination import PaginationStrategy


class ProviderAdapter(ABC):
    @abstractmethod
    def build_request(self, input: AdapterInput) -> BuiltRequest: ...

    @abstractmethod
    def parse_response(self, raw: RawResponse) -> NormalizedResponse: ...

    @abstractmethod
    def parse_error(self, raw: Any) -> MeridianError: ...

    @abstractmethod
    async def auth_strategy(self, config: AuthConfig) -> AuthToken: ...

    @abstractmethod
    def rate_limit_policy(self, headers: Headers) -> RateLimitInfo: ...

    @abstractmethod
    def pagination_strategy(self) -> PaginationStrategy: ...

    @abstractmethod
    def get_idempotency_config(self) -> IdempotencyConfig: ...

    # Optional capability hooks (mirroring the optional TS methods).
    def verify_webhook(self, payload: bytes | str, signature: str, secret: str) -> bool:
        raise NotImplementedError

    def capabilities(self) -> list[str]:
        return []
