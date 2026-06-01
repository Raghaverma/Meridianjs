import { ResponseNormalizer } from "../core/normalizer.js";
import type {
  AdapterInput,
  AuthConfig,
  AuthToken,
  BuiltRequest,
  IdempotencyConfig,
  NormalizedResponse,
  PaginationStrategy,
  ProviderAdapter,
  RateLimitInfo,
  RawResponse,
  RequestOptions,
} from "../core/types.js";
import { MeridianError } from "../core/types.js";

export interface MockCall {
  method: string;
  endpoint: string;
  options: RequestOptions;
  timestamp: Date;
}

export interface MockHandler {
  method?: string;
  endpoint?: string | RegExp;
  handler: (
    method: string,
    endpoint: string,
    options: RequestOptions,
  ) => MockResponse | Promise<MockResponse>;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export class MockAdapter implements ProviderAdapter {
  readonly calls: MockCall[] = [];
  private handlers: MockHandler[] = [];
  private delayMs = 0;
  private providerName: string;

  constructor(providerName = "mock") {
    this.providerName = providerName;
  }

  /** Register a handler for requests matching the given pattern. Later registrations take precedence. */
  onRequest(
    pattern: { method?: string; endpoint?: string | RegExp },
    handler: MockHandler["handler"],
  ): this {
    this.handlers.unshift({ ...pattern, handler });
    return this;
  }

  /** Make requests matching the pattern throw a MeridianError. */
  simulateError(
    pattern: { method?: string; endpoint?: string | RegExp },
    error: {
      message: string;
      category?: MeridianError["category"];
      status?: number;
      retryable?: boolean;
    },
  ): this {
    this.handlers.unshift({
      ...pattern,
      handler: () => {
        throw new MeridianError(
          error.message,
          error.category ?? "provider",
          this.providerName,
          error.retryable ?? false,
          "",
          undefined,
          undefined,
          error.status,
        );
      },
    });
    return this;
  }

  /** Add artificial delay to all responses (useful for testing timeouts). */
  simulateDelay(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  /** Clear recorded calls and registered handlers. */
  reset(): this {
    this.calls.length = 0;
    this.handlers.length = 0;
    this.delayMs = 0;
    return this;
  }

  baseUrl?: string;

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken } = input;
    const base = input.baseUrl ?? this.baseUrl ?? "https://mock.meridian.local";
    const url = new URL(endpoint, base);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, String(v));
    }
    return {
      url: url.toString(),
      method: options.method ?? "GET",
      headers: { Authorization: `Bearer ${authToken.token}`, ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
    };
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(
      raw,
      this.providerName,
      { limit: 1000, remaining: 999, reset: new Date(Date.now() + 60_000) },
      paginationInfo,
      [],
      "1.0.0",
    );
  }

  parseError(raw: unknown): MeridianError {
    if (raw instanceof MeridianError) return raw;
    if (raw instanceof Error)
      return new MeridianError(raw.message, "provider", this.providerName, false);
    return new MeridianError(String(raw), "provider", this.providerName, false);
  }

  async authStrategy(_config: AuthConfig): Promise<AuthToken> {
    return { token: "mock-token" };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    return { limit: 1000, remaining: 999, reset: new Date(Date.now() + 60_000) };
  }

  paginationStrategy(): PaginationStrategy {
    return {
      extractCursor: () => null,
      extractTotal: () => null,
      hasNext: () => false,
      buildNextRequest: (endpoint, options) => ({ endpoint, options }),
    };
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map(),
    };
  }

  /**
   * Internal: resolve a mock response. Called by the test harness — not part of ProviderAdapter.
   * Exposed so tests can simulate the pipeline response without spinning up a real HTTP server.
   */
  async resolve(method: string, endpoint: string, options: RequestOptions): Promise<RawResponse> {
    this.calls.push({ method, endpoint, options, timestamp: new Date() });

    if (this.delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, this.delayMs));
    }

    for (const h of this.handlers) {
      const methodMatch = !h.method || h.method.toUpperCase() === method.toUpperCase();
      const endpointMatch =
        !h.endpoint ||
        (h.endpoint instanceof RegExp ? h.endpoint.test(endpoint) : h.endpoint === endpoint);
      if (methodMatch && endpointMatch) {
        const mockRes = await h.handler(method, endpoint, options);
        return this.toRawResponse(mockRes);
      }
    }

    return this.toRawResponse({ status: 200, body: { mock: true, provider: this.providerName } });
  }

  private toRawResponse(mock: MockResponse): RawResponse {
    const headers = new Headers(mock.headers ?? { "content-type": "application/json" });
    return { status: mock.status ?? 200, headers, body: mock.body ?? {} };
  }
}
