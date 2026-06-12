"""Shared helpers for provider adapters."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional
from urllib.parse import urlencode, urljoin

from ..contract import Headers
from ..core.header_parser import parse_retry_after

SDK_VERSION = "0.2.11"


def build_url(base_url: str, endpoint: str, query: Optional[dict]) -> str:
    url = urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))
    if query:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urlencode({k: str(v) for k, v in query.items()})}"
    return url


def extract_retry_after(headers: Headers) -> Optional[datetime]:
    return parse_retry_after(headers.get("retry-after"))


def parse_openai_duration(duration: str) -> int:
    """OpenAI encodes rate-limit reset as a duration string: '6m0s', '500ms'."""
    total_ms = 0
    hours = re.search(r"(\d+)h", duration)
    minutes = re.search(r"(\d+)m(?!s)", duration)
    seconds = re.search(r"(\d+)s", duration)
    ms = re.search(r"(\d+)ms", duration)
    if hours:
        total_ms += int(hours.group(1)) * 3_600_000
    if minutes:
        total_ms += int(minutes.group(1)) * 60_000
    if seconds:
        total_ms += int(seconds.group(1)) * 1_000
    if ms:
        total_ms += int(ms.group(1))
    return total_ms
