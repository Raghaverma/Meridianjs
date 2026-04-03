
/**
 * Public API surface for Meridian SDK.
 *
 * This is the ONLY file consumers should import from.
 * All other modules are internal implementation details.
 */

// Main client
export { Meridian } from "./index.js";

// Core types - consumer contracts
export type {
  MeridianConfig,
  ProviderConfig,
  NormalizedResponse,
  ResponseMeta,
  PaginationInfo,
  RateLimitInfo,
  RequestOptions,
  CircuitBreakerStatus,
} from "./core/types.js";

// Error type - frozen contract
export { MeridianError } from "./core/types.js";
export type { MeridianErrorCategory, MeridianErrorCode } from "./core/types.js";

// Auth types
export type { AuthConfig, AuthToken } from "./core/types.js";

// Adapter interface for custom providers
export type { ProviderAdapter } from "./core/types.js";

// Provider client interface
export type { ProviderClient } from "./index.js";

// Observability extension point
export type {
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
  ErrorContext,
  Metric,
} from "./core/types.js";

// Built-in observability adapters
export { ConsoleObservability } from "./observability/console.js";
export { NoOpObservability } from "./observability/noop.js";

// State persistence interface for distributed deployments
export type { StateStorage } from "./core/types.js";

// Idempotency configuration
export { IdempotencyLevel } from "./core/types.js";
export type { IdempotencyConfig } from "./core/types.js";

// Circuit breaker state
export { CircuitState } from "./core/types.js";

// Schema validation types (if consumers opt-in)
export type {
  Schema,
  SchemaStorage,
  SchemaMetadata,
  SchemaDrift,
} from "./core/types.js";

// Pagination strategy interface for custom adapters
export type { PaginationStrategy } from "./core/types.js";

// Built-in provider adapters
export { AnthropicAdapter } from "./providers/anthropic/adapter.js";
export { OpenAIAdapter } from "./providers/openai/adapter.js";
export { StripeAdapter } from "./providers/stripe/adapter.js";
export { GitHubAdapter } from "./providers/github/adapter.js";

// Claw / agent proxy integration
export { BoundaryProxyServer } from "./proxy/server.js";
export type { ProxyServerOptions } from "./proxy/server.js";
