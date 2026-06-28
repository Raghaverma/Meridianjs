/**
 * Public API surface for Meridian SDK.
 *
 * This is the ONLY file consumers should import from.
 * All other modules are internal implementation details.
 */

export type { ProviderInfo } from "./capabilities/index.js";
// Provider capability registry
export { PROVIDER_CAPABILITIES } from "./capabilities/index.js";
// Endpoint safety guard (host-override / SSRF protection) — exposed so callers
// can pre-validate untrusted endpoint strings before issuing a request.
export { assertSafeEndpoint, isSafeEndpoint } from "./core/endpoint-validator.js";
// Streaming (SSE) support
export type { StreamChunk } from "./core/streaming.js";
// Core types - consumer contracts
// Auth types
// Adapter interface for custom providers
// Observability extension point
// State persistence interface for distributed deployments
// Schema validation types (if consumers opt-in)
// Pagination strategy interface for custom adapters
// Policy engine
export type {
  AdapterInput,
  AuthConfig,
  AuthToken,
  BatchRequest,
  BuiltRequest,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
  ErrorContext,
  IdempotencyConfig,
  MeridianConfig,
  MeridianErrorCategory,
  MeridianErrorCode,
  Metric,
  NormalizedResponse,
  ObservabilityAdapter,
  PaginationInfo,
  PaginationStrategy,
  Policy,
  PolicyContext,
  PolicyDecision,
  ProviderAdapter,
  ProviderConfig,
  RateLimitConfig,
  RateLimitInfo,
  RawResponse,
  RequestContext,
  RequestOptions,
  RequestTrace,
  ResponseContext,
  ResponseMeta,
  RetryConfig,
  Schema,
  SchemaDrift,
  SchemaMetadata,
  SchemaStorage,
  ServiceConfig,
  StateStorage,
} from "./core/types.js";
// Error type - frozen contract
// Idempotency configuration
// Circuit breaker state
export { CircuitState, IdempotencyLevel, MeridianError } from "./core/types.js";
export type {
  AddDeps,
  AddOptions,
  AddResult,
  CompletenessItem,
  CompletenessReport,
  GenerateOpenApiSpecOptions,
  GeneratorOptions,
  HttpMethod,
  KnownProviderSpec,
  OpenApiDocument,
  ProviderSpecSource,
} from "./generator/index.js";
// Adapter generator (programmatic API) — `meridian add` / `meridian generate`
export {
  addProvider,
  formatAddResult,
  generate,
  generateOpenApiSpec,
  KNOWN_PROVIDERS,
  listKnownProviders,
  resolveKnownProvider,
} from "./generator/index.js";
// Provider client interface
export type { ProviderClient } from "./index.js";
// Main client
export { Meridian } from "./index.js";
export type { CostEntry, CostReport } from "./infrastructure/analytics/collector.js";
export type { HealthEntry, ProviderStats } from "./infrastructure/analytics/index.js";
// Analytics & health
export { AnalyticsCollector } from "./infrastructure/analytics/index.js";
export type { RequestRecording } from "./infrastructure/debug/index.js";
// Debug recorder
export { DebugRecorder } from "./infrastructure/debug/index.js";
// Built-in observability adapters
export type { OpenTelemetryAutoOptions, OTelApiLike } from "./infrastructure/observability/auto.js";
// OpenTelemetry auto-instrumentation (binds to @opentelemetry/api, optional peer dep)
export { createOpenTelemetryObservability } from "./infrastructure/observability/auto.js";
export type { ConsoleObservabilityConfig } from "./infrastructure/observability/console.js";
export { ConsoleObservability } from "./infrastructure/observability/console.js";
export { NoOpObservability } from "./infrastructure/observability/noop.js";
export type { OpenTelemetryConfig } from "./infrastructure/observability/otel.js";
export { OpenTelemetryObservability } from "./infrastructure/observability/otel.js";
export type { PrometheusConfig } from "./infrastructure/observability/prometheus.js";
export { PrometheusObservability } from "./infrastructure/observability/prometheus.js";
export type {
  CheckResult,
  DriftEvent,
  EndpointReport,
  RegistryReport,
  SnapshotEntry,
  SnapshotResult,
} from "./infrastructure/registry/index.js";
// Local contract registry — `meridian registry snapshot/check/report`
export { ContractRegistry, DEFAULT_REGISTRY_DIR } from "./infrastructure/registry/index.js";
export type {
  BreakerTransition,
  FailoverHop,
  ReliabilityEvent,
  ReliabilitySession,
  ReplayOptions,
  ReplaySummary,
} from "./infrastructure/replay/index.js";
// Reliability replay — record real pipeline behavior, replay outages locally
export {
  DEFAULT_RECORDINGS_DIR,
  ReliabilityRecorder,
  ReliabilityStore,
  renderTimeline,
  replaySession,
  summarizeSession,
} from "./infrastructure/replay/index.js";
// Schema drift monitor
export { SchemaMonitor } from "./infrastructure/schema/index.js";
export type { SchemaReport } from "./infrastructure/schema/monitor.js";
export type { RedisLikeClient, UpstashRedisClient } from "./infrastructure/state/index.js";
// State storage implementations
export {
  MemoryStateStorage,
  RedisStateStorage,
  UpstashStateStorage,
} from "./infrastructure/state/index.js";
// Webhook verification
export { WebhookVerifier } from "./infrastructure/webhooks/index.js";
export type { MigrationFinding, MigrationReport } from "./migrate/index.js";
// Migration scanner — `meridian migrate <provider>`
export {
  formatMigrationReport,
  listMigrationProviders,
  scanForMigration,
} from "./migrate/index.js";
export type { GrpcProxyServerOptions, ProxyServerOptions } from "./networking/proxy/index.js";
// gRPC boundary proxy — language-agnostic access to the Meridian pipeline
export { BoundaryGrpcServer } from "./networking/proxy/index.js";
export type { PaymentRouterOptions } from "./networking/routers/index.js";
// Routers
export { PaymentRouter } from "./networking/routers/index.js";
// Service abstraction (failover / round-robin / lowest-latency routing)
export { ServiceClient } from "./networking/services/index.js";
export {
  allowedProviders,
  blockedProviders,
  blockPII,
  customPolicy,
  denyCountries,
  readOnly,
  redact,
  requireFields,
} from "./orchestration/policies/index.js";
export type { TransactionResult, TransactionStep } from "./orchestration/transactions/index.js";
// Multi-provider transactions
export { runTransaction, TransactionError } from "./orchestration/transactions/index.js";
// Built-in provider adapters — import from a category subpath, NOT this
// barrel. `import "meridianjs"` must stay cheap for plain (non-bundled) Node
// usage; re-exporting all 46 adapter classes here would force eager loading
// of every provider module on every import regardless of which one you use.
//   import { StripeAdapter } from "meridianjs/providers/payments";
//   import { OpenAIAdapter } from "meridianjs/providers/ai";
// See docs/adapters.md and the migration notes in CHANGELOG.md.
// Distributed 429 cooldown coordination
export { SharedCooldownManager } from "./resilience/shared-cooldown.js";
export type { StudioServerHandle, StudioServerOptions } from "./studio/server.js";
export type { MockCall, MockHandler, MockResponse } from "./testing/index.js";
// Testing utilities
export { Fixtures, MockAdapter } from "./testing/index.js";
export type { UpiDeepLinkOptions } from "./upi/index.js";
// UPI flow helpers
export { createUpiDeepLink, validateVpa } from "./upi/index.js";
