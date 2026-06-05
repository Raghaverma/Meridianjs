export interface NormalizedResponse<T = unknown> {
  data: T;
  meta: ResponseMeta;
}

export interface RequestTrace {
  retries: number;
  latency: number;
  circuitBreaker: CircuitState;
  rateLimitRemaining: number;
}

export interface ResponseMeta {
  provider: string;
  requestId: string;
  rateLimit: RateLimitInfo;
  pagination?: PaginationInfo;
  warnings: string[];
  schemaVersion: string;
  trace?: RequestTrace;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
}

export interface PaginationInfo {
  hasNext: boolean;
  cursor?: string;
  total?: number;
}

export type MeridianErrorCategory = "auth" | "rate_limit" | "network" | "provider" | "validation";

export type MeridianErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UPSTREAM_5XX"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN";

export class MeridianError extends Error {
  category: MeridianErrorCategory;

  retryable: boolean;

  provider: string;

  requestId: string;

  status?: number;

  metadata?: Record<string, unknown>;

  retryAfter?: Date;

  constructor(
    message: string,
    category: MeridianErrorCategory,
    provider: string,
    retryable: boolean,
    requestId = "",
    metadata?: Record<string, unknown>,
    retryAfter?: Date,
    status?: number,
  ) {
    super(message);
    this.name = "MeridianError";
    this.category = category;
    this.provider = provider;
    this.retryable = retryable;
    this.requestId = requestId;

    if (status !== undefined) {
      this.status = status;
    }
    if (metadata !== undefined) {
      this.metadata = metadata;
    }
    if (retryAfter !== undefined) {
      this.retryAfter = retryAfter;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MeridianError);
    }
  }

  /**
   * Returns the frozen error code from the MeridianErrorCode enum.
   * Maps internal category to public error code contract.
   */
  get code(): MeridianErrorCode {
    return mapCategoryToErrorCode(this.category, this.status);
  }
}

