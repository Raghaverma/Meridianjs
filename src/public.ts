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
  AuthConfig,
  AuthToken,
  BatchRequest,
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
  RateLimitInfo,
  RequestContext,
  RequestOptions,
  RequestTrace,
  ResponseContext,
  ResponseMeta,
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
export { ConsoleObservability } from "./infrastructure/observability/console.js";
export { NoOpObservability } from "./infrastructure/observability/noop.js";
export type { OpenTelemetryConfig } from "./infrastructure/observability/otel.js";
export { OpenTelemetryObservability } from "./infrastructure/observability/otel.js";
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
// Built-in provider adapters
export { AnthropicAdapter } from "./providers/ai/anthropic/adapter.js";
export { CohereAdapter } from "./providers/ai/cohere/adapter.js";
export { GeminiAdapter } from "./providers/ai/gemini/adapter.js";
export { MistralAdapter } from "./providers/ai/mistral/adapter.js";
export { OpenAIAdapter } from "./providers/ai/openai/adapter.js";
export { GitHubAdapter } from "./providers/crm/github/adapter.js";
export { HubSpotAdapter } from "./providers/crm/hubspot/adapter.js";
export { ApolloAdapter } from "./providers/healthcare/apollo/adapter.js";
export { Auth0Adapter } from "./providers/identity/auth0/adapter.js";
export { DecentroAdapter } from "./providers/identity/decentro/adapter.js";
export { DigioAdapter } from "./providers/identity/digio/adapter.js";
export { HyperVergeAdapter } from "./providers/identity/hyperverge/adapter.js";
export { IdfyAdapter } from "./providers/identity/idfy/adapter.js";
export { KarzaAdapter } from "./providers/identity/karza/adapter.js";
export { PerfiosAdapter } from "./providers/identity/perfios/adapter.js";
export { SetuAdapter } from "./providers/identity/setu/adapter.js";
export { DelhiveryAdapter } from "./providers/logistics/delhivery/adapter.js";
export { ShiprocketAdapter } from "./providers/logistics/shiprocket/adapter.js";
export { MapmyindiaAdapter } from "./providers/maps/mapmyindia/adapter.js";
export { ExotelAdapter } from "./providers/messaging/exotel/adapter.js";
export { GupshupAdapter } from "./providers/messaging/gupshup/adapter.js";
export { MailgunAdapter } from "./providers/messaging/mailgun/adapter.js";
export { Msg91Adapter } from "./providers/messaging/msg91/adapter.js";
export { SendgridAdapter } from "./providers/messaging/sendgrid/adapter.js";
export { TwilioAdapter } from "./providers/messaging/twilio/adapter.js";
export { VonageAdapter } from "./providers/messaging/vonage/adapter.js";
export { DatadogAdapter } from "./providers/monitoring/datadog/adapter.js";
export { SentryAdapter } from "./providers/monitoring/sentry/adapter.js";
export { AdyenAdapter } from "./providers/payments/adyen/adapter.js";
export { BilldeskAdapter } from "./providers/payments/billdesk/adapter.js";
export { BraintreeAdapter } from "./providers/payments/braintree/adapter.js";
export { CashfreeAdapter } from "./providers/payments/cashfree/adapter.js";
export {
  CcavenueAdapter,
  ccavenueDecrypt,
  ccavenueEncrypt,
} from "./providers/payments/ccavenue/adapter.js";
export { CheckoutAdapter } from "./providers/payments/checkout/adapter.js";
export { JuspayAdapter } from "./providers/payments/juspay/adapter.js";
export { KlarnaAdapter } from "./providers/payments/klarna/adapter.js";
export { MollieAdapter } from "./providers/payments/mollie/adapter.js";
export { PayuAdapter } from "./providers/payments/payu/adapter.js";
export { PhonePeAdapter } from "./providers/payments/phonepe/adapter.js";
export { RazorpayAdapter } from "./providers/payments/razorpay/adapter.js";
export { StripeAdapter } from "./providers/payments/stripe/adapter.js";
export { S3Adapter } from "./providers/storage/s3/adapter.js";
export type { SigV4Credentials } from "./providers/storage/s3/sigv4.js";
export { signSigV4 } from "./providers/storage/s3/sigv4.js";
export { SupabaseAdapter } from "./providers/storage/supabase/adapter.js";
export { CleartaxAdapter } from "./providers/tax/cleartax/adapter.js";
// Distributed 429 cooldown coordination
export { SharedCooldownManager } from "./resilience/shared-cooldown.js";
export type { MockCall, MockHandler, MockResponse } from "./testing/index.js";
// Testing utilities
export { Fixtures, MockAdapter } from "./testing/index.js";
export type { UpiDeepLinkOptions } from "./upi/index.js";
// UPI flow helpers
export { createUpiDeepLink, validateVpa } from "./upi/index.js";
