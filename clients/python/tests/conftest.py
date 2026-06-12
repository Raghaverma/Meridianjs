"""Shared test helpers."""

from __future__ import annotations

from typing import Optional

from meridian.contract import Headers, HttpError, RawResponse


def static_transport(status: int, body, headers: Optional[dict] = None):
    """A transport that always returns/raises the same response."""

    async def transport(built, timeout):
        hdrs = Headers(headers or {})
        if status >= 400:
            raise HttpError(status, hdrs, body)
        return RawResponse(status=status, headers=hdrs, body=body)

    return transport


def queued_transport(responses: list[RawResponse]):
    """A transport that returns each queued RawResponse in order."""
    queue = list(responses)

    async def transport(built, timeout):
        resp = queue.pop(0)
        if resp.status >= 400:
            raise HttpError(resp.status, resp.headers, resp.body)
        return resp

    return transport
