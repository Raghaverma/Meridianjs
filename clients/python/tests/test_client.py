from __future__ import annotations

import pytest

from meridian import Meridian, MeridianError
from meridian.contract import ErrorCode, Headers, RawResponse
from tests.conftest import queued_transport, static_transport

CONFIG = {"providers": {"github": {"auth": {"token": "tok"}}}}


async def test_native_get_success():
    transport = static_transport(
        200,
        {"name": "Hello-World"},
        {"x-ratelimit-limit": "60", "x-ratelimit-remaining": "59",
         "x-ratelimit-reset": "9999999999"},
    )
    meridian = await Meridian.create(CONFIG, transport=transport)
    res = await meridian.github.get("/repos/octocat/Hello-World")
    assert res.data == {"name": "Hello-World"}
    assert res.meta.provider == "github"
    assert res.meta.request_id
    assert res.meta.trace is not None
    assert res.meta.trace.retries == 0


async def test_native_error_maps_to_meridian_error():
    transport = static_transport(404, {"message": "Not Found"})
    meridian = await Meridian.create(CONFIG, transport=transport)
    with pytest.raises(MeridianError) as exc:
        await meridian.github.get("/repos/octocat/missing")
    assert exc.value.code == ErrorCode.NOT_FOUND
    assert exc.value.provider == "github"


async def test_native_pagination_follows_link_header():
    responses = [
        RawResponse(
            200,
            Headers({"Link": '<https://api.github.com/r?page=2>; rel="next"'}),
            [{"id": 1}],
        ),
        RawResponse(200, Headers({}), [{"id": 2}]),
    ]
    meridian = await Meridian.create(CONFIG, transport=queued_transport(responses))
    pages = [page async for page in meridian.github.paginate("/repos/octocat/Hello/issues")]
    assert len(pages) == 2
    assert pages[0].data == [{"id": 1}]
    assert pages[1].data == [{"id": 2}]


async def test_unknown_provider_attribute_raises():
    meridian = await Meridian.create(CONFIG, transport=static_transport(200, {}))
    with pytest.raises(AttributeError):
        _ = meridian.notconfigured


async def test_ssrf_guard_rejects_absolute_endpoint():
    meridian = await Meridian.create(CONFIG, transport=static_transport(200, {}))
    with pytest.raises(MeridianError):
        await meridian.github.get("https://evil.com/steal")
