"""Port of src/providers/openai/{adapter,pagination}.ts."""

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
from ._common import SDK_VERSION, build_url, extract_retry_after, parse_openai_duration


class OpenAIPaginationStrategy(PaginationStrategy):
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
        query["after"] = cursor
        return endpoint, RequestOptions(
            method=options.method, headers=options.headers, body=options.body,
            query=query, idempotency_key=options.idempotency_key,
            timeout=options.timeout, identity=options.identity,
        )


class OpenAIAdapter(ProviderAdapter):
    def __init__(self, base_url: str = "https://api.openai.com") -> None:
        self.base_url = base_url

    def build_request(self, input: AdapterInput) -> BuiltRequest:
        base_url = input.base_url or self.base_url
        options = input.options
        url = build_url(base_url, input.endpoint, options.query)
        headers: dict[str, str] = {
            "User-Agent": f"Meridian-SDK/{SDK_VERSION}",
            **(options.headers or {}),
        }
        if input.auth_token.token:
            headers["Authorization"] = f"Bearer {input.auth_token.token}"
        if options.idempotency_key:
            headers["Idempotency-Key"] = options.idempotency_key
        body: Optional[str] = None
        method = (options.method or "GET").upper()
        if options.body is not None and method not in ("GET", "HEAD"):
            body = json.dumps(options.body)
            headers["Content-Type"] = "application/json"
        return BuiltRequest(url=url, method=method, headers=headers, body=body)

    def parse_response(self, raw: RawResponse) -> NormalizedResponse:
        rl = self.rate_limit_policy(raw.headers)
        pagination = ResponseNormalizer.extract_pagination_info(raw, self.pagination_strategy())
        return ResponseNormalizer.normalize(raw, "openai", rl, pagination, [], "1.0.0")

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
        code = err.get("code")
        headers = error.headers

        if status == 401:
            return self._error(ErrorCategory.AUTH, False, message or "Authentication failed. Check your OpenAI API key.", {"openaiError": err}, None, 401)
        if status == 403:
            return self._error(ErrorCategory.AUTH, False, message or "Permission denied. Your API key lacks the required permissions.", {"openaiError": err}, None, 403)
        if status == 404:
            return self._error(ErrorCategory.VALIDATION, False, message or "Resource not found.", {"openaiError": err}, None, 404)
        if status == 422:
            return self._error(ErrorCategory.VALIDATION, False, message or "Request validation failed.", {"openaiError": err}, None, 422)
        if status == 429:
            retry_after = extract_retry_after(headers)
            is_quota = code == "insufficient_quota"
            return self._error(ErrorCategory.RATE_LIMIT, not is_quota, message or "Rate limit exceeded. Please wait before retrying.", {"openaiError": err}, retry_after, 429)
        if status >= 500:
            return self._error(ErrorCategory.PROVIDER, True, message or f"OpenAI API returned error {status}. This may be temporary.", {"status": status}, None, status)
        if status >= 400:
            return self._error(ErrorCategory.VALIDATION, False, message or f"Request failed with status {status}.", {"status": status}, None, status)
        return self._error(ErrorCategory.PROVIDER, False, f"Unexpected response status {status}.", {"status": status}, None, status)

    async def auth_strategy(self, config: AuthConfig) -> AuthToken:
        token = config.token or config.api_key
        if not token:
            raise self._error(ErrorCategory.AUTH, False, "OpenAI authentication requires an API key. Set auth.token to your OpenAI API key.", {}, None, 401)
        return AuthToken(token=token)

    def rate_limit_policy(self, headers: Headers) -> RateLimitInfo:
        limit_str = headers.get("x-ratelimit-limit-requests")
        remaining_str = headers.get("x-ratelimit-remaining-requests")
        reset_str = headers.get("x-ratelimit-reset-requests")
        if limit_str and remaining_str:
            try:
                limit = int(limit_str)
                remaining = int(remaining_str)
            except ValueError:
                limit = remaining = None  # type: ignore[assignment]
            if limit is not None and remaining is not None:
                reset = datetime.now(timezone.utc) + timedelta(minutes=1)
                if reset_str:
                    duration_ms = parse_openai_duration(reset_str)
                    if duration_ms > 0:
                        reset = datetime.now(timezone.utc) + timedelta(milliseconds=duration_ms)
                return RateLimitInfo(limit=limit, remaining=remaining, reset=reset)
        return RateLimitInfo(limit=3500, remaining=3500, reset=datetime.now(timezone.utc) + timedelta(minutes=1))

    def pagination_strategy(self) -> PaginationStrategy:
        return OpenAIPaginationStrategy()

    def get_idempotency_config(self) -> IdempotencyConfig:
        return IdempotencyConfig(
            default_safe_operations={"GET", "HEAD", "OPTIONS"},
            operation_overrides={
                "POST /v1/chat/completions": IdempotencyLevel.CONDITIONAL,
                "POST /v1/completions": IdempotencyLevel.CONDITIONAL,
                "POST /v1/embeddings": IdempotencyLevel.CONDITIONAL,
                "POST /v1/images/generations": IdempotencyLevel.CONDITIONAL,
                "POST /v1/audio/transcriptions": IdempotencyLevel.CONDITIONAL,
                "POST /v1/audio/speech": IdempotencyLevel.CONDITIONAL,
            },
        )

    def capabilities(self) -> list[str]:
        return ["chat", "completions", "embeddings", "streaming"]

    def _error(self, category, retryable, message, metadata=None, retry_after=None, status=None) -> MeridianError:
        return MeridianError(message, category, "openai", retryable, "", metadata, retry_after, status)
