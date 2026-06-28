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
import { OpenAIPaginationStrategy } from "./pagination.js";

interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// OpenAI encodes rate limit reset as a duration string: "6m0s", "1s", "2h30m", "500ms"
function parseOpenAIDuration(duration: string): number {
  let totalMs = 0;
  const hoursMatch = /(\d+)h/.exec(duration);
  const minutesMatch = /(\d+)m(?!s)/.exec(duration);
  const secondsMatch = /(\d+)s/.exec(duration);
  const msMatch = /(\d+)ms/.exec(duration);

  if (hoursMatch?.[1] !== undefined) totalMs += Number.parseInt(hoursMatch[1], 10) * 3_600_000;
  if (minutesMatch?.[1] !== undefined) totalMs += Number.parseInt(minutesMatch[1], 10) * 60_000;
  if (secondsMatch?.[1] !== undefined) totalMs += Number.parseInt(secondsMatch[1], 10) * 1_000;
  if (msMatch?.[1] !== undefined) totalMs += Number.parseInt(msMatch[1], 10);

  return totalMs;
}

export class OpenAIAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.openai.com") {
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
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    if (authToken.token) {
      headers.Authorization = `Bearer ${authToken.token}`;
    }

    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
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
    return ResponseNormalizer.normalize(raw, "openai", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as OpenAIErrorBody | undefined;
    const errorMessage = errorBody?.error?.message;
    const errorCode = errorBody?.error?.code;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your OpenAI API key.",
        { openaiError: errorBody?.error },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your API key lacks the required permissions.",
        { openaiError: errorBody?.error },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { openaiError: errorBody?.error },
        undefined,
        404,
      );
    }

    if (status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { openaiError: errorBody?.error },
        undefined,
        422,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      // insufficient_quota means billing limit hit — retrying won't help
      const isQuotaExhausted = errorCode === "insufficient_quota";
      return this.createMeridianError(
        "rate_limit",
        !isQuotaExhausted,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { openaiError: errorBody?.error, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `OpenAI API returned error ${status}. This may be temporary.`,
        { status, openaiError: errorBody?.error },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, openaiError: errorBody?.error },
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
        "OpenAI authentication requires an API key. Set auth.token to your OpenAI API key.",
        {},
        undefined,
        401,
      );
    }
    return { token: config.token };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("x-ratelimit-limit-requests");
    const remainingStr = headers.get("x-ratelimit-remaining-requests");
    const resetStr = headers.get("x-ratelimit-reset-requests");

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);

      let reset = new Date(Date.now() + 60 * 1000);
      if (resetStr) {
        const durationMs = parseOpenAIDuration(resetStr);
        if (durationMs > 0) {
          reset = new Date(Date.now() + durationMs);
        }
      }

      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        return { limit, remaining, reset };
      }
    }

    return {
      limit: 3_500,
      remaining: 3_500,
      reset: new Date(Date.now() + 60 * 1000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new OpenAIPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /v1/chat/completions", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/completions", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/embeddings", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/images/generations", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/audio/transcriptions", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/audio/speech", IdempotencyLevel.CONDITIONAL],
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
      "openai",
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
