
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
import { RazorpayPaginationStrategy } from "./pagination.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
import { parseRetryAfter } from "../../core/header-parser.js";


interface RazorpayErrorBody {
  error: {
    code: string;
    description: string;
    source?: string;
    step?: string;
    reason?: string;
    field?: string | null;
    metadata?: Record<string, unknown>;
  };
}


export class RazorpayAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = "https://api.razorpay.com") {
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

    // Razorpay uses HTTP Basic auth: key_id as username, key_secret as password
    // authToken.token is encoded as "key_id:key_secret"
    const credentials = Buffer.from(authToken.token).toString("base64");

    const headers: Record<string, string> = {
      "Authorization": `Basic ${credentials}`,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

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
    return ResponseNormalizer.normalize(raw, "razorpay", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as RazorpayErrorBody | undefined;
    const errorCode = errorBody?.error?.code;
    const errorDescription = errorBody?.error?.description;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorDescription ?? "Authentication failed. Check your Razorpay key_id and key_secret.",
        { razorpayCode: errorCode, razorpayError: errorBody?.error },
        undefined,
        401
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorDescription ?? "Permission denied. Your API key lacks the required permissions.",
        { razorpayCode: errorCode, razorpayError: errorBody?.error },
        undefined,
        403
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorDescription ?? "Resource not found.",
        { razorpayCode: errorCode, razorpayError: errorBody?.error },
        undefined,
        404
      );
    }

    if (status === 409) {
      return this.createMeridianError(
        "validation",
        false,
        errorDescription ?? "Request conflicts with existing resource.",
        { razorpayCode: errorCode, razorpayError: errorBody?.error },
        undefined,
        409
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorDescription ?? "Rate limit exceeded. Please wait before retrying.",
        { razorpayCode: errorCode, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorDescription ?? "Request validation failed.",
        { razorpayCode: errorCode, razorpayError: errorBody?.error },
        undefined,
        status
      );
    }

    // Gateway and server errors — safe to retry
    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorDescription ?? `Razorpay API returned error ${status}. This may be temporary.`,
        { status, razorpayCode: errorCode },
        undefined,
        status
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorDescription ?? `Request failed with status ${status}.`,
        { status, razorpayCode: errorCode },
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
    // Support two patterns:
    //   1. username = key_id, password = key_secret
    //   2. apiKey = key_id, custom.keySecret = key_secret
    const keyId = config.username ?? config.apiKey;
    const keySecret = config.password ?? config.custom?.["keySecret"];

    if (!keyId || !keySecret) {
      throw this.createMeridianError(
        "auth",
        false,
        "Razorpay authentication requires a key_id and key_secret. " +
          "Set auth.username + auth.password, or auth.apiKey + auth.custom.keySecret.",
        {},
        undefined,
        401
      );
    }

    // Encode as "key_id:key_secret" for Basic auth in buildRequest
    return { token: `${keyId}:${keySecret}` };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    // Razorpay does not publish rate-limit headers; return conservative defaults
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
      limit: 200,
      remaining: 200,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new RazorpayPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /v1/orders", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/payments/:id/capture", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/refunds", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/transfers", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/payouts", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/subscriptions", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/invoices", IdempotencyLevel.CONDITIONAL],
        ["PATCH /v1/orders/:id", IdempotencyLevel.IDEMPOTENT],
      ]),
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
    return new MeridianError(message, category, "razorpay", retryable, "", metadata, retryAfter, status);
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
