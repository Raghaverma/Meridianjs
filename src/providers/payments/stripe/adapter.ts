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
import { StripePaginationStrategy } from "./pagination.js";

interface StripeErrorBody {
  error: {
    type: string;
    code?: string;
    decline_code?: string;
    message: string;
    param?: string;
  };
}

export class StripeAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.stripe.com") {
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

    // Stripe uses HTTP Basic auth: API key as username, empty password
    const credentials = Buffer.from(`${authToken.token}:`).toString("base64");

    const headers: Record<string, string> = {
      Authorization: `Basic ${credentials}`,
      "Stripe-Version": "2024-11-20.acacia",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    // Stripe has native idempotency key support on all write operations
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      // Stripe accepts application/x-www-form-urlencoded for most endpoints,
      // but JSON is supported with the header set
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
    return ResponseNormalizer.normalize(raw, "stripe", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as StripeErrorBody | undefined;
    const errorMessage = errorBody?.error?.message;
    const errorType = errorBody?.error?.type;
    const declineCode = errorBody?.error?.decline_code;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your Stripe API key.",
        { stripeError: errorBody?.error },
        undefined,
        401,
      );
    }

    if (status === 402) {
      // Card errors — payment declined
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Payment was declined.",
        { stripeError: errorBody?.error, declineCode },
        undefined,
        402,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your API key lacks the required permissions.",
        { stripeError: errorBody?.error },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { stripeError: errorBody?.error },
        undefined,
        404,
      );
    }

    if (status === 409) {
      // Idempotency key was reused with different request parameters
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Idempotency key reused with different parameters.",
        { stripeError: errorBody?.error, errorType },
        undefined,
        409,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { stripeError: errorBody?.error, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { stripeError: errorBody?.error },
        undefined,
        422,
      );
    }

    // 500, 502, 503, 504 — Stripe infrastructure errors, safe to retry
    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `Stripe API returned error ${status}. This may be temporary.`,
        { status, stripeError: errorBody?.error },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, stripeError: errorBody?.error },
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
    const key = config.apiKey ?? config.token;
    if (!key) {
      throw this.createMeridianError(
        "auth",
        false,
        "Stripe authentication requires an API key. Set auth.apiKey or auth.token to your Stripe secret key.",
        {},
        undefined,
        401,
      );
    }
    return { token: key };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    // Stripe exposes these headers when rate limit info is available
    const limitStr = headers.get("Stripe-Ratelimit-Limit");
    const remainingStr = headers.get("Stripe-Ratelimit-Remaining");

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);

      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        return {
          limit,
          remaining,
          reset: new Date(Date.now() + 1000), // Stripe resets per second
        };
      }
    }

    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 1000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new StripePaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        // All Stripe write operations support idempotency keys
        ["POST /v1/charges", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/payment_intents", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/payment_intents/:id/confirm", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/customers", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/subscriptions", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/invoices", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/refunds", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/payouts", IdempotencyLevel.CONDITIONAL],
        ["POST /v1/transfers", IdempotencyLevel.CONDITIONAL],
        ["DELETE /v1/customers/:id", IdempotencyLevel.IDEMPOTENT],
        ["DELETE /v1/subscriptions/:id", IdempotencyLevel.IDEMPOTENT],
      ]),
    };
  }

  /**
   * Verify a Stripe webhook signature.
   *
   * @param toleranceSeconds Maximum age (in seconds) of the signed timestamp that
   *   is still accepted, matching Stripe's own SDK default of 300s. This guards
   *   against replay attacks: without it, a single captured `t=...,v1=...` header
   *   stays valid forever because the timestamp is signed but never compared to
   *   now. Pass `Infinity` to disable the freshness check (not recommended).
   */
  verifyWebhook(
    payload: string | Buffer,
    signature: string,
    secret: string,
    toleranceSeconds = 300,
  ): boolean {
    try {
      // Detect Stripe-Signature header format: "t=<timestamp>,v1=<hex>[,v0=<hex>]"
      let sigHex = signature;
      let signingPayload: string | Buffer = payload;

      if (signature.includes("v1=")) {
        const parts: Record<string, string> = {};
        for (const part of signature.split(",")) {
          const eqIdx = part.indexOf("=");
          if (eqIdx !== -1) {
            parts[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
          }
        }
        const v1 = parts.v1;
        const t = parts.t;
        if (!v1) return false;
        sigHex = v1;
        // Stripe signs "${timestamp}.${rawPayload}" when a timestamp is present
        if (t) {
          // Reject stale/forged timestamps before doing the HMAC compare so a
          // replayed event cannot be accepted on signature alone.
          if (Number.isFinite(toleranceSeconds)) {
            const ts = Number.parseInt(t, 10);
            if (!Number.isFinite(ts)) return false;
            const ageSeconds = Math.abs(Date.now() / 1000 - ts);
            if (ageSeconds > toleranceSeconds) return false;
          }
          const payloadStr = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
          signingPayload = `${t}.${payloadStr}`;
        }
      }

      const expected = createHmac("sha256", secret).update(signingPayload).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(sigHex);
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
      "stripe",
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
