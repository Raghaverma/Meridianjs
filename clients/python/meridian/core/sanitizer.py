"""Port of src/core/request-sanitizer.ts + observability-sanitizer.ts.

Redacts credential-bearing keys and (optionally) PII patterns from request
options and arbitrary payloads, matching the TypeScript redaction rules so the
two engines scrub identically.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ..contract import RequestOptions

# Bounded quantifiers mirror the TS patterns (which bound them to avoid ReDoS).
_EMAIL = re.compile(r"[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,255}\.[a-zA-Z]{2,24}")
_PHONE = re.compile(r"(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_CREDIT_CARD = re.compile(r"\b(?:\d[ -]*?){13,16}\b")

_UPI_VPA = re.compile(r"\b[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}\b")
_AADHAAR = re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b")
_PAN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
_BANK_ACCOUNT = re.compile(r"\b\d{9,18}\b")

DEFAULT_REDACTED = ["authorization", "cookie", "token", "apikey", "api_key", "body"]


def _apply_pii_patterns(text: str, india_mode: bool) -> str:
    result = text
    if india_mode:
        result = _UPI_VPA.sub("[VPA-REDACTED]", result)
        result = _AADHAAR.sub("[AADHAAR-REDACTED]", result)
        result = _PAN.sub("[PAN-REDACTED]", result)
        result = _BANK_ACCOUNT.sub("[ACCOUNT-REDACTED]", result)
    result = _EMAIL.sub("[PII-REDACTED]", result)
    result = _PHONE.sub("[PII-REDACTED]", result)
    result = _SSN.sub("[PII-REDACTED]", result)
    result = _CREDIT_CARD.sub("[PII-REDACTED]", result)
    return result


def _sanitize_value(val: Any, india_mode: bool) -> Any:
    if isinstance(val, str):
        return _apply_pii_patterns(val, india_mode)
    if isinstance(val, list):
        return [_sanitize_value(item, india_mode) for item in val]
    if isinstance(val, dict):
        return {k: _sanitize_value(v, india_mode) for k, v in val.items()}
    return val


def redact_pii(value: Any, india_mode: bool = False) -> Any:
    """Deeply redact PII patterns from an arbitrary value."""
    return _sanitize_value(value, india_mode)


def sanitize_request_options(
    options: Optional[RequestOptions],
    redacted_keys: Optional[list[str]] = None,
    pii_redaction: bool = False,
    india_mode: bool = False,
) -> RequestOptions:
    redacted = [k.lower() for k in (redacted_keys or DEFAULT_REDACTED)]
    src = options or RequestOptions()
    run_pattern = pii_redaction or india_mode

    def _key_redacted(key: str, value: Any) -> bool:
        lower = re.sub(r"[-_]", "", key.lower())
        lower_value = str(value).lower()
        for r in redacted:
            normalized_r = re.sub(r"[-_]", "", r)
            if normalized_r in lower or r in lower_value:
                return True
        return False

    headers = None
    if src.headers:
        headers = {
            k: ("[REDACTED]" if _key_redacted(k, v) else v) for k, v in src.headers.items()
        }

    query = None
    if src.query:
        query = {
            k: ("[REDACTED]" if _key_redacted(k, v) else v) for k, v in src.query.items()
        }

    body = src.body
    if body is not None:
        if "body" in redacted and not run_pattern:
            body = "[REDACTED]"
        elif run_pattern and isinstance(body, str):
            body = _apply_pii_patterns(body, india_mode)
        elif run_pattern and isinstance(body, (dict, list)):
            body = _sanitize_value(body, india_mode)

    return RequestOptions(
        method=src.method,
        headers=headers,
        body=body,
        query=query,
        idempotency_key=src.idempotency_key,
        timeout=src.timeout,
        identity=src.identity,
    )


def sanitize_object(obj: Any, redacted_keys: Optional[list[str]] = None) -> Any:
    """Key-based redaction over an arbitrary value (port of sanitizeObject)."""
    redacted = [k.lower() for k in (redacted_keys or DEFAULT_REDACTED)]

    def _should_redact(key: str) -> bool:
        lower = key.lower()
        return any(r in lower for r in redacted)

    if obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, list):
        return [sanitize_object(v, redacted_keys) for v in obj]
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if _should_redact(k):
                out[k] = "[REDACTED]"
            elif isinstance(v, (dict, list)):
                out[k] = sanitize_object(v, redacted_keys)
            else:
                out[k] = v
        return out
    return obj
