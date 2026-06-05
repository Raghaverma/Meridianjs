import { randomUUID } from "node:crypto";
import type { ProviderCircuitBreaker } from "../strategies/circuit-breaker.js";
import type { IdempotencyResolver } from "../strategies/idempotency.js";
import type { RateLimiter } from "../strategies/rate-limit.js";
import type { RetryStrategy } from "../strategies/retry.js";
import { sanitizeMeridianError } from "./error-sanitizer.js";
import { sanitizeMetric, sanitizeObject } from "./observability-sanitizer.js";
import { sanitizeRequestOptions } from "./request-sanitizer.js";
import type {
  ErrorContext,
  NormalizedResponse,
  ObservabilityAdapter,
  Policy,
  PolicyContext,
  ProviderAdapter,
  RawResponse,
  RequestContext,
  RequestOptions,
  ResponseContext,
} from "./types.js";
import { MeridianError } from "./types.js";

import type { AuthConfig, AuthToken } from "./types.js";

export interface PipelineConfig {
  provider: string;
  adapter: ProviderAdapter;
  authConfig: AuthConfig;
  circuitBreaker: ProviderCircuitBreaker;
  rateLimiter: RateLimiter;
  retryStrategy: RetryStrategy;
  idempotencyResolver: IdempotencyResolver;
  observability: ObservabilityAdapter[];
  timeout: number | undefined;
  autoGenerateIdempotencyKeys?: boolean;
  sanitizerOptions?:
    | {
        redactedKeys?: string[];
        piiRedaction?: boolean | undefined;
        indiaMode?: boolean | undefined;
      }
    | undefined;
  compliance?:
    | {
        piiRedaction?: boolean | undefined;
        auditLog?: boolean | undefined;
        indiaMode?: boolean | undefined;
      }
    | undefined;
  onRawRequest?: (
    requestId: string,
    endpoint: string,
    method: string,
    options: RequestOptions,
  ) => void;
  policies?: Policy[];
}

export class RequestPipeline {
  private config: PipelineConfig;
  private cachedToken: AuthToken | null = null;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  private async getAuthToken(): Promise<AuthToken> {
    if (this.cachedToken) {
      if (this.cachedToken.expiresAt) {
        const bufferMs = 60_000;
        if (this.cachedToken.expiresAt.getTime() - bufferMs > Date.now()) {
          return this.cachedToken;
        }
        // Token expired or about to expire — fall through to re-fetch
      } else {
        // No expiry = static API key — cache forever
        return this.cachedToken;
      }
    }
    const token = await this.config.adapter.authStrategy(this.config.authConfig);
    this.cachedToken = token;
    return token;
  }

