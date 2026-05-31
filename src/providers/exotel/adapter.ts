import { createHmac, timingSafeEqual } from "node:crypto";
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
import { IdempotencyLevel, MeridianError, SDK_VERSION } from "../../core/types.js";
import { ExotelPaginationStrategy } from "./pagination.js";

interface ExotelErrorBody {
  RestException: {
    Code: string;
    Message: string;
    Status: number;
  };
}

export class ExotelAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.exotel.com") {
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

    // authToken.token is encoded as "SID:APIKey" — base64 for Basic auth
    const credentials = Buffer.from(authToken.token).toString("base64");

    const headers: Record<string, string> = {
      Authorization: `Basic ${credentials}`,
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
    return ResponseNormalizer.normalize(raw, "exotel", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as ExotelErrorBody | undefined;
    const exception = errorBody?.RestException;
    const errorMessage = exception?.Message;
    const errorCode = exception?.Code;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your Exotel SID and API key.",
        { exotelCode: errorCode },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your API credentials lack the required permissions.",
        { exotelCode: errorCode },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { exotelCode: errorCode },
        undefined,
        404,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { exotelCode: errorCode, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { exotelCode: errorCode },
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `Exotel API returned error ${status}. This may be temporary.`,
        { status, exotelCode: errorCode },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, exotelCode: errorCode },
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
    const sid = config.username;
    const apiKey = config.password;

    if (!sid || !apiKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "Exotel authentication requires a SID and API key. " +
          "Set auth.username (SID) + auth.password (API key).",
        {},
        undefined,
        401,
      );
    }

    return { token: `${sid}:${apiKey}` };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("X-RateLimit-Limit");
    const remainingStr = headers.get("X-RateLimit-Remaining");
    const resetStr = headers.get("X-RateLimit-Reset");

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);

      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        const reset = resetStr
          ? new Date(Number.parseInt(resetStr, 10) * 1000)
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
    return new ExotelPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /Calls", IdempotencyLevel.CONDITIONAL],
        ["POST /Sms", IdempotencyLevel.CONDITIONAL],
        ["POST /Calls/connect", IdempotencyLevel.CONDITIONAL],
      ]),
    };
  }

  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
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
      "exotel",
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