export function mapCategoryToErrorCode(
  category: MeridianErrorCategory,
  status?: number,
): MeridianErrorCode {
  switch (category) {
    case "auth":
      return "AUTH_FAILED";
    case "rate_limit":
      return "RATE_LIMITED";
    case "network":
      return "NETWORK_ERROR";
    case "validation":
      if (status === 404) {
        return "NOT_FOUND";
      }
      if (status && status >= 400 && status < 500) {
        return "BAD_REQUEST";
      }
      return "BAD_REQUEST";
    case "provider":
      if (status && status >= 500) {
        return "UPSTREAM_5XX";
      }
      return "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

export function isRetryableByCode(code: MeridianErrorCode): boolean {
  switch (code) {
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "UPSTREAM_5XX":
    case "RATE_LIMITED":
      return true;
    default:
      return false;
  }
}

export type ErrorType =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "VALIDATION_ERROR"
  | "PROVIDER_ERROR"
  | "NETWORK_ERROR"
  | "CIRCUIT_OPEN";

export interface NormalizedError extends Error {
  type: ErrorType;
  provider: string;
  actionable: string;
  raw?: unknown;
  retryable: boolean;
  retryAfter?: Date;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  idempotencyKey?: string;
  timeout?: number;
  identity?: string | undefined;
}

export interface BatchRequest {
  method: string;
  endpoint: string;
  options?: RequestOptions;
}

export interface RequestContext {
  provider: string;
  endpoint: string;
  method: string;
  requestId: string;
  timestamp: Date;
  options: RequestOptions;
  identity?: string | undefined;
}

export interface ResponseContext {
  provider: string;
  endpoint: string;
  method: string;
  requestId: string;
  statusCode: number;
  duration: number;
  timestamp: Date;
  identity?: string | undefined;
  trace?: RequestTrace;
}

export interface ErrorContext {
  provider: string;
  endpoint: string;
  method: string;
  requestId: string;
  error: MeridianError;
  duration: number;
  timestamp: Date;
  identity?: string | undefined;
}

export interface AuthConfig {
  token?: string;
  apiKey?: string;
  apiSecret?: string;
  apiKeyHeader?: string;
  apiKeyQuery?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  custom?: Record<string, string>;
}

export interface AuthToken {
  token: string;
  secret?: string | undefined;
  expiresAt?: Date;
  refreshToken?: string;
}

export interface StateStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface AdapterInput {
  endpoint: string;
  options: RequestOptions;
  authToken: AuthToken;
  baseUrl?: string;
}

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

export interface ProviderAdapter {
  buildRequest(input: AdapterInput): BuiltRequest;

  parseResponse(raw: RawResponse): NormalizedResponse;

  parseError(raw: unknown): MeridianError;

  authStrategy(config: AuthConfig): Promise<AuthToken>;

  rateLimitPolicy(headers: Headers): RateLimitInfo;

  paginationStrategy(): PaginationStrategy;

  getIdempotencyConfig(): IdempotencyConfig;

  /** Optional: refresh an expired token. Called by the pipeline on 401 before retrying. */
  refreshAuth?(config: AuthConfig, expiredToken: AuthToken): Promise<AuthToken>;

  /** Optional: verify a provider webhook signature. Returns true if valid. */
  verifyWebhook?(payload: string | Buffer, signature: string, secret: string): boolean;

  /** Optional: parse one raw SSE data payload into a typed chunk. Defaults to JSON.parse. */
  parseStreamChunk?(raw: string): unknown;

  /** Optional: declare provider capabilities (e.g. "chat", "streaming", "payments"). */
  capabilities?(): string[];
}

export interface LegacyProviderAdapter {
  authenticate(config: AuthConfig): Promise<AuthToken>;
  makeRequest(
    endpoint: string,
    options: RequestOptions,
    authToken: AuthToken,
  ): Promise<RawResponse>;
  normalizeResponse(raw: RawResponse): NormalizedResponse;
  parseRateLimit(headers: Headers): RateLimitInfo;
  parseError(error: unknown): NormalizedError;
  getPaginationStrategy(): PaginationStrategy;
  getIdempotencyConfig(): IdempotencyConfig;
}

export enum IdempotencyLevel {
  SAFE = "SAFE",
  IDEMPOTENT = "IDEMPOTENT",
  CONDITIONAL = "CONDITIONAL",
  UNSAFE = "UNSAFE",
}

export interface IdempotencyConfig {
  defaultSafeOperations: Set<string>;
  operationOverrides: Map<string, IdempotencyLevel>;
}

export interface PaginationStrategy {
  extractCursor(response: RawResponse): string | null;
  extractTotal(response: RawResponse): number | null;
  hasNext(response: RawResponse): boolean;
  buildNextRequest(
    endpoint: string,
    options: RequestOptions,
    cursor: string,
  ): { endpoint: string; options: RequestOptions };
}

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  volumeThreshold: number;
  rollingWindowMs: number;
  errorThresholdPercentage: number;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  nextAttempt: Date | null;
}

export interface RateLimitConfig {
  tokensPerSecond: number;
  maxTokens: number;
  adaptiveBackoff: boolean;
  queueSize?: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitter: boolean;
}

export interface Schema {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  [key: string]: unknown;
}

export interface SchemaMetadata {
  provider: string;
  endpoint: string;
  version: string;
  checksum: string;
  createdAt: Date;
}

export interface SchemaDrift {
  type: "FIELD_REMOVED" | "TYPE_CHANGED" | "REQUIRED_ADDED" | "REQUIRED_REMOVED";
  field: string;
  oldValue: unknown;
  newValue: unknown;
  severity: "WARNING" | "ERROR";
}

export interface SchemaStorage {
  save(provider: string, endpoint: string, schema: Schema, version: string): Promise<void>;
  load(provider: string, endpoint: string): Promise<Schema | null>;
  list(provider: string): Promise<SchemaMetadata[]>;
}

export interface Metric {
  name: string;
  value: number;
  tags: Record<string, string>;
  timestamp: Date;
}

export interface ObservabilityAdapter {
  logRequest(context: RequestContext): void;
  logResponse(context: ResponseContext): void;
  logError(context: ErrorContext): void;
  logWarning(message: string, metadata?: Record<string, unknown>): void;
  recordMetric(metric: Metric): void;
}

export interface ProviderConfig {
  auth: AuthConfig;
  adapter?: ProviderAdapter;
  baseUrl?: string;
  retry?: Partial<RetryConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  rateLimit?: Partial<RateLimitConfig>;
  idempotency?: Partial<IdempotencyConfig>;
}

export interface PolicyContext {
  provider: string;
  endpoint: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}

export type PolicyDecision =
  | { allow: false; reason: string }
  | {
      allow: true;
      transform?: (
        ctx: PolicyContext,
      ) => Partial<Pick<PolicyContext, "body" | "query" | "headers">>;
    };

export interface Policy {
  name: string;
  evaluate(ctx: PolicyContext): PolicyDecision;
}

export interface ServiceConfig {
  providers: string[];
  strategy?:
    | "failover"
    | "round-robin"
    | "lowest-latency"
    | "cheapest"
    | "highest-success-rate"
    | "weighted"
    | "geo";
  failoverOn?: MeridianErrorCategory[];
  costs?: Record<string, number>;
  weights?: Record<string, number>;
  regions?: Record<string, string[]>;
  defaultRegion?: string;
}

export interface MeridianConfig {
  providers?: Record<string, ProviderConfig>;
  services?: Record<string, string[] | ServiceConfig>;
  defaults?: {
    retry?: Partial<RetryConfig>;
    circuitBreaker?: Partial<CircuitBreakerConfig>;
    rateLimit?: Partial<RateLimitConfig>;
    timeout?: number;
  };
  schemaValidation?: {
    enabled: boolean;
    storage: SchemaStorage;
    onDrift?: (drifts: SchemaDrift[]) => void;
    strictMode?: boolean;
  };
  observability?: ObservabilityAdapter | ObservabilityAdapter[];
  idempotency?: {
    defaultLevel: IdempotencyLevel;
    autoGenerateKeys?: boolean;
  };

  mode?: "local" | "distributed";

  stateStorage?: StateStorage;

  observabilitySanitizer?: {
    redactedKeys?: string[];
  };

  localUnsafe?: boolean;

  compliance?: {
    piiRedaction?: boolean | undefined;
    auditLog?: boolean | undefined;
    indiaMode?: boolean | undefined;
  };

  policies?: Policy[];

  providerCosts?: Record<string, number>;

  [providerName: string]: unknown;
}

// Hardcoded to avoid a runtime JSON import of package.json, which throws
// `ERR_IMPORT_ATTRIBUTE_MISSING` for consumers importing this ESM package on
// Node. Keep in sync with the "version" field in package.json on every release.
export const SDK_VERSION = "0.2.5";

export interface ProviderVersion {
  [provider: string]: string;
}
