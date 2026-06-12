"""Meridian — native Python engine for the single stable third-party API contract.

Mirrors the TypeScript engine (src/) layer-for-layer and speaks the same
language-neutral contract defined in proto/meridian.proto, so a Python app can:

  * use Meridian natively (this package), or
  * drive the TypeScript engine over gRPC (meridian.grpc_client), or
  * serve the contract to any language (meridian.grpc_server).
"""

from .client import Meridian, ProviderClient
from .contract import (
    CircuitState,
    ErrorCategory,
    ErrorCode,
    IdempotencyLevel,
    MeridianError,
    NormalizedResponse,
    PaginationInfo,
    RateLimitInfo,
    RequestOptions,
    RequestTrace,
    ResponseMeta,
)

__version__ = "0.2.11"

__all__ = [
    "Meridian",
    "ProviderClient",
    "MeridianError",
    "NormalizedResponse",
    "ResponseMeta",
    "RateLimitInfo",
    "PaginationInfo",
    "RequestTrace",
    "RequestOptions",
    "ErrorCategory",
    "ErrorCode",
    "CircuitState",
    "IdempotencyLevel",
]
