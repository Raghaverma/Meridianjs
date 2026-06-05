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
  BatchRequest,
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

// Streaming (SSE) support
export type { StreamChunk } from "./core/streaming.js";

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
export { RazorpayAdapter } from "./providers/razorpay/adapter.js";
export { CashfreeAdapter } from "./providers/cashfree/adapter.js";
export { PayuAdapter } from "./providers/payu/adapter.js";
export { JuspayAdapter } from "./providers/juspay/adapter.js";
export { Msg91Adapter } from "./providers/msg91/adapter.js";
export { ExotelAdapter } from "./providers/exotel/adapter.js";
export { GupshupAdapter } from "./providers/gupshup/adapter.js";
export { SetuAdapter } from "./providers/setu/adapter.js";
export { DecentroAdapter } from "./providers/decentro/adapter.js";
export { ShiprocketAdapter } from "./providers/shiprocket/adapter.js";
export { DelhiveryAdapter } from "./providers/delhivery/adapter.js";
export { HyperVergeAdapter } from "./providers/hyperverge/adapter.js";
export { DigioAdapter } from "./providers/digio/adapter.js";
export { KarzaAdapter } from "./providers/karza/adapter.js";
export { IdfyAdapter } from "./providers/idfy/adapter.js";
export { CleartaxAdapter } from "./providers/cleartax/adapter.js";
export { MapmyindiaAdapter } from "./providers/mapmyindia/adapter.js";
export { PerfiosAdapter } from "./providers/perfios/adapter.js";
export { TwilioAdapter } from "./providers/twilio/adapter.js";
export { SendgridAdapter } from "./providers/sendgrid/adapter.js";
export { MailgunAdapter } from "./providers/mailgun/adapter.js";
export { VonageAdapter } from "./providers/vonage/adapter.js";
export { AdyenAdapter } from "./providers/adyen/adapter.js";
export { BraintreeAdapter } from "./providers/braintree/adapter.js";
export { PhonePeAdapter } from "./providers/phonepe/adapter.js";
export { GeminiAdapter } from "./providers/gemini/adapter.js";
export { Auth0Adapter } from "./providers/auth0/adapter.js";
export { HubSpotAdapter } from "./providers/hubspot/adapter.js";
export { SupabaseAdapter } from "./providers/supabase/adapter.js";
export { CheckoutAdapter } from "./providers/checkout/adapter.js";
export { CohereAdapter } from "./providers/cohere/adapter.js";
export { KlarnaAdapter } from "./providers/klarna/adapter.js";
export { MistralAdapter } from "./providers/mistral/adapter.js";
export { MollieAdapter } from "./providers/mollie/adapter.js";
export { ApolloAdapter } from "./providers/apollo/adapter.js";

// Claw / agent proxy integration
export { BoundaryProxyServer } from "./proxy/server.js";
export type { ProxyServerOptions } from "./proxy/server.js";

// State storage implementations
export { MemoryStateStorage, RedisStateStorage, UpstashStateStorage } from "./state/index.js";
export type { RedisLikeClient, UpstashRedisClient } from "./state/index.js";

// Webhook verification
export { WebhookVerifier } from "./webhooks/index.js";

// Testing utilities
export { MockAdapter, Fixtures } from "./testing/index.js";
export type { MockCall, MockHandler, MockResponse } from "./testing/index.js";

// Routers
export { PaymentRouter } from "./routers/index.js";
export type { PaymentRouterOptions } from "./routers/index.js";

// Service abstraction (failover / round-robin / lowest-latency routing)
export { ServiceClient } from "./services/index.js";
export type { ServiceConfig, RequestTrace } from "./core/types.js";

// Analytics & health
export { AnalyticsCollector } from "./analytics/index.js";
export type { ProviderStats, HealthEntry } from "./analytics/index.js";

// Provider capability registry
export { PROVIDER_CAPABILITIES } from "./capabilities/index.js";
export type { ProviderInfo } from "./capabilities/index.js";

// Debug recorder
export { DebugRecorder } from "./debug/index.js";
export type { RequestRecording } from "./debug/index.js";

// Schema drift monitor
export { SchemaMonitor } from "./schema/index.js";
export type { SchemaReport } from "./schema/monitor.js";
export type { CostReport, CostEntry } from "./analytics/collector.js";

// Adapter generator (programmatic API)
export { generate } from "./generator/index.js";
export type { GeneratorOptions } from "./generator/index.js";

// Policy engine
export type { Policy, PolicyContext, PolicyDecision } from "./core/types.js";
export {
  blockPII,
  allowedProviders,
  blockedProviders,
  readOnly,
  customPolicy,
  redact,
  requireFields,
  denyCountries,
} from "./policies/index.js";

// Multi-provider transactions
export { runTransaction, TransactionError } from "./transactions/index.js";
export type { TransactionStep, TransactionResult } from "./transactions/index.js";
