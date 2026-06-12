"""Port of src/core/endpoint-validator.ts (SSRF / host-override guard).

Rejects absolute, protocol-relative, backslash-smuggled, and control-char
endpoints before any adapter resolves a URL, so an untrusted endpoint cannot
redirect a credentialed request to an attacker-controlled host.
"""

from __future__ import annotations

import re

from ..contract import ErrorCategory, MeridianError

_SCHEME_PREFIX = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")


def _has_control_char(value: str) -> bool:
    return any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value)


def is_safe_endpoint(endpoint: object) -> bool:
    if not isinstance(endpoint, str):
        return False
    if _has_control_char(endpoint):
        return False

    normalized = endpoint.strip().replace("\\", "/")
    if normalized.startswith("//"):
        return False

    leading_segment = re.split(r"[/?#]", normalized, maxsplit=1)[0]
    if _SCHEME_PREFIX.search(leading_segment):
        return False
    return True


def assert_safe_endpoint(endpoint: str, provider: str, request_id: str = "") -> None:
    if not is_safe_endpoint(endpoint):
        raise MeridianError(
            "Endpoint must be a relative path. Absolute or protocol-relative URLs are "
            "rejected to prevent redirecting authenticated requests to an unintended host.",
            ErrorCategory.VALIDATION,
            provider,
            False,
            request_id,
        )
