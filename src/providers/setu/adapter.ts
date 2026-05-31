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
import { SetuPaginationStrategy } from "./pagination.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
import { parseRetryAfter } from "../../core/header-parser.js";

interface SetuErrorBody {
  status: number;
  success: boolean;
  error: {
    code: string;
    detail: string;
    traceId?: string;
  };
}

export class SetuAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = "https://prod.setu.co") {
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
      "Authorization": `Bearer ${authToken.token}`,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };
    // Inject optional Setu-specific headers from custom config stored in token metadata
    // We pass these through the AdapterInput options.headers channel — callers set them
    // via options.headers or via authToken extras encoded in the token as JSON.
    const tokenParts = authToken.token.split("|SETU|");
    if (tokenParts.length === 3) {
      if (tokenParts[1]) headers["x-client-id"] = tokenParts[1];
      if (tokenParts[2]) headers["x-product-instance-id"] = tokenParts[2];
    }
    if (options.idempotencyKey) {
      headers["x-idempotency-key"] = options.idempotencyKey;
    }
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
    return ResponseNormalizer.normalize(raw, "setu", rateLimitInfo, paginationInfo, [], "1.0.0");
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
        return this.createMeridianError("network", true, "Network request failed.", { originalError: raw.message });
      }
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>)["status"] === "number"
    ) {
      return this.parseHttpError(
        raw as { status: number; headers?: Headers | Record<string, string>; body?: unknown; message?: string }
      );
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
    const errorBody = body as SetuErrorBody | undefined;
    const errorCode = errorBody?.error?.code;
    const errorDetail = errorBody?.error?.detail;

    if (status === 401)
      return this.createMeridianError("auth", false, errorDetail ?? "Authentication failed.", { setuCode: errorCode }, undefined, 401);
    if (status === 403)
      return this.createMeridianError("auth", false, errorDetail ?? "Permission denied.", { setuCode: errorCode }, undefined, 403);
    if (status === 404)
      return this.createMeridianError("validation", false, errorDetail ?? "Resource not found.", { setuCode: errorCode }, undefined, 404);
    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError("rate_limit", true, "Rate limit exceeded.", { setuCode: errorCode }, retryAfter, 429);
    }
    if (status === 400 || status === 422)
      return this.createMeridianError("validation", false, errorDetail ?? "Validation failed.", { setuCode: errorCode }, undefined, status);
    if (status >= 500)
      return this.createMeridianError("provider", true, `Setu API returned error ${status}.`, { status }, undefined, status);
    if (status >= 400)
      return this.createMeridianError("validation", false, `Request failed with status ${status}.`, { status }, undefined, status);
    return this.createMeridianError("provider", false, `Unexpected response status ${status}.`, { status }, undefined, status);
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const token = config.token ?? config.apiKey;
    if (!token) throw this.createMeridianError("auth", false, "Requires token or apiKey.", {}, undefined, 401);
    const clientId = config.custom?.["clientId"] ?? "";
    const productInstanceId = config.custom?.["productInstanceId"] ?? "";
    // Encode extras into token string so buildRequest can extract them
    return { token: `${token}|SETU|${clientId}|SETU|${productInstanceId}`.replace("|SETU||SETU|", `|SETU|${clientId}|SETU|${productInstanceId}`) };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("x-ratelimit-limit");
    const remainingStr = headers.get("x-ratelimit-remaining");
    const resetStr = headers.get("x-ratelimit-reset");
    if (limitStr && remainingStr) {
      const limit = parseInt(limitStr, 10);
      const remaining = parseInt(remainingStr, 10);
      if (!isNaN(limit) && !isNaN(remaining)) {
        const reset = resetStr ? new Date(parseInt(resetStr, 10) * 1000) : new Date(Date.now() + 60_000);
        return { limit, remaining, reset };
      }
    }
    return { limit: 500, remaining: 500, reset: new Date(Date.now() + 60_000) };
  }

  paginationStrategy(): PaginationStrategy {
    return new SetuPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>([
        ["POST /payment-links", IdempotencyLevel.CONDITIONAL],
        ["POST /refunds", IdempotencyLevel.CONDITIONAL],
        ["POST /upi/pay", IdempotencyLevel.CONDITIONAL],
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
    return new MeridianError(message, category, "setu", retryable, "", metadata, retryAfter, status);
  }

  private extractRetryAfter(headers: Headers | Record<string, string> | undefined): Date | undefined {
    if (!headers) return undefined;
    const value =
      headers instanceof Headers
        ? headers.get("retry-after")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);
    return parseRetryAfter(value) ?? undefined;
  }
}
