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
import { type IdempotencyLevel, MeridianError, SDK_VERSION } from "../../../core/types.js";
import { DatadogPaginationStrategy } from "./pagination.js";

interface DatadogErrorBody {
  errors?: string[];
}

/**
 * Datadog's API authenticates every request with a pair of headers —
 * `DD-API-KEY` (account-level) and `DD-APPLICATION-KEY` (user-level, required
 * for most read endpoints) — rather than a bearer token. Rate limits surface
 * via `X-RateLimit-Limit` / `-Remaining` / `-Reset` / `-Period` headers, and
 * v2 search APIs paginate with a `meta.page.after` cursor.
 */
export class DatadogAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.datadoghq.com/api/") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;
    const url = new URL(endpoint.replace(/^\//, ""), effectiveBaseUrl);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const [apiKey, appKey] = authToken.token.split("|DD|");

    const headers: Record<string, string> = {
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };
    if (apiKey) headers["DD-API-KEY"] = apiKey;
    if (appKey) headers["DD-APPLICATION-KEY"] = appKey;

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const built: BuiltRequest = { url: url.toString(), method, headers };
    if (body !== undefined) {
      built.body = body;
    }
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(raw, "datadog", rateLimitInfo, paginationInfo, [], "1.0.0");
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
      return this.parseHttpError(
        raw as { status: number; headers?: Headers | Record<string, string>; body?: unknown },
      );
    }

    return this.createMeridianError("provider", false, "An unexpected error occurred", { raw });
  }

  private parseHttpError(error: {
    status: number;
    headers?: Headers | Record<string, string>;
    body?: unknown;
  }): MeridianError {
    const { status, body, headers } = error;
    const errorBody = body as DatadogErrorBody | undefined;
    const errorMessage = errorBody?.errors?.join("; ");

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your Datadog API key.",
        { datadogErrors: errorBody?.errors },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ??
          "Permission denied. Check that your Application key has the required scopes.",
        { datadogErrors: errorBody?.errors },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { datadogErrors: errorBody?.errors },
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
        { retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { datadogErrors: errorBody?.errors },
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `Datadog API returned error ${status}. This may be temporary.`,
        { status },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status },
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
    const apiKey = config.apiKey ?? config.username;
    const appKey = config.clientSecret ?? config.apiSecret ?? config.password;

    if (!apiKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "Datadog authentication requires an API key. Set auth.apiKey (account API key), " +
          "and optionally auth.apiSecret/auth.clientSecret (Application key) for read endpoints.",
        {},
        undefined,
        401,
      );
    }

    return { token: appKey ? `${apiKey}|DD|${appKey}` : apiKey };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limit = headers.get("X-RateLimit-Limit");
    const remaining = headers.get("X-RateLimit-Remaining");
    const reset = headers.get("X-RateLimit-Reset");

    return {
      limit: limit ? Number.parseInt(limit, 10) : 100,
      remaining: remaining ? Number.parseInt(remaining, 10) : 100,
      reset: reset
        ? new Date(Date.now() + Number.parseInt(reset, 10) * 1000)
        : new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new DatadogPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  /**
   * Verifies a Datadog webhook signature: an HMAC-SHA256 digest of the raw
   * request body, hex-encoded, sent in the `X-Datadog-Signature` header and
   * keyed by the webhook's shared secret.
   */
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
      "datadog",
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
