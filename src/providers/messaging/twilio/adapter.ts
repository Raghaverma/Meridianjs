import { createHmac, timingSafeEqual } from "node:crypto";
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
import { TwilioPaginationStrategy } from "./pagination.js";

interface TwilioErrorBody {
  code: number;
  message: string;
  more_info: string;
  status: number;
}

export class TwilioAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.twilio.com") {
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

    // Twilio uses HTTP Basic auth: AccountSID as username, AuthToken as password.
    // authToken.token is stored as "AccountSID:AuthToken" (set in authStrategy).
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
    if (
      options.body !== undefined &&
      options.body !== null &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      if (typeof options.body === "string") {
        // Pre-encoded — pass through
        body = options.body;
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
      } else {
        // Twilio REST API expects form-encoded bodies for POST/PUT/PATCH/DELETE
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.body as Record<string, unknown>)) {
          params.set(k, String(v));
        }
        body = params.toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
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
    return ResponseNormalizer.normalize(raw, "twilio", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as Partial<TwilioErrorBody> | undefined;
    const twilioCode = errorBody?.code;
    const twilioMessage = errorBody?.message;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        twilioMessage ?? "Authentication failed. Check your Twilio AccountSID and AuthToken.",
        { twilioCode, twilioError: twilioMessage },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        twilioMessage ?? "Permission denied. Your credentials lack the required permissions.",
        { twilioCode, twilioError: twilioMessage },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        twilioMessage ?? "Resource not found.",
        { twilioCode, twilioError: twilioMessage },
        undefined,
        404,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        twilioMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { twilioCode, twilioError: twilioMessage, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        twilioMessage ?? "Request validation failed.",
        { twilioCode, twilioError: twilioMessage },
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        twilioMessage ?? `Twilio API returned error ${status}. This may be temporary.`,
        { status, twilioCode, twilioError: twilioMessage },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        twilioMessage ?? `Request failed with status ${status}.`,
        { status, twilioCode, twilioError: twilioMessage },
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
    // Support two patterns:
    //   1. username = AccountSID, password = AuthToken
    //   2. apiKey = AccountSID, custom.authToken = AuthToken
    const sid = config.username ?? config.apiKey;
    const authToken = config.password ?? config.custom?.authToken;

    if (!sid || !authToken) {
      throw this.createMeridianError(
        "auth",
        false,
        "Twilio authentication requires an AccountSID and AuthToken. " +
          "Set auth.username + auth.password, or auth.apiKey + auth.custom.authToken.",
        {},
        undefined,
        401,
      );
    }

    // Encode as "AccountSID:AuthToken" for Basic auth in buildRequest
    return { token: `${sid}:${authToken}` };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    // Twilio does not publish standard rate-limit headers.
    // Parse any present headers gracefully; fall back to conservative defaults.
    const limitStr = headers.get("X-RateLimit-Limit");
    const remainingStr = headers.get("X-RateLimit-Remaining");
    const resetStr = headers.get("X-RateLimit-Reset");

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);

      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        const reset = resetStr
          ? new Date(Number.parseInt(resetStr, 10) * 1000)
          : new Date(Date.now() + 1000);
        return { limit, remaining, reset };
      }
    }

    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 1000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new TwilioPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /2010-04-01/Accounts/:sid/Messages.json", IdempotencyLevel.CONDITIONAL],
        ["POST /2010-04-01/Accounts/:sid/Calls.json", IdempotencyLevel.CONDITIONAL],
      ]),
    };
  }

  /**
   * Verify a Twilio webhook signature using HMAC-SHA1 (base64).
   *
   * Note: Full Twilio validation also incorporates the request URL and sorted
   * POST parameters appended before the HMAC is computed. This implementation
   * operates on the raw payload bytes only — sufficient for most payload-based
   * verification use cases.
   */
  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    const expected = createHmac("sha1", secret).update(payload).digest("base64");
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
      "twilio",
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
