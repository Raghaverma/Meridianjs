from __future__ import annotations

import hashlib
import hmac

import pytest

from meridian.contract import (
    AdapterInput,
    AuthToken,
    ErrorCategory,
    ErrorCode,
    Headers,
    HttpError,
    RawResponse,
    RequestOptions,
)
from meridian.providers.anthropic import AnthropicAdapter
from meridian.providers.github import GitHubAdapter
from meridian.providers.openai import OpenAIAdapter
from meridian.providers.stripe import StripeAdapter


def test_github_build_request():
    adapter = GitHubAdapter()
    built = adapter.build_request(
        AdapterInput(
            endpoint="/repos/x/y",
            options=RequestOptions(method="GET", query={"a": 1}),
            auth_token=AuthToken(token="tok"),
        )
    )
    assert built.url == "https://api.github.com/repos/x/y?a=1"
    assert built.headers["Authorization"] == "Bearer tok"
    assert built.method == "GET"


def test_github_post_serializes_body():
    adapter = GitHubAdapter()
    built = adapter.build_request(
        AdapterInput(
            endpoint="/user/repos",
            options=RequestOptions(method="POST", body={"name": "r"}),
            auth_token=AuthToken(token="tok"),
        )
    )
    assert built.body == '{"name": "r"}'
    assert built.headers["Content-Type"] == "application/json"


@pytest.mark.parametrize(
    "adapter,provider",
    [
        (GitHubAdapter(), "github"),
        (OpenAIAdapter(), "openai"),
        (AnthropicAdapter(), "anthropic"),
        (StripeAdapter(), "stripe"),
    ],
)
def test_error_mapping_404_and_5xx(adapter, provider):
    not_found = adapter.parse_error(HttpError(404, Headers({}), {"message": "nope"}))
    assert not_found.category == ErrorCategory.VALIDATION
    assert not_found.code == ErrorCode.NOT_FOUND
    assert not_found.retryable is False
    assert not_found.provider == provider

    server_err = adapter.parse_error(HttpError(503, Headers({}), {}))
    assert server_err.category == ErrorCategory.PROVIDER
    assert server_err.code == ErrorCode.UPSTREAM_5XX
    assert server_err.retryable is True


def test_github_rate_limit_403_is_retryable():
    err = GitHubAdapter().parse_error(
        HttpError(403, Headers({"X-RateLimit-Remaining": "0"}), {"message": "limit"})
    )
    assert err.category == ErrorCategory.RATE_LIMIT
    assert err.retryable is True


def test_openai_insufficient_quota_429_not_retryable():
    err = OpenAIAdapter().parse_error(
        HttpError(429, Headers({}), {"error": {"code": "insufficient_quota", "message": "no"}})
    )
    assert err.category == ErrorCategory.RATE_LIMIT
    assert err.retryable is False


def test_anthropic_529_overloaded_is_retryable():
    err = AnthropicAdapter().parse_error(HttpError(529, Headers({}), {}))
    assert err.category == ErrorCategory.PROVIDER
    assert err.retryable is True


def test_github_pagination_extracts_next_page():
    strat = GitHubAdapter().pagination_strategy()
    resp = RawResponse(
        200,
        Headers({"Link": '<https://api.github.com/r?page=2>; rel="next"'}),
        [],
    )
    assert strat.has_next(resp) is True
    assert strat.extract_cursor(resp) == "2"


def test_stripe_webhook_signature_roundtrip():
    secret = "whsec_test"
    payload = '{"id": "evt_1"}'
    t = "1700000000"
    signed = f"{t}.{payload}"
    v1 = hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    signature = f"t={t},v1={v1}"
    assert StripeAdapter().verify_webhook(payload, signature, secret) is True
    assert StripeAdapter().verify_webhook(payload, f"t={t},v1=deadbeef", secret) is False
