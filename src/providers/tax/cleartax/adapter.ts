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
import { CleartaxPaginationStrategy } from "./pagination.js";

interface CleartaxErrorBody {
  errorCode: string;
  message: string;
  error?: string;
}

export class CleartaxAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.cleartax.in") {
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
      "x-cleartax-auth-token": authToken.token,
      "Content-Type": "application/json",
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
      "cleartax",
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
    const errorBody = body as CleartaxErrorBody | undefined;
    const errorCode = errorBody?.errorCode;
    const errorMessage = errorBody?.message ?? errorBody?.error;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your ClearTax auth token.",
        { cleartaxCode: errorCode },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Check GSTIN or owner permissions.",
        { cleartaxCode: errorCode },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { cleartaxCode: errorCode },
        undefined,
        404,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "GST filing validation failed. Check your request parameters.",
        { cleartaxCode: errorCode },
        undefined,
        status,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { cleartaxCode: errorCode, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `ClearTax API returned error ${status}. This may be temporary.`,
        { status, cleartaxCode: errorCode },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status, cleartaxCode: errorCode },
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
    const token = config.token ?? config.apiKey;
    if (!token) {
      throw this.createMeridianError(
        "auth",
        false,
        "ClearTax authentication requires an auth token. Set auth.token or auth.apiKey.",
        {},
        undefined,
        401,
      );
    }
    return { token };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // ClearTax does not publish rate-limit headers; return conservative defaults
    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new CleartaxPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map(),
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
      "cleartax",
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
