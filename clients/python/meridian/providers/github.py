"""Port of src/providers/github/{adapter,pagination}.ts."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urljoin, urlparse, parse_qs, urlencode

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
from ..core.header_parser import find_link_by_rel, parse_link_header, parse_rate_limit_headers, parse_retry_after
from ..core.normalizer import ResponseNormalizer
from ..strategies.pagination import PaginationStrategy

SDK_VERSION = "0.2.11"


class GitHubPaginationStrategy(PaginationStrategy):
    def extract_cursor(self, response: RawResponse) -> Optional[str]:
        link_header = response.headers.get("Link")
        if not link_header:
            return None
        next_link = find_link_by_rel(parse_link_header(link_header), "next")
        if not next_link:
            return None
        try:
            query = parse_qs(urlparse(next_link["url"]).query)
            page = query.get("page")
            return page[0] if page else None
        except Exception:  # noqa: BLE001
            return None

    def extract_total(self, response: RawResponse) -> Optional[int]:
        total_header = response.headers.get("X-Total-Count")
        if total_header:
            try:
                parsed = int(total_header)
                if parsed >= 0:
                    return parsed
            except ValueError:
                return None
        return None

    def has_next(self, response: RawResponse) -> bool:
        link_header = response.headers.get("Link")
        if not link_header:
            return False
        return find_link_by_rel(parse_link_header(link_header), "next") is not None

    def build_next_request(
        self, endpoint: str, options: RequestOptions, cursor: str
    ) -> tuple[str, RequestOptions]:
        query = dict(options.query or {})
        query["page"] = cursor
        return endpoint, RequestOptions(
            method=options.method,
            headers=options.headers,
            body=options.body,
            query=query,
            idempotency_key=options.idempotency_key,
            timeout=options.timeout,
            identity=options.identity,
        )


def _build_url(base_url: str, endpoint: str, query: Optional[dict]) -> str:
    url = urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))
    if query:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urlencode({k: str(v) for k, v in query.items()})}"
    return url


class GitHubAdapter(ProviderAdapter):
    def __init__(self, base_url: str = "https://api.github.com") -> None:
        self.base_url = base_url

    def build_request(self, input: AdapterInput) -> BuiltRequest:
        base_url = input.base_url or self.base_url
        options = input.options
        url = _build_url(base_url, input.endpoint, options.query)

        headers: dict[str, str] = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": f"Meridian-SDK/{SDK_VERSION}",
            **(options.headers or {}),
        }
        if input.auth_token.token:
            headers["Authorization"] = f"Bearer {input.auth_token.token}"
        if options.idempotency_key:
            headers["X-Idempotency-Key"] = options.idempotency_key

        body: Optional[str] = None
        method = (options.method or "GET").upper()
        if options.body is not None and method not in ("GET", "HEAD"):
            import json

            body = json.dumps(options.body)
            headers["Content-Type"] = "application/json"

        return BuiltRequest(url=url, method=method, headers=headers, body=body)

    def parse_response(self, raw: RawResponse) -> NormalizedResponse:
        rate_limit_info = self.rate_limit_policy(raw.headers)
        pagination_info = ResponseNormalizer.extract_pagination_info(
            raw, self.pagination_strategy()
        )
        return ResponseNormalizer.normalize(
            raw, "github", rate_limit_info, pagination_info, [], "1.0.0"
        )

    def parse_error(self, raw: Any) -> MeridianError:
        if isinstance(raw, MeridianError):
            return raw
        if isinstance(raw, HttpError):
            return self._parse_http_error(raw)
        if isinstance(raw, Exception):
            msg = str(raw).lower()
            if any(k in msg for k in ("fetch", "network", "econnreset", "etimedout", "enotfound", "timeout")):
                return self._error(
                    ErrorCategory.NETWORK,
                    True,
                    "Network request failed. Check your connection and try again.",
                    {"originalError": str(raw)},
                )
        return self._error(ErrorCategory.PROVIDER, False, "An unexpected error occurred", {"raw": str(raw)})

    def _parse_http_error(self, error: HttpError) -> MeridianError:
        status = error.status
        body = error.body if isinstance(error.body, dict) else {}
        headers = error.headers

        if status == 401:
            return self._error(ErrorCategory.AUTH, False, "Authentication failed. Check your token is valid and not expired.", {"githubMessage": body.get("message")}, None, 401)
        if status == 403:
            if headers.get("X-RateLimit-Remaining") == "0":
                retry_after = self._extract_retry_after(headers)
                return self._error(ErrorCategory.RATE_LIMIT, True, "Rate limit exceeded. Please wait before retrying.", {"githubMessage": body.get("message")}, retry_after, 403)
            return self._error(ErrorCategory.AUTH, False, "Permission denied. Check your token has the required scopes.", {"githubMessage": body.get("message")}, None, 403)
        if status == 404:
            return self._error(ErrorCategory.VALIDATION, False, "Resource not found.", {"githubMessage": body.get("message")}, None, 404)
        if status == 422:
            return self._error(ErrorCategory.VALIDATION, False, body.get("message") or "Request validation failed.", {"githubMessage": body.get("message")}, None, 422)
        if status == 429:
            retry_after = self._extract_retry_after(headers)
            return self._error(ErrorCategory.RATE_LIMIT, True, "Rate limit exceeded. Please wait before retrying.", {"githubMessage": body.get("message")}, retry_after, 429)
        if status >= 500:
            return self._error(ErrorCategory.PROVIDER, True, f"GitHub API returned error {status}. This may be temporary.", {"status": status}, None, status)
        if status >= 400:
            return self._error(ErrorCategory.VALIDATION, False, body.get("message") or f"Request failed with status {status}.", {"status": status}, None, status)
        return self._error(ErrorCategory.PROVIDER, False, f"Unexpected response status {status}.", {"status": status}, None, status)

    async def auth_strategy(self, config: AuthConfig) -> AuthToken:
        if not config.token:
            raise self._error(ErrorCategory.AUTH, False, "GitHub authentication requires a token.", {}, None, 401)
        return AuthToken(token=config.token)

    def rate_limit_policy(self, headers: Headers) -> RateLimitInfo:
        parsed = parse_rate_limit_headers(headers)
        if parsed:
            return RateLimitInfo(limit=parsed["limit"], remaining=parsed["remaining"], reset=parsed["reset"])
        return RateLimitInfo(limit=5000, remaining=5000, reset=datetime.now(timezone.utc) + timedelta(hours=1))

    def pagination_strategy(self) -> PaginationStrategy:
        return GitHubPaginationStrategy()

    def get_idempotency_config(self) -> IdempotencyConfig:
        return IdempotencyConfig(
            default_safe_operations={"GET", "HEAD", "OPTIONS"},
            operation_overrides={
                "POST /repos/:owner/:repo/pulls": IdempotencyLevel.CONDITIONAL,
                "POST /repos/:owner/:repo/issues": IdempotencyLevel.CONDITIONAL,
                "GET /search/code": IdempotencyLevel.UNSAFE,
                "GET /search/repositories": IdempotencyLevel.UNSAFE,
                "GET /search/users": IdempotencyLevel.UNSAFE,
                "DELETE /repos/:owner/:repo": IdempotencyLevel.IDEMPOTENT,
                "DELETE /repos/:owner/:repo/issues/:issue_number": IdempotencyLevel.IDEMPOTENT,
            },
        )

    def capabilities(self) -> list[str]:
        return ["repos", "issues", "pulls", "search"]

    def _extract_retry_after(self, headers: Headers) -> Optional[datetime]:
        parsed = parse_retry_after(headers.get("Retry-After"))
        if parsed:
            return parsed
        reset_value = headers.get("X-RateLimit-Reset")
        if reset_value:
            try:
                timestamp = int(reset_value.strip())
            except ValueError:
                return None
            now = int(datetime.now(timezone.utc).timestamp())
            if now - 60 <= timestamp < now + 86400 * 365:
                return datetime.fromtimestamp(timestamp, tz=timezone.utc)
        return None

    def _error(self, category, retryable, message, metadata=None, retry_after=None, status=None) -> MeridianError:
        return MeridianError(message, category, "github", retryable, "", metadata, retry_after, status)
