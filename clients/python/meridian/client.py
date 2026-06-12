"""Native Meridian client — port of the Meridian class in src/index.ts.

Builds a resilience pipeline per provider and exposes an ergonomic, dynamic
provider surface: ``await meridian.github.get("/repos/octocat/Hello-World")``.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Optional

from .adapter import ProviderAdapter
from .contract import AuthConfig, IdempotencyLevel, NormalizedResponse, RequestOptions
from .core.pipeline import RequestPipeline, Transport
from .providers import BUILTIN_ADAPTERS
from .strategies.circuit_breaker import ProviderCircuitBreaker
from .strategies.idempotency import IdempotencyResolver
from .strategies.rate_limit import RateLimiter
from .strategies.retry import RetryStrategy

_MAX_PAGES = 1000


def _auth_config_from(raw: dict) -> AuthConfig:
    def pick(*names: str) -> Optional[str]:
        for name in names:
            if name in raw and raw[name] is not None:
                return raw[name]
        return None

    return AuthConfig(
        token=pick("token"),
        api_key=pick("api_key", "apiKey"),
        api_secret=pick("api_secret", "apiSecret"),
        username=pick("username"),
        password=pick("password"),
        client_id=pick("client_id", "clientId"),
        client_secret=pick("client_secret", "clientSecret"),
        custom=raw.get("custom"),
    )


class ProviderClient:
    def __init__(self, provider: str, pipeline: RequestPipeline, adapter: ProviderAdapter) -> None:
        self._provider = provider
        self._pipeline = pipeline
        self._adapter = adapter

    async def _request(
        self, method: str, endpoint: str, options: Optional[RequestOptions], **kwargs
    ) -> NormalizedResponse:
        opts = options or RequestOptions()
        # Convenience kwargs (body=, query=, headers=, idempotency_key=, timeout=, identity=).
        for key, value in kwargs.items():
            setattr(opts, key, value)
        opts.method = method
        return await self._pipeline.execute(endpoint, opts)

    async def get(self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs):
        return await self._request("GET", endpoint, options, **kwargs)

    async def post(self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs):
        return await self._request("POST", endpoint, options, **kwargs)

    async def put(self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs):
        return await self._request("PUT", endpoint, options, **kwargs)

    async def patch(self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs):
        return await self._request("PATCH", endpoint, options, **kwargs)

    async def delete(self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs):
        return await self._request("DELETE", endpoint, options, **kwargs)

    async def paginate(
        self, endpoint: str, options: Optional[RequestOptions] = None, **kwargs
    ) -> AsyncIterator[NormalizedResponse]:
        opts = options or RequestOptions()
        for key, value in kwargs.items():
            setattr(opts, key, value)
        opts.method = "GET"

        current_endpoint = endpoint
        current_options = opts
        page_count = 0
        seen: set[str] = set()
        strategy = self._adapter.pagination_strategy()

        while page_count < _MAX_PAGES:
            response = await self._request("GET", current_endpoint, current_options)
            page_count += 1
            yield response

            pagination = response.meta.pagination
            has_next = bool(pagination and pagination.has_next)
            cursor = pagination.cursor if pagination else None
            if not has_next or not cursor:
                break
            if cursor in seen:
                raise RuntimeError(
                    f'Pagination cycle detected: cursor "{cursor}" seen twice '
                    f"(stopped at page {page_count})."
                )
            seen.add(cursor)
            current_endpoint, current_options = strategy.build_next_request(
                current_endpoint, current_options, cursor
            )

        if page_count >= _MAX_PAGES:
            raise RuntimeError(f"Pagination limit reached: {_MAX_PAGES} pages.")


class Meridian:
    def __init__(self) -> None:
        self._clients: dict[str, ProviderClient] = {}

    @classmethod
    async def create(
        cls,
        config: Optional[dict] = None,
        adapters: Optional[dict[str, ProviderAdapter]] = None,
        transport: Optional[Transport] = None,
    ) -> "Meridian":
        config = config or {}
        adapters = adapters or {}
        meridian = cls()

        defaults = config.get("defaults", {})
        compliance = config.get("compliance", {})
        idempotency_cfg = config.get("idempotency", {})
        default_level = IdempotencyLevel(idempotency_cfg.get("default_level", "SAFE"))
        auto_keys = bool(idempotency_cfg.get("auto_generate_keys", False))

        providers: dict[str, dict] = config.get("providers", {})
        for name, pconf in providers.items():
            adapter = adapters.get(name)
            if adapter is None:
                adapter_cls = BUILTIN_ADAPTERS.get(name)
                if adapter_cls is None:
                    raise ValueError(
                        f"No adapter found for provider: {name}. Pass it via `adapters`."
                    )
                base_url = pconf.get("base_url") or pconf.get("baseUrl")
                adapter = adapter_cls(base_url) if base_url else adapter_cls()

            auth = _auth_config_from(pconf.get("auth", {}))
            circuit_breaker = ProviderCircuitBreaker(
                name, {**defaults.get("circuit_breaker", {}), **pconf.get("circuit_breaker", {})}
            )
            rate_limiter = RateLimiter(
                {**defaults.get("rate_limit", {}), **pconf.get("rate_limit", {})}
            )
            retry_strategy = RetryStrategy(
                {**defaults.get("retry", {}), **pconf.get("retry", {})}
            )
            idempotency_resolver = IdempotencyResolver(
                adapter.get_idempotency_config(), default_level
            )

            pipeline = RequestPipeline(
                provider=name,
                adapter=adapter,
                auth_config=auth,
                circuit_breaker=circuit_breaker,
                rate_limiter=rate_limiter,
                retry_strategy=retry_strategy,
                idempotency_resolver=idempotency_resolver,
                base_url=pconf.get("base_url") or pconf.get("baseUrl"),
                timeout=pconf.get("timeout", defaults.get("timeout")),
                auto_generate_idempotency_keys=auto_keys,
                transport=transport,
                compliance=compliance,
            )
            meridian._clients[name] = ProviderClient(name, pipeline, adapter)

        return meridian

    def provider(self, name: str) -> Optional[ProviderClient]:
        return self._clients.get(name)

    def __getattr__(self, name: str) -> ProviderClient:
        # Only reached for attributes not found normally; resolve as a provider.
        clients = self.__dict__.get("_clients", {})
        if name in clients:
            return clients[name]
        raise AttributeError(
            f"Unknown provider '{name}'. Configure it in Meridian.create(config)."
        )
