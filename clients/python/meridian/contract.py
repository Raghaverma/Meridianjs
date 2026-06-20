"""The single stable Meridian contract, ported to Python.

This mirrors ``src/core/types.ts`` field-for-field so the Python engine and the
TypeScript engine agree on shapes and error semantics. The proto in
``proto/meridian.proto`` is the cross-language wire form of these same types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping, Optional, TypeVar

_T = TypeVar("_T")


class ErrorCategory(str, Enum):
    AUTH = "auth"
    RATE_LIMIT = "rate_limit"
    NETWORK = "network"
    PROVIDER = "provider"
    VALIDATION = "validation"


class ErrorCode(str, Enum):
    AUTH_FAILED = "AUTH_FAILED"
    RATE_LIMITED = "RATE_LIMITED"
    NOT_FOUND = "NOT_FOUND"
    BAD_REQUEST = "BAD_REQUEST"
    UPSTREAM_5XX = "UPSTREAM_5XX"
    NETWORK_ERROR = "NETWORK_ERROR"
    TIMEOUT = "TIMEOUT"
    UNKNOWN = "UNKNOWN"


class CircuitState(str, Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class IdempotencyLevel(str, Enum):
    SAFE = "SAFE"
    IDEMPOTENT = "IDEMPOTENT"
    CONDITIONAL = "CONDITIONAL"
    UNSAFE = "UNSAFE"


def map_category_to_error_code(category: ErrorCategory, status: Optional[int] = None) -> ErrorCode:
    """Port of ``mapCategoryToErrorCode`` in src/core/types.ts."""
    if category == ErrorCategory.AUTH:
        return ErrorCode.AUTH_FAILED
    if category == ErrorCategory.RATE_LIMIT:
        return ErrorCode.RATE_LIMITED
    if category == ErrorCategory.NETWORK:
        return ErrorCode.NETWORK_ERROR
    if category == ErrorCategory.VALIDATION:
        if status == 404:
            return ErrorCode.NOT_FOUND
        return ErrorCode.BAD_REQUEST
    if category == ErrorCategory.PROVIDER:
        if status is not None and status >= 500:
            return ErrorCode.UPSTREAM_5XX
        return ErrorCode.UNKNOWN
    return ErrorCode.UNKNOWN


def is_retryable_by_code(code: ErrorCode) -> bool:
    """Port of ``isRetryableByCode`` in src/core/types.ts."""
    return code in (
        ErrorCode.NETWORK_ERROR,
        ErrorCode.TIMEOUT,
        ErrorCode.UPSTREAM_5XX,
        ErrorCode.RATE_LIMITED,
    )


class Headers:
    """Case-insensitive header bag, mirroring the browser ``Headers`` the TS
    adapters read from."""

    def __init__(self, initial: Optional[Mapping[str, str]] = None) -> None:
        self._store: dict[str, str] = {}
        if initial:
            for key, value in initial.items():
                self._store[key.lower()] = value

    def get(self, name: str, default: Optional[str] = None) -> Optional[str]:
        return self._store.get(name.lower(), default)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name.lower() in self._store

    def items(self):
        return self._store.items()


@dataclass
class RateLimitInfo:
    limit: int
    remaining: int
    reset: datetime


@dataclass
class PaginationInfo:
    has_next: bool
    cursor: Optional[str] = None
    total: Optional[int] = None


@dataclass
class RequestTrace:
    retries: int
    latency: float
    circuit_breaker: CircuitState
    rate_limit_remaining: int


@dataclass
class ResponseMeta:
    provider: str
    request_id: str
    rate_limit: RateLimitInfo
    schema_version: str = "1.0.0"
    warnings: list[str] = field(default_factory=list)
    pagination: Optional[PaginationInfo] = None
    trace: Optional[RequestTrace] = None


@dataclass
class NormalizedResponse:
    data: Any
    meta: ResponseMeta


@dataclass
class RequestOptions:
    method: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    body: Any = None
    query: Optional[dict[str, Any]] = None
    idempotency_key: Optional[str] = None
    timeout: Optional[float] = None
    identity: Optional[str] = None


@dataclass
class RawResponse:
    status: int
    headers: Headers
    body: Any


@dataclass
class AuthConfig:
    token: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    custom: Optional[dict[str, str]] = None


@dataclass
class AuthToken:
    token: str
    secret: Optional[str] = None
    expires_at: Optional[datetime] = None


@dataclass
class AdapterInput:
    endpoint: str
    options: RequestOptions
    auth_token: AuthToken
    base_url: Optional[str] = None


@dataclass
class BuiltRequest:
    url: str
    method: str
    headers: dict[str, str]
    body: Optional[str] = None


@dataclass
class IdempotencyConfig:
    default_safe_operations: set[str] = field(
        default_factory=lambda: {"GET", "HEAD", "OPTIONS"}
    )
    operation_overrides: dict[str, IdempotencyLevel] = field(default_factory=dict)


class HttpError(Exception):
    """Raised by the transport for a non-2xx upstream response. Mirrors the
    ``{ status, headers, body }`` object the TS pipeline throws on ``!response.ok``;
    adapters map it to a :class:`MeridianError` via ``parse_error``."""

    def __init__(self, status: int, headers: "Headers", body: Any) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.headers = headers
        self.body = body


class MeridianError(Exception):
    """Port of the ``MeridianError`` class in src/core/types.ts."""

    def __init__(
        self,
        message: str,
        category: ErrorCategory,
        provider: str,
        retryable: bool,
        request_id: str = "",
        metadata: Optional[dict[str, Any]] = None,
        retry_after: Optional[datetime] = None,
        status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.category = category
        self.provider = provider
        self.retryable = retryable
        self.request_id = request_id
        self.metadata = metadata
        self.retry_after = retry_after
        self.status = status

    @property
    def code(self) -> ErrorCode:
        return map_category_to_error_code(self.category, self.status)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Chunk:
    """One SSE token delta from a StreamCall response.

    Mirrors Go's ``Chunk`` struct and Rust's ``Chunk`` struct field-for-field.
    ``done=True`` on the terminal chunk; ``data`` is ``None`` on that chunk.
    """

    data: Any
    index: int
    event: str
    raw: str

    def decode(self, cls: type[_T]) -> _T:
        """Deserialise ``data`` into ``cls`` by passing it as keyword arguments."""
        if not isinstance(self.data, dict):
            raise TypeError(f"Cannot decode non-dict data into {cls}")
        return cls(**self.data)
