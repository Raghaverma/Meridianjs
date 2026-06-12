from __future__ import annotations

from meridian.contract import (
    ErrorCategory,
    ErrorCode,
    MeridianError,
    is_retryable_by_code,
    map_category_to_error_code,
)


def test_map_category_to_error_code():
    assert map_category_to_error_code(ErrorCategory.AUTH) == ErrorCode.AUTH_FAILED
    assert map_category_to_error_code(ErrorCategory.RATE_LIMIT) == ErrorCode.RATE_LIMITED
    assert map_category_to_error_code(ErrorCategory.NETWORK) == ErrorCode.NETWORK_ERROR
    assert map_category_to_error_code(ErrorCategory.VALIDATION, 404) == ErrorCode.NOT_FOUND
    assert map_category_to_error_code(ErrorCategory.VALIDATION, 400) == ErrorCode.BAD_REQUEST
    assert map_category_to_error_code(ErrorCategory.PROVIDER, 503) == ErrorCode.UPSTREAM_5XX
    assert map_category_to_error_code(ErrorCategory.PROVIDER, None) == ErrorCode.UNKNOWN


def test_is_retryable_by_code():
    assert is_retryable_by_code(ErrorCode.UPSTREAM_5XX) is True
    assert is_retryable_by_code(ErrorCode.RATE_LIMITED) is True
    assert is_retryable_by_code(ErrorCode.NOT_FOUND) is False
    assert is_retryable_by_code(ErrorCode.AUTH_FAILED) is False


def test_meridian_error_code_property():
    err = MeridianError("x", ErrorCategory.VALIDATION, "github", False, status=404)
    assert err.code == ErrorCode.NOT_FOUND
    err2 = MeridianError("y", ErrorCategory.PROVIDER, "github", True, status=502)
    assert err2.code == ErrorCode.UPSTREAM_5XX
