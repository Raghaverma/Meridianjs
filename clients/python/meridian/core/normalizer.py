"""Port of src/core/normalizer.ts."""

from __future__ import annotations

import uuid
from typing import Optional

from ..contract import NormalizedResponse, PaginationInfo, RateLimitInfo, RawResponse, ResponseMeta
from ..strategies.pagination import PaginationStrategy


class ResponseNormalizer:
    @staticmethod
    def normalize(
        raw: RawResponse,
        provider: str,
        rate_limit_info: RateLimitInfo,
        pagination_info: Optional[PaginationInfo] = None,
        warnings: Optional[list[str]] = None,
        schema_version: str = "1.0.0",
    ) -> NormalizedResponse:
        meta = ResponseMeta(
            provider=provider,
            request_id=str(uuid.uuid4()),
            rate_limit=rate_limit_info,
            warnings=warnings or [],
            schema_version=schema_version,
            pagination=pagination_info,
        )
        return NormalizedResponse(data=raw.body, meta=meta)

    @staticmethod
    def extract_pagination_info(
        raw: RawResponse, pagination_strategy: PaginationStrategy
    ) -> Optional[PaginationInfo]:
        if not pagination_strategy.has_next(raw):
            return None
        cursor = pagination_strategy.extract_cursor(raw)
        total = pagination_strategy.extract_total(raw)
        return PaginationInfo(has_next=True, cursor=cursor, total=total)
