from __future__ import annotations

import grpc
import pytest

from meridian.grpc_client import MeridianGrpcClient
from meridian.grpc_server import serve
from tests.conftest import static_transport

CONFIG = {"providers": {"github": {"auth": {"token": "tok"}}}}

RATE_HEADERS = {
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": "59",
    "x-ratelimit-reset": "9999999999",
}


async def test_grpc_roundtrip_call_and_health():
    transport = static_transport(200, {"name": "Hello-World"}, RATE_HEADERS)
    server = await serve(host="127.0.0.1", port=50561, config=CONFIG, transport=transport)
    client = MeridianGrpcClient("127.0.0.1:50561")
    try:
        h = await client.health()
        assert h["status"] == "ok"
        assert "github" in h["providers"]

        res = await client.github.get("/repos/octocat/Hello-World")
        assert res.meta.provider == "github"
        assert res.data == {"name": "Hello-World"}
        assert res.meta.trace is not None
    finally:
        await client.close()
        await server.stop(0)


async def test_grpc_error_is_raised_as_meridian_error():
    from meridian import MeridianError
    from meridian.contract import ErrorCode

    transport = static_transport(404, {"message": "Not Found"})
    server = await serve(host="127.0.0.1", port=50562, config=CONFIG, transport=transport)
    client = MeridianGrpcClient("127.0.0.1:50562")
    try:
        with pytest.raises(MeridianError) as exc:
            await client.github.get("/repos/octocat/missing")
        assert exc.value.code == ErrorCode.NOT_FOUND
        assert exc.value.provider == "github"
    finally:
        await client.close()
        await server.stop(0)


async def test_grpc_auth_required():
    transport = static_transport(200, {"ok": True}, RATE_HEADERS)
    server = await serve(
        host="127.0.0.1", port=50563, config=CONFIG, transport=transport, auth_token="s3cr3t"
    )
    no_token = MeridianGrpcClient("127.0.0.1:50563")
    with_token = MeridianGrpcClient("127.0.0.1:50563", auth_token="s3cr3t")
    try:
        with pytest.raises(grpc.aio.AioRpcError) as exc:
            await no_token.github.get("/repos/octocat/Hello-World")
        assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED

        res = await with_token.github.get("/repos/octocat/Hello-World")
        assert res.meta.provider == "github"
    finally:
        await no_token.close()
        await with_token.close()
        await server.stop(0)