  private safelyBroadcastObservability(
    action: (adapter: ObservabilityAdapter) => void,
    actionName: string,
  ): void {
    const errors: Array<{ adapter: string; error: unknown }> = [];

    for (const obs of this.config.observability) {
      try {
        action(obs);
      } catch (error) {
        errors.push({
          adapter: obs.constructor?.name || "UnknownObservabilityAdapter",
          error,
        });
      }
    }

    if (errors.length > 0) {
      const errorSummary = errors
        .map(
          ({ adapter, error }) =>
            `  - ${adapter}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("\n");

      console.error(
        `[Meridian] Observability failure in ${actionName} (${errors.length}/${this.config.observability.length} adapters failed):\n${errorSummary}`,
      );
    }
  }

  async execute<T>(endpoint: string, options: RequestOptions = {}): Promise<NormalizedResponse<T>> {
    const requestId = randomUUID();
    const method = options.method ?? "GET";
    const startTime = Date.now();

    if (this.config.autoGenerateIdempotencyKeys && !options.idempotencyKey) {
      options.idempotencyKey = randomUUID();
    }

    const idempotencyLevel = this.config.idempotencyResolver.getIdempotencyLevel(
      method,
      endpoint,
      options,
    );

    const identity = options.identity;

    this.config.onRawRequest?.(requestId, endpoint, method, options);

    if (this.config.policies?.length) {
      let ctx: PolicyContext = { provider: this.config.provider, endpoint, method };
      if (options.body !== undefined) (ctx as { body?: unknown }).body = options.body;
      if (options.headers !== undefined)
        (ctx as { headers?: Record<string, string> }).headers = options.headers;
      if (options.query !== undefined)
        (ctx as { query?: Record<string, string | number | boolean> }).query = options.query;
      for (const policy of this.config.policies) {
        const decision = policy.evaluate(ctx);
        if (!decision.allow) {
          throw new MeridianError(
            `Policy "${policy.name}" blocked request: ${decision.reason}`,
            "validation",
            this.config.provider,
            false,
            requestId,
          );
        }
        if (decision.transform !== undefined) {
          const patch = decision.transform(ctx);
          const updated = { ...options };
          if (patch.body !== undefined) {
            updated.body = patch.body;
            ctx = { ...ctx, body: patch.body };
          }
          if (patch.query !== undefined) {
            updated.query = patch.query;
            ctx = { ...ctx, query: patch.query };
          }
          if (patch.headers !== undefined) {
            updated.headers = patch.headers;
            ctx = { ...ctx, headers: patch.headers };
          }
          Object.assign(options, updated);
        }
      }
    }

    const sanitizerOpts = {
      ...this.config.sanitizerOptions,
      piiRedaction:
        this.config.compliance?.piiRedaction || this.config.sanitizerOptions?.piiRedaction,
      indiaMode: this.config.compliance?.indiaMode || this.config.sanitizerOptions?.indiaMode,
    };

    const sanitizedOptions = sanitizeRequestOptions(options, sanitizerOpts);

    const requestContext: RequestContext = {
      provider: this.config.provider,
      endpoint,
      method,
      requestId,
      timestamp: new Date(),
      options: sanitizedOptions,
      identity,
    };

    this.safelyBroadcastObservability((obs) => obs.logRequest(requestContext), "logRequest");

    try {
      await this.getAuthToken(); // warm the cache before acquiring the rate limiter

      await this.config.rateLimiter.acquire();

      let retryCount = 0;
      const response = await this.config.retryStrategy.execute(
        async () => {
          retryCount++;
          return await this.config.circuitBreaker.execute(async () => {
            try {
              return await this.executeHttpRequest(endpoint, options, await this.getAuthToken());
            } catch (err) {
              // On 401, attempt a one-shot token refresh if the adapter supports it
              if (
                typeof err === "object" &&
                err !== null &&
                "status" in err &&
                (err as { status: number }).status === 401 &&
                typeof (this.config.adapter as { refreshAuth?: unknown }).refreshAuth === "function"
              ) {
                const currentToken = this.cachedToken;
                if (currentToken) {
                  const refreshed = await (
                    this.config.adapter as Required<Pick<ProviderAdapter, "refreshAuth">>
                  ).refreshAuth(this.config.authConfig, currentToken);
                  this.cachedToken = refreshed;
                  return await this.executeHttpRequest(endpoint, options, refreshed);
                }
              }
              throw err;
            }
          });
        },
        idempotencyLevel,
        !!options.idempotencyKey,
      );

      const rateLimitInfo = this.config.adapter.rateLimitPolicy(response.headers);
      this.config.rateLimiter.updateFromHeaders(response.headers, rateLimitInfo);

      const normalized = this.config.adapter.parseResponse(response);

      normalized.meta.requestId = requestId;

      const duration = Date.now() - startTime;

      normalized.meta.trace = {
        retries: retryCount - 1,
        latency: duration,
        circuitBreaker: this.config.circuitBreaker.getStatus().state,
        rateLimitRemaining: rateLimitInfo.remaining,
      };

      const responseContext: ResponseContext = {
        provider: this.config.provider,
        endpoint,
        method,
        requestId,
        statusCode: response.status,
        duration,
        timestamp: new Date(),
        identity,
        trace: normalized.meta.trace,
      };

      this.safelyBroadcastObservability((obs) => obs.logResponse(responseContext), "logResponse");

      this.safelyBroadcastObservability(
        (obs) =>
          obs.recordMetric(
            sanitizeMetric(
              {
                name: "meridian.request.count",
                value: 1,
                tags: {
                  provider: this.config.provider,
                  endpoint,
                  status: String(response.status),
                },
                timestamp: new Date(),
              },
              this.config.sanitizerOptions,
            ),
          ),
        "recordMetric:request.count",
      );

      this.safelyBroadcastObservability(
        (obs) =>
          obs.recordMetric(
            sanitizeMetric(
              {
                name: "meridian.request.duration",
                value: duration,
                tags: {
                  provider: this.config.provider,
                  endpoint,
                },
                timestamp: new Date(),
              },
              this.config.sanitizerOptions,
            ),
          ),
        "recordMetric:request.duration",
      );

      return normalized as NormalizedResponse<T>;
    } catch (error) {
      const duration = Date.now() - startTime;

      let meridianError: MeridianError;
      try {
        const adapterError = this.config.adapter.parseError(error);

        meridianError = sanitizeMeridianError(adapterError, this.config.provider, requestId);
      } catch (parseError) {
        meridianError = sanitizeMeridianError(
          {
            message: error instanceof Error ? error.message : String(error),
            metadata: {
              originalError: error instanceof Error ? error.message : error,
              parseError: parseError instanceof Error ? parseError.message : parseError,
            },
          },
          this.config.provider,
          requestId,
        );
      }

      if (meridianError.category === "rate_limit" && meridianError.retryAfter) {
        this.config.rateLimiter.handle429(
          Math.floor((meridianError.retryAfter.getTime() - Date.now()) / 1000),
        );
      }

      let errorContext: ErrorContext = {
        provider: this.config.provider,
        endpoint,
        method,
        requestId,
        error: meridianError,
        duration,
        timestamp: new Date(),
        identity,
      };

      try {
        const sanitizedError = { ...meridianError } as any;
        if (sanitizedError.metadata) {
          sanitizedError.metadata = sanitizeObject(
            sanitizedError.metadata,
            this.config.sanitizerOptions,
          ) as Record<string, unknown>;
        }
        errorContext = { ...errorContext, error: sanitizedError };
      } catch {}

      this.safelyBroadcastObservability((obs) => obs.logError(errorContext), "logError");

      this.safelyBroadcastObservability(
        (obs) =>
          obs.recordMetric(
            sanitizeMetric(
              {
                name: "meridian.request.error",
                value: 1,
                tags: {
                  provider: this.config.provider,
                  endpoint,
                  errorCategory: meridianError.category,
                },
                timestamp: new Date(),
              },
              this.config.sanitizerOptions,
            ),
          ),
        "recordMetric:request.error",
      );

      throw meridianError;
    }
  }

  private async executeHttpRequest(
    endpoint: string,
    options: RequestOptions,
    authToken: AuthToken,
  ): Promise<RawResponse> {
    const timeout = this.config.timeout ?? 30000;

    const builtRequest = this.config.adapter.buildRequest({
      endpoint,
      options,
      authToken,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method: builtRequest.method,
      headers: builtRequest.headers,
      signal: controller.signal,
    };
    if (builtRequest.body !== undefined) {
      fetchOptions.body = builtRequest.body;
    }

    try {
      const response = await fetch(builtRequest.url, fetchOptions);

      let body: unknown;
      try {
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          body = await response.json();
        } else {
          body = await response.text();
        }
      } catch {
        body = {};
      }

      const headersMap = new Headers();
      response.headers.forEach((value, key) => {
        headersMap.set(key, value);
      });

      if (!response.ok) {
        throw {
          status: response.status,
          headers: headersMap,
          body,
        };
      }

      return {
        status: response.status,
        headers: headersMap,
        body,
      } as RawResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new MeridianError(
          `Request timeout after ${timeout}ms`,
          "network",
          this.config.provider,
          true,
          "",
          {
            timeout,
            url: builtRequest.url,
            method: builtRequest.method,
          },
          undefined,
          undefined,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
