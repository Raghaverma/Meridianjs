"""Port of src/providers/stripe/{adapter,pagination}.ts."""

from __future__ import annotations

import base64
import hashlib
import hmac
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


class StripePaginationStrategy(PaginationStrategy):
    def extract_cursor(self, response: RawResponse) -> Optional[str]:
        body = response.body
        if isinstance(body, dict) and body.get("has_more") is True and isinstance(body.get("data"), list):
            data = body["data"]
            if data:
                last = data[-1]
                if isinstance(last, dict) and isinstance(last.get("id"), str):
                    return last["id"]
        return None

    def extract_total(self, response: RawResponse) -> Optional[int]:
        return None

    def has_next(self, response: RawResponse) -> bool:
        return isinstance(response.body, dict) and response.body.get("has_more") is True

    def build_next_request(
        self, endpoint: str, options: RequestOptions, cursor: str
    ) -> tuple[str, RequestOptions]:
        query = dict(options.query or {})
        query["starting_after"] = cursor
        return endpoint, RequestOptions(
            method=options.method, headers=options.headers, body=options.body,
            query=query, idempotency_key=options.idempotency_key,
            timeout=options.timeout, identity=options.identity,
        )


class StripeAdapter(ProviderAdapter):
    def __init__(self, base_url: str = "https://api.stripe.com") -> None:
        self.base_url = base_url

    def build_request(self, input: AdapterInput) -> BuiltRequest:
        base_url = input.base_url or self.base_url
        options = input.options
        url = build_url(base_url, input.endpoint, options.query)
        credentials = base64.b64encode(f"{input.auth_token.token}:".encode()).decode()
        headers: dict[str, str] = {
            "Authorization": f"Basic {credentials}",
            "Stripe-Version": "2024-11-20.acacia",
            "User-Agent": f"Meridian-SDK/{SDK_VERSION}",
            **(options.headers or {}),
        }
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
        return ResponseNormalizer.normalize(raw, "stripe", rl, pagination, [], "1.0.0")

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
        decline_code = err.get("decline_code")
        headers = error.headers

        if status == 401:
            return self._error(ErrorCategory.AUTH, False, message or "Authentication failed. Check your Stripe API key.", {"stripeError": err}, None, 401)
        if status == 402:
            return self._error(ErrorCategory.VALIDATION, False, message or "Payment was declined.", {"stripeError": err, "declineCode": decline_code}, None, 402)
        if status == 403:
            return self._error(ErrorCategory.AUTH, False, message or "Permission denied. Your API key lacks the required permissions.", {"stripeError": err}, None, 403)
        if status == 404:
            return self._error(ErrorCategory.VALIDATION, False, message or "Resource not found.", {"stripeError": err}, None, 404)
        if status == 409:
            return self._error(ErrorCategory.VALIDATION, False, message or "Idempotency key reused with different parameters.", {"stripeError": err}, None, 409)
        if status == 429:
            retry_after = extract_retry_after(headers)
            return self._error(ErrorCategory.RATE_LIMIT, True, message or "Rate limit exceeded. Please wait before retrying.", {"stripeError": err}, retry_after, 429)
        if status == 422:
            return self._error(ErrorCategory.VALIDATION, False, message or "Request validation failed.", {"stripeError": err}, None, 422)
        if status >= 500:
            return self._error(ErrorCategory.PROVIDER, True, message or f"Stripe API returned error {status}. This may be temporary.", {"status": status}, None, status)
        if status >= 400:
            return self._error(ErrorCategory.VALIDATION, False, message or f"Request failed with status {status}.", {"status": status}, None, status)
        return self._error(ErrorCategory.PROVIDER, False, f"Unexpected response status {status}.", {"status": status}, None, status)

    async def auth_strategy(self, config: AuthConfig) -> AuthToken:
        key = config.api_key or config.token
        if not key:
            raise self._error(ErrorCategory.AUTH, False, "Stripe authentication requires an API key. Set auth.apiKey or auth.token to your Stripe secret key.", {}, None, 401)
        return AuthToken(token=key)

    def rate_limit_policy(self, headers: Headers) -> RateLimitInfo:
        limit_str = headers.get("Stripe-Ratelimit-Limit")
        remaining_str = headers.get("Stripe-Ratelimit-Remaining")
        if limit_str and remaining_str:
            try:
                limit = int(limit_str)
                remaining = int(remaining_str)
                return RateLimitInfo(limit=limit, remaining=remaining, reset=datetime.now(timezone.utc) + timedelta(seconds=1))
            except ValueError:
                pass
        return RateLimitInfo(limit=100, remaining=100, reset=datetime.now(timezone.utc) + timedelta(seconds=1))

    def pagination_strategy(self) -> PaginationStrategy:
        return StripePaginationStrategy()

    def get_idempotency_config(self) -> IdempotencyConfig:
        return IdempotencyConfig(
            default_safe_operations={"GET", "HEAD", "OPTIONS"},
            operation_overrides={
                "POST /v1/charges": IdempotencyLevel.CONDITIONAL,
                "POST /v1/payment_intents": IdempotencyLevel.CONDITIONAL,
                "POST /v1/payment_intents/:id/confirm": IdempotencyLevel.CONDITIONAL,
                "POST /v1/customers": IdempotencyLevel.CONDITIONAL,
                "POST /v1/subscriptions": IdempotencyLevel.CONDITIONAL,
                "POST /v1/invoices": IdempotencyLevel.CONDITIONAL,
                "POST /v1/refunds": IdempotencyLevel.CONDITIONAL,
                "POST /v1/payouts": IdempotencyLevel.CONDITIONAL,
                "POST /v1/transfers": IdempotencyLevel.CONDITIONAL,
                "DELETE /v1/customers/:id": IdempotencyLevel.IDEMPOTENT,
                "DELETE /v1/subscriptions/:id": IdempotencyLevel.IDEMPOTENT,
            },
        )

    def verify_webhook(self, payload: bytes | str, signature: str, secret: str) -> bool:
        try:
            sig_hex = signature
            signing_payload = payload
            if "v1=" in signature:
                parts: dict[str, str] = {}
                for part in signature.split(","):
                    idx = part.find("=")
                    if idx != -1:
                        parts[part[:idx]] = part[idx + 1 :]
                v1 = parts.get("v1")
                t = parts.get("t")
                if not v1:
                    return False
                sig_hex = v1
                if t:
                    payload_str = payload.decode() if isinstance(payload, bytes) else payload
                    signing_payload = f"{t}.{payload_str}"
            data = signing_payload.encode() if isinstance(signing_payload, str) else signing_payload
            expected = hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected, sig_hex)
        except Exception:  # noqa: BLE001
            return False

    def capabilities(self) -> list[str]:
        return ["payments", "customers", "subscriptions", "webhooks"]

    def _error(self, category, retryable, message, metadata=None, retry_after=None, status=None) -> MeridianError:
        return MeridianError(message, category, "stripe", retryable, "", metadata, retry_after, status)
