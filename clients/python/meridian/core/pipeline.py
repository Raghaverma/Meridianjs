"""Port of src/core/pipeline.ts — the resilience pipeline that wraps every request.

Order of layers (matching the TypeScript engine):
  auth → rate limiter → retry( circuit breaker( http transport ) ) → normalize → trace
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..adapter import ProviderAdapter
from ..contract import (
    AuthConfig,
    AuthToken,
    BuiltRequest,
    ErrorCategory,
    Headers,
    HttpError,
    MeridianError,
    NormalizedResponse,
    RequestOptions,
    RequestTrace,
    now_utc,
)
from ..strategies.circuit_breaker import ProviderCircuitBreaker
from ..strategies.idempotency import IdempotencyResolver
from ..strategies.rate_limit import RateLimiter
from ..strategies.retry import RetryStrategy
from .endpoint_validator import assert_safe_endpoint
from .sanitizer import sanitize_request_options

Transport = Callable[[BuiltRequest, float], Awaitable["RawResponseT"]]

# Re-export name for readability.
from ..contract import RawResponse as RawResponseT  # noqa: E402


async def _httpx_transport(built: BuiltRequest, timeout: float) -> RawResponseT:
    """Default transport: perform the request with httpx and normalize the result.

    Raises :class:`MeridianError` (network, retryable) on timeout/connection
    failures and :class:`HttpError` on any non-2xx response — mirroring the
    TypeScript ``executeHttpRequest``.
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.request(
                built.method,
                built.url,
                headers=built.headers,
                content=built.body,
            )
        except httpx.TimeoutException as exc:
            raise MeridianError(
                f"Request timeout after {timeout}s",
                ErrorCategory.NETWORK,
                "",
                True,
                "",
                {"url": built.url, "method": built.method},
            ) from exc
        except httpx.RequestError as exc:
            raise MeridianError(
                "Network request failed. Check your connection and try again.",
                ErrorCategory.NETWORK,
                "",
                True,
                "",
                {"originalError": str(exc)},
            ) from exc

        content_type = response.headers.get("content-type", "")
        try:
            body: Any = response.json() if "application/json" in content_type else response.text
        except ValueError:
            body = {}

        headers = Headers(dict(response.headers))
        if response.status_code >= 400:
            raise HttpError(response.status_code, headers, body)
        return RawResponseT(status=response.status_code, headers=headers, body=body)


class RequestPipeline:
    def __init__(
        self,
        provider: str,
        adapter: ProviderAdapter,
        auth_config: AuthConfig,
        circuit_breaker: ProviderCircuitBreaker,
        rate_limiter: RateLimiter,
        retry_strategy: RetryStrategy,
        idempotency_resolver: IdempotencyResolver,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        auto_generate_idempotency_keys: bool = False,
        transport: Optional[Transport] = None,
        compliance: Optional[dict] = None,
    ) -> None:
        self.provider = provider
        self.adapter = adapter
        self.auth_config = auth_config
        self.circuit_breaker = circuit_breaker
        self.rate_limiter = rate_limiter
        self.retry_strategy = retry_strategy
        self.idempotency_resolver = idempotency_resolver
        self.base_url = base_url
        self.timeout = timeout if timeout is not None else 30.0
        self.auto_generate_idempotency_keys = auto_generate_idempotency_keys
        self.transport = transport or _httpx_transport
        self.compliance = compliance or {}
        self._cached_token: Optional[AuthToken] = None

    async def _get_auth_token(self) -> AuthToken:
        if self._cached_token is not None:
            if self._cached_token.expires_at is None:
                return self._cached_token
            if self._cached_token.expires_at.timestamp() - 60 > time.time():
                return self._cached_token
        token = await self.adapter.auth_strategy(self.auth_config)
        self._cached_token = token
        return token

    async def execute(
        self, endpoint: str, options: Optional[RequestOptions] = None
    ) -> NormalizedResponse:
        options = options or RequestOptions()
        request_id = str(uuid.uuid4())
        method = (options.method or "GET").upper()
        start = time.monotonic()

        assert_safe_endpoint(endpoint, self.provider, request_id)

        if self.auto_generate_idempotency_keys and not options.idempotency_key:
            options.idempotency_key = str(uuid.uuid4())

        idempotency_level = self.idempotency_resolver.get_idempotency_level(method, endpoint)

        # Apply redaction policy (used for observability; the live request keeps
        # the original options). We sanitize to validate the path is exercised.
        sanitize_request_options(
            options,
            pii_redaction=bool(self.compliance.get("pii_redaction")),
            india_mode=bool(self.compliance.get("india_mode")),
        )

        retry_count = {"n": 0}

        async def attempt() -> RawResponseT:
            retry_count["n"] += 1

            async def do_request() -> RawResponseT:
                token = await self._get_auth_token()
                return await self._execute_http(endpoint, options, token)

            return await self.circuit_breaker.execute(do_request)

        try:
            await self._get_auth_token()
            await self.rate_limiter.acquire()

            response = await self.retry_strategy.execute(
                attempt, idempotency_level, bool(options.idempotency_key)
            )

            rate_limit_info = self.adapter.rate_limit_policy(response.headers)
            self.rate_limiter.update_from_headers(rate_limit_info)

            normalized = self.adapter.parse_response(response)
            normalized.meta.request_id = request_id
            duration = (time.monotonic() - start) * 1000
            normalized.meta.trace = RequestTrace(
                retries=retry_count["n"] - 1,
                latency=duration,
                circuit_breaker=self.circuit_breaker.state,
                rate_limit_remaining=rate_limit_info.remaining,
            )
            return normalized
        except Exception as error:  # noqa: BLE001 — mirror the TS catch-all
            meridian_error = self._to_meridian_error(error, request_id)
            if (
                meridian_error.category == ErrorCategory.RATE_LIMIT
                and meridian_error.retry_after is not None
            ):
                seconds = (meridian_error.retry_after - now_utc()).total_seconds()
                self.rate_limiter.handle_429(seconds)
            raise meridian_error from error

    def _to_meridian_error(self, error: Exception, request_id: str) -> MeridianError:
        try:
            parsed = self.adapter.parse_error(error)
        except Exception:  # noqa: BLE001
            parsed = MeridianError(
                str(error), ErrorCategory.PROVIDER, self.provider, False, request_id
            )
        if not parsed.request_id:
            parsed.request_id = request_id
        if not parsed.provider:
            parsed.provider = self.provider
        return parsed

    async def _execute_http(
        self, endpoint: str, options: RequestOptions, auth_token: AuthToken
    ) -> RawResponseT:
        from ..contract import AdapterInput

        built = self.adapter.build_request(
            AdapterInput(
                endpoint=endpoint,
                options=options,
                auth_token=auth_token,
                base_url=self.base_url,
            )
        )
        return await self.transport(built, self.timeout)
