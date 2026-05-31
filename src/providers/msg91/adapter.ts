
import type {
  ProviderAdapter,
  AuthConfig,
  AuthToken,
  RawResponse,
  NormalizedResponse,
  RateLimitInfo,
  PaginationStrategy,
  IdempotencyConfig,
  AdapterInput,
  BuiltRequest,
} from "../../core/types.js";
import { MeridianError, IdempotencyLevel, SDK_VERSION } from "../../core/types.js";
import { Msg91PaginationStrategy } from "./pagination.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
import { parseRetryAfter } from "../../core/header-parser.js";


interface Msg91ErrorBody {
  message?: string;
  type?: string;
  status?: string;
}


export class Msg91Adapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = "https://api.msg91.com") {
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
      "authkey": authToken.token,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

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
    return ResponseNormalizer.normalize(raw, "msg91", rateLimitInfo, paginationInfo, [], "1.0.0");
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
          { originalError: raw.message }
        );
      }
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>)["status"] === "number"
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
    const errorBody = body as Msg91ErrorBody | undefined;
    const errorMessage = errorBody?.message;
    const errorType = errorBody?.type ?? errorBody?.status;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your MSG91 auth key.",
        { msg91Type: errorType },
        undefined,
        401
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your auth key lacks the required permissions.",
        { msg91Type: errorType },
        undefined,
        403
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { msg91Type: errorType },
        undefined,
        404
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { msg91Type: errorType, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { msg91Type: errorType },
        undefined,
        status
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `MSG91 API returned error ${status}. This may be temporary.`,
        { status, msg91Type: errorType },
        undefined,
        status
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, msg91Type: errorType },
        undefined,
        status
      );
    }

    return this.createMeridianError(
      "provider",
      false,
      `Unexpected response status ${status}.`,
      { status },
      undefined,
      status
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const apiKey = config.apiKey;

    if (!apiKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "MSG91 authentication requires an auth key. Set auth.apiKey.",
        {},
        undefined,
        401
      );
    }

    return { token: apiKey };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("X-RateLimit-Limit");
    const remainingStr = headers.get("X-RateLimit-Remaining");
    const resetStr = headers.get("X-RateLimit-Reset");

    if (limitStr && remainingStr) {
      const limit = parseInt(limitStr, 10);
      const remaining = parseInt(remainingStr, 10);

      if (!isNaN(limit) && !isNaN(remaining)) {
        const reset = resetStr
          ? new Date(parseInt(resetStr, 10) * 1000)
          : new Date(Date.now() + 60_000);
        return { limit, remaining, reset };
      }
    }

    return {
      limit: 1000,
      remaining: 1000,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new Msg91PaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  private createMeridianError(
    category: MeridianError["category"],
    retryable: boolean,
    message: string,
    metadata?: Record<string, unknown>,
    retryAfter?: Date,
    status?: number
  ): MeridianError {
    return new MeridianError(message, category, "msg91", retryable, "", metadata, retryAfter, status);
  }

  private extractRetryAfter(
    headers: Headers | Record<string, string> | undefined
  ): Date | undefined {
    if (!headers) return undefined;

    const value =
      headers instanceof Headers
        ? headers.get("retry-after")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);

    return parseRetryAfter(value) ?? undefined;
  }
}
