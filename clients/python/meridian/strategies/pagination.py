"""Generic pagination strategies — port of src/strategies/pagination.ts.

Provider-specific strategies (GitHub Link header, OpenAI ``has_more``/``last_id``,
etc.) live alongside their adapters in ``meridian/providers``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from ..contract import RawResponse, RequestOptions


class PaginationStrategy(ABC):
    @abstractmethod
    def extract_cursor(self, response: RawResponse) -> Optional[str]: ...

    @abstractmethod
    def extract_total(self, response: RawResponse) -> Optional[int]: ...

    @abstractmethod
    def has_next(self, response: RawResponse) -> bool: ...

    @abstractmethod
    def build_next_request(
        self, endpoint: str, options: RequestOptions, cursor: str
    ) -> tuple[str, RequestOptions]: ...


def _with_query(options: RequestOptions, **extra) -> RequestOptions:
    query = dict(options.query or {})
    query.update(extra)
    return RequestOptions(
        method=options.method,
        headers=options.headers,
        body=options.body,
        query=query,
        idempotency_key=options.idempotency_key,
        timeout=options.timeout,
        identity=options.identity,
    )


class CursorPaginationStrategy(PaginationStrategy):
    def __init__(
        self,
        cursor_header: str = "X-Cursor",
        cursor_query_param: str = "cursor",
        total_header: Optional[str] = None,
    ) -> None:
        self.cursor_header = cursor_header
        self.cursor_query_param = cursor_query_param
        self.total_header = total_header

    def extract_cursor(self, response: RawResponse) -> Optional[str]:
        cursor = response.headers.get(self.cursor_header)
        if cursor:
            return cursor
        if isinstance(response.body, dict) and "cursor" in response.body:
            return response.body.get("cursor")
        return None

    def extract_total(self, response: RawResponse) -> Optional[int]:
        if self.total_header:
            total = response.headers.get(self.total_header)
            if total:
                return int(total)
        if isinstance(response.body, dict) and "total" in response.body:
            return response.body.get("total")
        return None

    def has_next(self, response: RawResponse) -> bool:
        cursor = self.extract_cursor(response)
        return cursor is not None and cursor != ""

    def build_next_request(
        self, endpoint: str, options: RequestOptions, cursor: str
    ) -> tuple[str, RequestOptions]:
        return endpoint, _with_query(options, **{self.cursor_query_param: cursor})
