import { parseRetryAfter } from "../../core/header-parser.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
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
} from "../../core/types.js";
import { MeridianError, SDK_VERSION } from "../../core/types.js";
import { HunterPaginationStrategy } from "./pagination.js";

/**
 * Hunter.io error response body. Errors are returned as an array regardless of
 * the failing endpoint:
 *
 *   { "errors": [ { "id": "wrong_params", "code": 400, "details": "..." } ] }
 */
interface HunterErrorBody {
  errors?: Array<{ id?: string; code?: number; details?: string }>;
  message?: string;
}

export class HunterAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.hunter.io/v2") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const url = new URL(endpoint.replace(/^\//, ""), `${effectiveBaseUrl}/`);

    // Hunter authenticates via the `api_key` query parameter on every request.
    url.searchParams.set("api_key", authToken.token);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        // Never let a caller-supplied query overwrite the auth key.
        if (key !== "api_key") url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const built: BuiltRequest = { url: url.toString(), method, headers };
    if (body !== undefined) built.body = body;
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(raw, "hunter", rateLimitInfo, paginationInfo, [], "1.0.0");
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
        return this.createError("network", true, "Network request failed.", {
          originalError: raw.message,
        });
      }
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>).status === "number"
    ) {
      return this.parseHttpError(
        raw as { status: number; headers?: Headers | Record<string, string>; body?: unknown },
      );
    }

    return this.createError("provider", false, "An unexpected error occurred.", { raw });
  }

  private parseHttpError(error: {
    status: number;
    headers?: Headers | Record<string, string>;
    body?: unknown;
  }): MeridianError {
    const { status, body, headers } = error;
    const errorBody = body as HunterErrorBody | undefined;

    let message = "";
    if (typeof body === "string") {
      message = body;
    } else if (errorBody?.errors?.length) {
      const first = errorBody.errors[0];
      message = first?.details ?? first?.id ?? "";
    } else if (errorBody?.message) {
      message = errorBody.message;
    }

    const meta = { hunterError: message };

    if (status === 401 || status === 403) {
      return this.createError(
        "auth",
        false,
        message || "Authentication failed. Check that your Hunter.io API key is valid.",
        meta,
        undefined,
        status,
      );
    }
    if (status === 404) {
      return this.createError("validation", false, message || "Not Found", meta, undefined, 404);
    }
    if (status === 422) {
      return this.createError(
        "validation",
        false,
        message || "Unprocessable Entity",
        meta,
        undefined,
        422,
      );
    }
    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createError(
        "rate_limit",
        true,
        message || "Rate limit exceeded.",
        { ...meta, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }
    if (status >= 500) {
      return this.createError(
        "provider",
        true,
        message || `Hunter.io API error ${status}`,
        meta,
        undefined,
        status,
      );
    }
    return this.createError(
      "validation",
      false,
      message || `Request failed with status ${status}`,
      meta,
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const key = config.apiKey ?? config.token;
    if (!key) {
      throw this.createError(
        "auth",
        false,
        "Hunter.io requires an API key. Set auth.apiKey to your Hunter API key.",
        {},
        undefined,
        401,
      );
    }
    return { token: key };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("X-RateLimit-Limit");
    const remainingStr = headers.get("X-RateLimit-Remaining");
    const resetStr = headers.get("X-RateLimit-Reset");

    let reset = new Date(Date.now() + 1000); // Hunter throttles per second.
    if (resetStr) {
      const resetNum = Number.parseInt(resetStr, 10);
      if (!Number.isNaN(resetNum)) {
        // Reset may be an absolute epoch (seconds) or a delta (seconds).
        reset =
          resetNum > 1_000_000_000
            ? new Date(resetNum * 1000)
            : new Date(Date.now() + resetNum * 1000);
      }
    }

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);
      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        return { limit, remaining, reset };
      }
    }
    return { limit: 15, remaining: 15, reset };
  }

  paginationStrategy(): PaginationStrategy {
    return new HunterPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map(),
    };
  }

  private createError(
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
      "hunter",
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
        ? headers.get("Retry-After")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);
    return parseRetryAfter(value) ?? undefined;
  }
}
