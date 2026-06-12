"""Built-in provider adapters.

The reference set ports the four dominant adapter shapes from the TypeScript
engine. Remaining providers follow the same pattern: subclass ProviderAdapter,
implement build_request/parse_response/parse_error/auth_strategy/
rate_limit_policy/pagination_strategy/get_idempotency_config, and register the
class in BUILTIN_ADAPTERS below.
"""

from __future__ import annotations

from ..adapter import ProviderAdapter
from .anthropic import AnthropicAdapter
from .github import GitHubAdapter
from .openai import OpenAIAdapter
from .stripe import StripeAdapter

BUILTIN_ADAPTERS: dict[str, type[ProviderAdapter]] = {
    "github": GitHubAdapter,
    "openai": OpenAIAdapter,
    "anthropic": AnthropicAdapter,
    "stripe": StripeAdapter,
}

__all__ = [
    "ProviderAdapter",
    "GitHubAdapter",
    "OpenAIAdapter",
    "AnthropicAdapter",
    "StripeAdapter",
    "BUILTIN_ADAPTERS",
]
