/**
 * Public API surface for Meridian SDK.
 *
 * This is the ONLY file consumers should import from.
 * All other modules are internal implementation details.
 */

export type { CostEntry, CostReport } from "./analytics/collector.js";
export type { HealthEntry, ProviderStats } from "./analytics/index.js";
// Analytics & health
export { AnalyticsCollector } from "./analytics/index.js";
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
export type { RequestRecording } from "./debug/index.js";
// Debug recorder
export { DebugRecorder } from "./debug/index.js";
export type {
  GenerateOpenApiSpecOptions,
  GeneratorOptions,
  HttpMethod,
  OpenApiDocument,
  ProviderSpecSource,
} from "./generator/index.js";
// Adapter generator (programmatic API)
export { generate, generateOpenApiSpec } from "./generator/index.js";
// Provider client interface
export type { ProviderClient } from "./index.js";
// Main client
export { Meridian } from "./index.js";
// Built-in observability adapters
export { ConsoleObservability } from "./observability/console.js";
export { NoOpObservability } from "./observability/noop.js";
export {
  allowedProviders,
  blockedProviders,
  blockPII,
  customPolicy,
  denyCountries,
  readOnly,
  redact,
  requireFields,
} from "./policies/index.js";
export { AdyenAdapter } from "./providers/adyen/adapter.js";
// Built-in provider adapters
export { AnthropicAdapter } from "./providers/anthropic/adapter.js";
export { ApolloAdapter } from "./providers/apollo/adapter.js";
export { Auth0Adapter } from "./providers/auth0/adapter.js";
export { BilldeskAdapter } from "./providers/billdesk/adapter.js";
export { BraintreeAdapter } from "./providers/braintree/adapter.js";
export { CashfreeAdapter } from "./providers/cashfree/adapter.js";
export { CcavenueAdapter, ccavenueDecrypt, ccavenueEncrypt } from "./providers/ccavenue/adapter.js";
export { CheckoutAdapter } from "./providers/checkout/adapter.js";
export { CleartaxAdapter } from "./providers/cleartax/adapter.js";
export { CohereAdapter } from "./providers/cohere/adapter.js";
export { DatadogAdapter } from "./providers/datadog/adapter.js";
export { DecentroAdapter } from "./providers/decentro/adapter.js";
export { DelhiveryAdapter } from "./providers/delhivery/adapter.js";
export { DigioAdapter } from "./providers/digio/adapter.js";
export { ExotelAdapter } from "./providers/exotel/adapter.js";
export { GeminiAdapter } from "./providers/gemini/adapter.js";
export { GitHubAdapter } from "./providers/github/adapter.js";
export { GupshupAdapter } from "./providers/gupshup/adapter.js";
export { HubSpotAdapter } from "./providers/hubspot/adapter.js";
export { HyperVergeAdapter } from "./providers/hyperverge/adapter.js";
export { IdfyAdapter } from "./providers/idfy/adapter.js";
export { JuspayAdapter } from "./providers/juspay/adapter.js";
export { KarzaAdapter } from "./providers/karza/adapter.js";
export { KlarnaAdapter } from "./providers/klarna/adapter.js";
export { MailgunAdapter } from "./providers/mailgun/adapter.js";
export { MapmyindiaAdapter } from "./providers/mapmyindia/adapter.js";
export { MistralAdapter } from "./providers/mistral/adapter.js";
export { MollieAdapter } from "./providers/mollie/adapter.js";
export { Msg91Adapter } from "./providers/msg91/adapter.js";
export { OpenAIAdapter } from "./providers/openai/adapter.js";
export { PayuAdapter } from "./providers/payu/adapter.js";
export { PerfiosAdapter } from "./providers/perfios/adapter.js";
export { PhonePeAdapter } from "./providers/phonepe/adapter.js";
export { RazorpayAdapter } from "./providers/razorpay/adapter.js";
export { S3Adapter } from "./providers/s3/adapter.js";
export type { SigV4Credentials } from "./providers/s3/sigv4.js";
export { signSigV4 } from "./providers/s3/sigv4.js";
export { SendgridAdapter } from "./providers/sendgrid/adapter.js";
export { SentryAdapter } from "./providers/sentry/adapter.js";
export { SetuAdapter } from "./providers/setu/adapter.js";
export { ShiprocketAdapter } from "./providers/shiprocket/adapter.js";
export { StripeAdapter } from "./providers/stripe/adapter.js";
export { SupabaseAdapter } from "./providers/supabase/adapter.js";
export { TwilioAdapter } from "./providers/twilio/adapter.js";
export { VonageAdapter } from "./providers/vonage/adapter.js";
export type { ProxyServerOptions } from "./proxy/server.js";
// Claw / agent proxy integration
export { BoundaryProxyServer } from "./proxy/server.js";
export type { PaymentRouterOptions } from "./routers/index.js";
// Routers
export { PaymentRouter } from "./routers/index.js";

// Schema drift monitor
export { SchemaMonitor } from "./schema/index.js";
export type { SchemaReport } from "./schema/monitor.js";
// Service abstraction (failover / round-robin / lowest-latency routing)
export { ServiceClient } from "./services/index.js";
export type { RedisLikeClient, UpstashRedisClient } from "./state/index.js";
// State storage implementations
export { MemoryStateStorage, RedisStateStorage, UpstashStateStorage } from "./state/index.js";
export type { MockCall, MockHandler, MockResponse } from "./testing/index.js";
// Testing utilities
export { Fixtures, MockAdapter } from "./testing/index.js";
export type { TransactionResult, TransactionStep } from "./transactions/index.js";

// Multi-provider transactions
export { runTransaction, TransactionError } from "./transactions/index.js";
export type { UpiDeepLinkOptions } from "./upi/index.js";

// UPI flow helpers
export { createUpiDeepLink, validateVpa } from "./upi/index.js";
// Webhook verification
export { WebhookVerifier } from "./webhooks/index.js";
