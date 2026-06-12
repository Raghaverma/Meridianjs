"""Port of src/providers/anthropic/{adapter,pagination}.ts."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..adapter import ProviderAdapter
from ..contract import (
    AdapterInput,
    AuthConfig,
    AuthToken,
    BuiltRequest,
    ErrorCategory,
    Headers,
    HttpError,
    IdempotencyConfig,
    IdempotencyLevel,
    MeridianError,
    NormalizedResponse,
    RateLimitInfo,
    RawResponse,
    RequestOptions,
)
from ..core.normalizer import ResponseNormalizer
from ..strategies.pagination import PaginationStrategy
from ._common import SDK_VERSION, build_url, extract_retry_after


class AnthropicPaginationStrategy(PaginationStrategy):
    def extract_cursor(self, response: RawResponse) -> Optional[str]:
        if isinstance(response.body, dict):
            if response.body.get("has_more") is True and isinstance(
                response.body.get("last_id"), str
            ):
                return response.body["last_id"]
        return None

    def extract_total(self, response: RawResponse) -> Optional[int]:
        return None

    def has_next(self, response: RawResponse) -> bool:
        return isinstance(response.body, dict) and response.body.get("has_more") is True

    def build_next_request(
        self, endpoint: str, options: RequestOptions, cursor: str
    ) -> tuple[str, RequestOptions]:
        query = dict(options.query or {})
        query["after_id"] = cursor
        return endpoint, RequestOptions(
            method=options.method, headers=options.headers, body=options.body,
            query=query, idempotency_key=options.idempotency_key,
            timeout=options.timeout, identity=options.identity,
        )


class AnthropicAdapter(ProviderAdapter):
    def __init__(self, base_url: str = "https://api.anthropic.com") -> None:
        self.base_url = base_url

    def build_request(self, input: AdapterInput) -> BuiltRequest:
        base_url = input.base_url or self.base_url
        options = input.options
        url = build_url(base_url, input.endpoint, options.query)
        headers: dict[str, str] = {
            "anthropic-version": "2023-06-01",
            "User-Agent": f"Meridian-SDK/{SDK_VERSION}",
            **(options.headers or {}),
        }
        if input.auth_token.token:
            headers["x-api-key"] = input.auth_token.token
        if options.idempotency_key:
            headers["X-Idempotency-Key"] = options.idempotency_key
        body: Optional[str] = None
        method = (options.method or "GET").upper()
        if options.body is not None and method not in ("GET", "HEAD"):
            body = json.dumps(options.body)
            headers["Content-Type"] = "application/json"
        return BuiltRequest(url=url, method=method, headers=headers, body=body)

    def parse_response(self, raw: RawResponse) -> NormalizedResponse:
        rl = self.rate_limit_policy(raw.headers)
        pagination = ResponseNormalizer.extract_pagination_info(raw, self.pagination_strategy())
        return ResponseNormalizer.normalize(raw, "anthropic", rl, pagination, [], "1.0.0")

    def parse_error(self, raw: Any) -> MeridianError:
        if isinstance(raw, MeridianError):
            return raw
        if isinstance(raw, HttpError):
            return self._parse_http_error(raw)
        if isinstance(raw, Exception):
            msg = str(raw).lower()
            if any(k in msg for k in ("fetch", "network", "econnreset", "etimedout", "enotfound", "timeout")):
                return self._error(ErrorCategory.NETWORK, True, "Network request failed. Check your connection and try again.", {"originalError": str(raw)})
        return self._error(ErrorCategory.PROVIDER, False, "An unexpected error occurred", {"raw": str(raw)})

    def _parse_http_error(self, error: HttpError) -> MeridianError:
        status = error.status
        body = error.body if isinstance(error.body, dict) else {}
        err = body.get("error") if isinstance(body.get("error"), dict) else {}
        message = err.get("message")
        headers = error.headers

        if status == 401:
            return self._error(ErrorCategory.AUTH, False, message or "Authentication failed. Check your Anthropic API key.", {"anthropicError": err}, None, 401)
        if status == 403:
            return self._error(ErrorCategory.AUTH, False, message or "Permission denied. Your API key lacks the required permissions.", {"anthropicError": err}, None, 403)
        if status == 404:
            return self._error(ErrorCategory.VALIDATION, False, message or "Resource not found.", {"anthropicError": err}, None, 404)
        if status == 422:
            return self._error(ErrorCategory.VALIDATION, False, message or "Request validation failed.", {"anthropicError": err}, None, 422)
        if status == 429:
            retry_after = extract_retry_after(headers)
            return self._error(ErrorCategory.RATE_LIMIT, True, message or "Rate limit exceeded. Please wait before retrying.", {"anthropicError": err}, retry_after, 429)
        if status == 529:
            return self._error(ErrorCategory.PROVIDER, True, message or "Anthropic API is temporarily overloaded. Retrying with backoff.", {"anthropicError": err}, None, 529)
        if status >= 500:
            return self._error(ErrorCategory.PROVIDER, True, message or f"Anthropic API returned error {status}. This may be temporary.", {"status": status}, None, status)
        if status >= 400:
            return self._error(ErrorCategory.VALIDATION, False, message or f"Request failed with status {status}.", {"status": status}, None, status)
        return self._error(ErrorCategory.PROVIDER, False, f"Unexpected response status {status}.", {"status": status}, None, status)

    async def auth_strategy(self, config: AuthConfig) -> AuthToken:
        token = config.token or config.api_key
        if not token:
            raise self._error(ErrorCategory.AUTH, False, "Anthropic authentication requires an API key. Set auth.token to your Anthropic API key.", {}, None, 401)
        return AuthToken(token=token)

    def rate_limit_policy(self, headers: Headers) -> RateLimitInfo:
        try:
            limit = int(headers.get("anthropic-ratelimit-requests-limit") or "")
            remaining = int(headers.get("anthropic-ratelimit-requests-remaining") or "")
        except ValueError:
            limit = remaining = None  # type: ignore[assignment]
        reset_str = headers.get("anthropic-ratelimit-requests-reset")
        if limit is not None and remaining is not None and reset_str:
            try:
                from email.utils import parsedate_to_datetime

                reset = datetime.fromisoformat(reset_str.replace("Z", "+00:00"))
                return RateLimitInfo(limit=limit, remaining=remaining, reset=reset)
            except (ValueError, TypeError):
                pass
        return RateLimitInfo(limit=1000, remaining=1000, reset=datetime.now(timezone.utc) + timedelta(minutes=1))

    def pagination_strategy(self) -> PaginationStrategy:
        return AnthropicPaginationStrategy()

    def get_idempotency_config(self) -> IdempotencyConfig:
        return IdempotencyConfig(
            default_safe_operations={"GET", "HEAD", "OPTIONS"},
            operation_overrides={
                "POST /v1/messages": IdempotencyLevel.CONDITIONAL,
                "POST /v1/messages/batches": IdempotencyLevel.CONDITIONAL,
            },
        )

    def capabilities(self) -> list[str]:
        return ["messages", "streaming"]

    def _error(self, category, retryable, message, metadata=None, retry_after=None, status=None) -> MeridianError:
        return MeridianError(message, category, "anthropic", retryable, "", metadata, retry_after, status)
