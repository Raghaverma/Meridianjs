"""Port of src/core/header-parser.ts."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

from ..contract import Headers

_YEAR_SECONDS = 86400 * 365


def parse_retry_after(header: Optional[str]) -> Optional[datetime]:
    if not header or not isinstance(header, str):
        return None
    trimmed = header.strip()

    if re.fullmatch(r"\d+", trimmed):
        seconds = int(trimmed)
        if 0 <= seconds <= _YEAR_SECONDS:
            return datetime.now(timezone.utc) + timedelta(seconds=seconds)

    try:
        parsed = parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        parsed = None
    if parsed is not None:
        now = datetime.now(timezone.utc)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if now < parsed < now + timedelta(seconds=_YEAR_SECONDS):
            return parsed
    return None


def parse_link_header(header: Optional[str]) -> list[dict]:
    if not header or not isinstance(header, str):
        return []
    links: list[dict] = []
    for part in _split_link_header(header):
        link = _parse_single_link(part.strip())
        if link:
            links.append(link)
    return links


def _split_link_header(header: str) -> list[str]:
    parts: list[str] = []
    current = ""
    in_angle = False
    for char in header:
        if char == "<":
            in_angle = True
            current += char
        elif char == ">":
            in_angle = False
            current += char
        elif char == "," and not in_angle:
            parts.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current.strip())
    return parts


def _parse_single_link(link: str) -> Optional[dict]:
    url_match = re.match(r"^<([^>]+)>", link)
    if not url_match:
        return None
    url = url_match.group(1)
    params: dict[str, str] = {}
    rel = ""
    remaining = link[len(url_match.group(0)) :]
    for param_part in remaining.split(";"):
        trimmed = param_part.strip()
        if not trimmed:
            continue
        match = re.match(r"^(\w+)=[\"']?([^\"']+)[\"']?$", trimmed)
        if match:
            key = match.group(1).lower()
            value = match.group(2)
            if key == "rel":
                rel = value
            else:
                params[key] = value
    if not rel:
        return None
    return {"url": url, "rel": rel, "params": params}


def find_link_by_rel(links: list[dict], rel: str) -> Optional[dict]:
    for link in links:
        if link.get("rel") == rel:
            return link
    return None


def parse_rate_limit_headers(headers: Headers) -> Optional[dict]:
    limit = _parse_int(headers.get("X-RateLimit-Limit"))
    remaining = _parse_int(headers.get("X-RateLimit-Remaining"))
    reset = _parse_reset(headers.get("X-RateLimit-Reset"))

    if limit is None:
        limit = _parse_int(headers.get("RateLimit-Limit"))
    if remaining is None:
        remaining = _parse_int(headers.get("RateLimit-Remaining"))
    if reset is None:
        reset = _parse_reset(headers.get("RateLimit-Reset"))

    if limit is None or remaining is None or reset is None:
        return None
    if limit < 0 or remaining < 0 or remaining > limit:
        return None
    return {"limit": limit, "remaining": remaining, "reset": reset}


def _parse_int(value: Optional[str]) -> Optional[int]:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = int(value.strip())
    except ValueError:
        return None
    if parsed < 0:
        return None
    return parsed


def _parse_reset(value: Optional[str]) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    trimmed = value.strip()
    if re.fullmatch(r"\d+", trimmed):
        timestamp = int(trimmed)
        now = int(datetime.now(timezone.utc).timestamp())
        if timestamp > 0 and now - 60 <= timestamp < now + _YEAR_SECONDS:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return None
