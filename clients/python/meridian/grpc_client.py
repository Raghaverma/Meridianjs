"""gRPC client for the `meridian.v1.Meridian` service.

Lets a Python app drive *either* engine over the wire with the same ergonomics
as the native client — point it at the TypeScript gRPC server or the Python one
and the results are identical, because both implement the same contract.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import grpc

from .contract import (
    CircuitState,
    ErrorCategory,
    MeridianError,
    NormalizedResponse,
    PaginationInfo,
    RateLimitInfo,
    RequestTrace,
    ResponseMeta,
)
from .proto import meridian_pb2, meridian_pb2_grpc


def _epoch_ms_to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _response_from_proto(resp: meridian_pb2.CallResponse) -> NormalizedResponse:
    if resp.HasField("error"):
        raise _error_from_proto(resp.error)
    meta_pb = resp.meta
    rate_limit = RateLimitInfo(
        limit=meta_pb.rate_limit.limit,
        remaining=meta_pb.rate_limit.remaining,
        reset=_epoch_ms_to_dt(meta_pb.rate_limit.reset_unix_ms),
    )
    pagination = None
    if meta_pb.HasField("pagination"):
        p = meta_pb.pagination
        pagination = PaginationInfo(
            has_next=p.has_next,
            cursor=p.cursor or None,
            total=p.total if p.has_total else None,
        )
    trace = None
    if meta_pb.HasField("trace"):
        t = meta_pb.trace
        trace = RequestTrace(
            retries=t.retries,
            latency=t.latency_ms,
            circuit_breaker=CircuitState(meridian_pb2.CircuitState.Name(t.circuit_breaker)),
            rate_limit_remaining=t.rate_limit_remaining,
        )
    meta = ResponseMeta(
        provider=meta_pb.provider,
        request_id=meta_pb.request_id,
        rate_limit=rate_limit,
        schema_version=meta_pb.schema_version,
        warnings=list(meta_pb.warnings),
        pagination=pagination,
        trace=trace,
    )
    data = json.loads(resp.data_json) if resp.data_json else None
    return NormalizedResponse(data=data, meta=meta)


def _error_from_proto(err: meridian_pb2.MeridianError) -> MeridianError:
    category_name = meridian_pb2.ErrorCategory.Name(err.category)
    try:
        category = ErrorCategory(category_name.lower())
    except ValueError:
        category = ErrorCategory.PROVIDER
    retry_after = _epoch_ms_to_dt(err.retry_after_unix_ms) if err.retry_after_unix_ms else None
    metadata = json.loads(err.metadata_json) if err.metadata_json else None
    return MeridianError(
        err.message,
        category,
        err.provider,
        err.retryable,
        err.request_id,
        metadata,
        retry_after,
        err.status or None,
    )


class _RemoteProvider:
    def __init__(self, client: "MeridianGrpcClient", provider: str) -> None:
        self._client = client
        self._provider = provider

    async def get(self, endpoint: str, **kwargs) -> NormalizedResponse:
        return await self._client.call(self._provider, "GET", endpoint, **kwargs)

    async def post(self, endpoint: str, **kwargs) -> NormalizedResponse:
        return await self._client.call(self._provider, "POST", endpoint, **kwargs)

    async def put(self, endpoint: str, **kwargs) -> NormalizedResponse:
        return await self._client.call(self._provider, "PUT", endpoint, **kwargs)

    async def patch(self, endpoint: str, **kwargs) -> NormalizedResponse:
        return await self._client.call(self._provider, "PATCH", endpoint, **kwargs)

    async def delete(self, endpoint: str, **kwargs) -> NormalizedResponse:
        return await self._client.call(self._provider, "DELETE", endpoint, **kwargs)

    def paginate(self, endpoint: str, **kwargs) -> AsyncIterator[NormalizedResponse]:
        return self._client.paginate(self._provider, endpoint, **kwargs)


class MeridianGrpcClient:
    def __init__(self, target: str, auth_token: Optional[str] = None) -> None:
        self._channel = grpc.aio.insecure_channel(target)
        self._stub = meridian_pb2_grpc.MeridianStub(self._channel)
        self._auth_token = auth_token

    def _metadata(self):
        if self._auth_token:
            return (("authorization", f"Bearer {self._auth_token}"),)
        return ()

    def _build_request(
        self,
        provider: str,
        method: str,
        endpoint: str,
        query: Optional[dict] = None,
        headers: Optional[dict] = None,
        body: Any = None,
        idempotency_key: Optional[str] = None,
        timeout_ms: int = 0,
        identity: Optional[str] = None,
    ) -> meridian_pb2.CallRequest:
        return meridian_pb2.CallRequest(
            provider=provider,
            method=method,
            endpoint=endpoint,
            query={k: str(v) for k, v in (query or {}).items()},
            headers={k: str(v) for k, v in (headers or {}).items()},
            body_json=json.dumps(body) if body is not None else "",
            idempotency_key=idempotency_key or "",
            timeout_ms=timeout_ms,
            identity=identity or "",
        )

    async def call(self, provider: str, method: str, endpoint: str, **kwargs) -> NormalizedResponse:
        request = self._build_request(provider, method, endpoint, **kwargs)
        resp = await self._stub.Call(request, metadata=self._metadata())
        return _response_from_proto(resp)

    async def paginate(
        self, provider: str, endpoint: str, **kwargs
    ) -> AsyncIterator[NormalizedResponse]:
        request = self._build_request(provider, "GET", endpoint, **kwargs)
        async for resp in self._stub.Paginate(request, metadata=self._metadata()):
            yield _response_from_proto(resp)

    async def health(self) -> dict:
        resp = await self._stub.Health(meridian_pb2.HealthRequest(), metadata=self._metadata())
        return {
            "status": resp.status,
            "providers": list(resp.providers),
            "auth_required": resp.auth_required,
        }

    def provider(self, name: str) -> _RemoteProvider:
        return _RemoteProvider(self, name)

    def __getattr__(self, name: str) -> _RemoteProvider:
        if name.startswith("_"):
            raise AttributeError(name)
        return _RemoteProvider(self, name)

    async def close(self) -> None:
        await self._channel.close()

    async def __aenter__(self) -> "MeridianGrpcClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()
