from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import grpc
import pytest

from meridian.contract import Chunk
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


async def test_stream_call_yields_chunks_and_respects_done_sentinel():
    """stream_call must yield one Chunk per proto message and stop on done=True."""
    from meridian.proto import meridian_pb2

    # Build fake StreamChunk messages that the stub will yield.
    delta1 = meridian_pb2.StreamChunk(data_json='{"text":"Hello"}', index=0, event="", raw="Hello")
    delta2 = meridian_pb2.StreamChunk(data_json='{"text":" world"}', index=1, event="", raw=" world")
    terminal = meridian_pb2.StreamChunk(done=True, index=2)

    async def _fake_stream(_req, metadata=()):
        for msg in [delta1, delta2, terminal]:
            yield msg

    client = MeridianGrpcClient("127.0.0.1:9999")  # no real server needed
    with patch.object(client._stub, "StreamCall", new=MagicMock(side_effect=_fake_stream)):
        chunks = []
        async for chunk in client.stream_call("anthropic", "/v1/messages"):
            chunks.append(chunk)

    await client.close()

    assert len(chunks) == 2
    assert all(isinstance(c, Chunk) for c in chunks)
    assert chunks[0].data == {"text": "Hello"}
    assert chunks[0].index == 0
    assert chunks[1].data == {"text": " world"}
    assert chunks[1].index == 1


async def test_stream_call_passthrough_on_remote_provider():
    """provider().stream_call() must delegate to the client's stream_call."""
    client = MeridianGrpcClient("127.0.0.1:9999")
    collected = []

    async def _fake(*args, **kwargs):
        async def _gen():
            yield Chunk(data={"tok": "hi"}, index=0, event="", raw="hi")

        async for c in _gen():
            yield c

    with patch.object(client, "stream_call", new=MagicMock(side_effect=_fake)):
        async for chunk in client.provider("openai").stream_call("/v1/chat/completions"):
            collected.append(chunk)

    await client.close()
    assert len(collected) == 1
    assert collected[0].data == {"tok": "hi"}
