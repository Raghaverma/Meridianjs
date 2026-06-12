"""gRPC server that exposes the native Python engine over proto/meridian.proto.

This is the Python counterpart to src/proxy/grpc-server.ts: it serves the exact
same `meridian.v1.Meridian` service, so any gRPC client (the TS client, grpcurl,
Go, ...) can drive the Python engine identically to the TypeScript one.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from typing import Optional

import grpc

from .client import Meridian
from .contract import MeridianError, NormalizedResponse, RequestOptions, ResponseMeta
from .proto import meridian_pb2, meridian_pb2_grpc

_FORWARDED_HEADERS = {
    "content-type",
    "content-language",
    "accept",
    "accept-language",
    "idempotency-key",
    "x-request-id",
}


def _meta_to_proto(meta: ResponseMeta) -> meridian_pb2.ResponseMeta:
    out = meridian_pb2.ResponseMeta(
        provider=meta.provider,
        request_id=meta.request_id,
        rate_limit=meridian_pb2.RateLimitInfo(
            limit=meta.rate_limit.limit,
            remaining=meta.rate_limit.remaining,
            reset_unix_ms=int(meta.rate_limit.reset.timestamp() * 1000),
        ),
        warnings=list(meta.warnings),
        schema_version=meta.schema_version,
    )
    if meta.pagination:
        out.pagination.CopyFrom(
            meridian_pb2.PaginationInfo(
                has_next=meta.pagination.has_next,
                cursor=meta.pagination.cursor or "",
                total=meta.pagination.total or 0,
                has_total=meta.pagination.total is not None,
            )
        )
    if meta.trace:
        out.trace.CopyFrom(
            meridian_pb2.RequestTrace(
                retries=meta.trace.retries,
                latency_ms=meta.trace.latency,
                circuit_breaker=meridian_pb2.CircuitState.Value(meta.trace.circuit_breaker.name),
                rate_limit_remaining=meta.trace.rate_limit_remaining,
            )
        )
    return out


def _normalized_to_proto(response: NormalizedResponse) -> meridian_pb2.CallResponse:
    return meridian_pb2.CallResponse(
        data_json=json.dumps(response.data),
        meta=_meta_to_proto(response.meta),
    )


def _error_to_proto(err: MeridianError, provider: str) -> meridian_pb2.CallResponse:
    return meridian_pb2.CallResponse(
        error=meridian_pb2.MeridianError(
            message=err.message,
            category=meridian_pb2.ErrorCategory.Value(err.category.name),
            code=meridian_pb2.ErrorCode.Value(err.code.value),
            retryable=err.retryable,
            provider=err.provider or provider,
            request_id=err.request_id,
            status=err.status or 0,
            metadata_json=json.dumps(err.metadata, default=str) if err.metadata else "",
            retry_after_unix_ms=int(err.retry_after.timestamp() * 1000) if err.retry_after else 0,
        )
    )


def _build_options(request) -> tuple[str, RequestOptions]:
    method = (request.method or "GET").upper()
    headers = {
        k: v for k, v in request.headers.items() if k.lower() in _FORWARDED_HEADERS
    }
    options = RequestOptions(method=method)
    if headers:
        options.headers = headers
    if request.query:
        options.query = dict(request.query)
    if request.body_json:
        try:
            options.body = json.loads(request.body_json)
        except json.JSONDecodeError:
            options.body = request.body_json
    if request.idempotency_key:
        options.idempotency_key = request.idempotency_key
    if request.timeout_ms and request.timeout_ms > 0:
        options.timeout = request.timeout_ms / 1000
    if request.identity:
        options.identity = request.identity
    return method, options


class MeridianServicer(meridian_pb2_grpc.MeridianServicer):
    def __init__(self, meridian: Meridian, auth_token: Optional[str] = None) -> None:
        self._meridian = meridian
        self._auth_token = auth_token

    def _authorized(self, context: grpc.aio.ServicerContext) -> bool:
        if not self._auth_token:
            return True
        for key, value in context.invocation_metadata():
            if key == "authorization" and isinstance(value, str):
                parts = value.strip().split(None, 1)
                if len(parts) == 2 and parts[0].lower() == "bearer":
                    if hmac.compare_digest(parts[1], self._auth_token):
                        return True
            if key == "x-proxy-token" and isinstance(value, str):
                if hmac.compare_digest(value, self._auth_token):
                    return True
        return False

    async def Health(self, request, context):  # noqa: N802 (proto method name)
        return meridian_pb2.HealthResponse(
            status="ok",
            providers=list(self._meridian._clients.keys()),
            recording=False,
            replaying=False,
            auth_required=bool(self._auth_token),
        )

    async def Call(self, request, context):  # noqa: N802
        if not self._authorized(context):
            await context.abort(
                grpc.StatusCode.UNAUTHENTICATED,
                "Unauthorized. Provide 'authorization: Bearer <token>' or 'x-proxy-token'.",
            )
        provider = request.provider
        endpoint = request.endpoint or "/"
        method, options = _build_options(request)

        client = self._meridian.provider(provider)
        if client is None:
            return _error_to_proto(
                MeridianError(f'Unknown provider: "{provider}"', _validation(), provider, False),
                provider,
            )
        try:
            response = await client._request(method, endpoint, options)
            return _normalized_to_proto(response)
        except MeridianError as err:
            return _error_to_proto(err, provider)
        except Exception as err:  # noqa: BLE001
            return _error_to_proto(
                MeridianError(str(err), _provider_cat(), provider, False), provider
            )

    async def Paginate(self, request, context):  # noqa: N802
        if not self._authorized(context):
            await context.abort(
                grpc.StatusCode.UNAUTHENTICATED,
                "Unauthorized. Provide 'authorization: Bearer <token>' or 'x-proxy-token'.",
            )
        provider = request.provider
        endpoint = request.endpoint or "/"
        _, options = _build_options(request)

        client = self._meridian.provider(provider)
        if client is None:
            yield _error_to_proto(
                MeridianError(f'Unknown provider: "{provider}"', _validation(), provider, False),
                provider,
            )
            return
        try:
            async for page in client.paginate(endpoint, options):
                yield _normalized_to_proto(page)
        except MeridianError as err:
            yield _error_to_proto(err, provider)
        except Exception as err:  # noqa: BLE001
            yield _error_to_proto(
                MeridianError(str(err), _provider_cat(), provider, False), provider
            )


def _validation():
    from .contract import ErrorCategory

    return ErrorCategory.VALIDATION


def _provider_cat():
    from .contract import ErrorCategory

    return ErrorCategory.PROVIDER


def _config_from_env() -> dict:
    """Build a Meridian config for the reference providers from environment vars."""
    providers: dict[str, dict] = {}
    if os.environ.get("GITHUB_TOKEN"):
        providers["github"] = {"auth": {"token": os.environ["GITHUB_TOKEN"]}}
    if os.environ.get("OPENAI_API_KEY"):
        providers["openai"] = {"auth": {"api_key": os.environ["OPENAI_API_KEY"]}}
    if os.environ.get("ANTHROPIC_API_KEY"):
        providers["anthropic"] = {"auth": {"api_key": os.environ["ANTHROPIC_API_KEY"]}}
    if os.environ.get("STRIPE_SECRET_KEY"):
        providers["stripe"] = {"auth": {"api_key": os.environ["STRIPE_SECRET_KEY"]}}
    # Always expose the reference providers even without creds, so routing works
    # in replay/test scenarios.
    for name in ("github", "openai", "anthropic", "stripe"):
        providers.setdefault(name, {"auth": {}})
    return {"providers": providers}


async def serve(
    host: str = "127.0.0.1",
    port: int = 4242,
    config: Optional[dict] = None,
    auth_token: Optional[str] = None,
    transport=None,
) -> grpc.aio.Server:
    meridian = await Meridian.create(config or _config_from_env(), transport=transport)
    server = grpc.aio.server()
    meridian_pb2_grpc.add_MeridianServicer_to_server(
        MeridianServicer(meridian, auth_token), server
    )
    server.add_insecure_port(f"{host}:{port}")
    await server.start()
    return server


def main() -> None:
    host = os.environ.get("BOUNDARY_PROXY_HOST", "127.0.0.1")
    port = int(os.environ.get("BOUNDARY_PROXY_PORT", "4242"))
    auth_token = os.environ.get("MERIDIAN_PROXY_TOKEN")

    async def _run() -> None:
        server = await serve(host=host, port=port, auth_token=auth_token)
        print(f"[Meridian Python] gRPC listening on {host}:{port} (meridian.v1.Meridian)")
        await server.wait_for_termination()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
