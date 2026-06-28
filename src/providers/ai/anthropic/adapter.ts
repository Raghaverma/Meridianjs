import { parseRetryAfter } from "../../../core/header-parser.js";
import { ResponseNormalizer } from "../../../core/normalizer.js";
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
} from "../../../core/types.js";
import { IdempotencyLevel, MeridianError, SDK_VERSION } from "../../../core/types.js";
import { AnthropicPaginationStrategy } from "./pagination.js";

interface AnthropicErrorBody {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.anthropic.com") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const url = new URL(endpoint, effectiveBaseUrl);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    if (authToken.token) {
      headers["x-api-key"] = authToken.token;
    }

    if (options.idempotencyKey) {
      headers["X-Idempotency-Key"] = options.idempotencyKey;
    }

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const built: BuiltRequest = {
      url: url.toString(),
      method,
      headers,
    };
    if (body !== undefined) {
      built.body = body;
    }
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(
      raw,
      "anthropic",
      rateLimitInfo,
      paginationInfo,
      [],
      "1.0.0",
    );
  }

  parseError(raw: unknown): MeridianError {
    if (raw instanceof Error) {
      const msg = raw.message.toLowerCase();
      if (
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("enotfound") ||
        msg.includes("timeout")
      ) {
        return this.createMeridianError(
          "network",
          true,
          "Network request failed. Check your connection and try again.",
          { originalError: raw.message },
        );
      }
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>).status === "number"
    ) {
      const httpError = raw as {
        status: number;
        headers?: Headers | Record<string, string>;
        body?: unknown;
        message?: string;
      };
      return this.parseHttpError(httpError);
    }

    return this.createMeridianError("provider", false, "An unexpected error occurred", { raw });
  }

  private parseHttpError(error: {
    status: number;
    headers?: Headers | Record<string, string>;
    body?: unknown;
    message?: string;
  }): MeridianError {
    const { status, body, headers } = error;
    const errorBody = body as AnthropicErrorBody | undefined;
    const errorMessage = errorBody?.error?.message;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your Anthropic API key.",
        { anthropicError: errorBody?.error },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your API key lacks the required permissions.",
        { anthropicError: errorBody?.error },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { anthropicError: errorBody?.error },
        undefined,
        404,
      );
    }

    if (status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { anthropicError: errorBody?.error },
        undefined,
        422,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { anthropicError: errorBody?.error, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    // 529 = Anthropic's overloaded status
    if (status === 529) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? "Anthropic API is temporarily overloaded. Retrying with backoff.",
        { anthropicError: errorBody?.error },
        undefined,
        529,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `Anthropic API returned error ${status}. This may be temporary.`,
        { status, anthropicError: errorBody?.error },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, anthropicError: errorBody?.error },
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "provider",
      false,
      `Unexpected response status ${status}.`,
      { status },
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    if (!config.token) {
      throw this.createMeridianError(
        "auth",
        false,
        "Anthropic authentication requires an API key. Set auth.token to your Anthropic API key.",
        {},
        undefined,
        401,
      );
    }
    return { token: config.token };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limit = Number.parseInt(headers.get("anthropic-ratelimit-requests-limit") ?? "", 10);
    const remaining = Number.parseInt(
      headers.get("anthropic-ratelimit-requests-remaining") ?? "",
      10,
    );
    const resetStr = headers.get("anthropic-ratelimit-requests-reset");

    if (!Number.isNaN(limit) && !Number.isNaN(remaining) && resetStr) {
      const reset = new Date(resetStr);
      if (!Number.isNaN(reset.getTime())) {
        return { limit, remaining, reset };
      }
    }

    return {
      limit: 1000,
      remaining: 1000,
      reset: new Date(Date.now() + 60 * 1000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new AnthropicPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /v1/messages", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/messages/batches", IdempotencyLevel.CONDITIONAL],
      ]),
    };
  }

  private createMeridianError(
    category: MeridianError["category"],
    retryable: boolean,
    message: string,
    metadata?: Record<string, unknown>,
    retryAfter?: Date,
    status?: number,
  ): MeridianError {
    return new MeridianError(
      message,
      category,
      "anthropic",
      retryable,
      "",
      metadata,
      retryAfter,
      status,
    );
  }

  private extractRetryAfter(
    headers: Headers | Record<string, string> | undefined,
  ): Date | undefined {
    if (!headers) return undefined;

    const value =
      headers instanceof Headers
        ? headers.get("retry-after")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);

    return parseRetryAfter(value) ?? undefined;
  }
}
