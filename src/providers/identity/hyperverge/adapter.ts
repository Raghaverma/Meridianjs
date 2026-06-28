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
import { HyperVergePaginationStrategy } from "./pagination.js";

interface HyperVergeErrorBody {
  status: string;
  statusCode: number;
  result: {
    httpCode: number;
    code: string;
    description: string;
  };
}

export class HyperVergeAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://ind.hyperverge.co") {
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

    // authToken.token is encoded as "appId|appKey"
    const [appId, appKey] = authToken.token.split("|");

    const headers: Record<string, string> = {
      appid: appId ?? "",
      appkey: appKey ?? "",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    // Forward transactionid header if provided by caller
    if (options.headers?.transactionid) {
      headers.transactionid = options.headers.transactionid;
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
    return ResponseNormalizer.normalize(
      raw,
      "hyperverge",
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
    const errorBody = body as HyperVergeErrorBody | undefined;
    const description = errorBody?.result?.description;
    const code = errorBody?.result?.code;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        description ?? "Authentication failed. Check your HyperVerge appId and appKey.",
        { hypervergeCode: code, httpCode: errorBody?.result?.httpCode },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        description ?? "Permission denied. Your credentials lack the required permissions.",
        { hypervergeCode: code, httpCode: errorBody?.result?.httpCode },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        description ?? "Resource not found.",
        { hypervergeCode: code },
        undefined,
        404,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        description ?? "Request validation failed.",
        { hypervergeCode: code },
        undefined,
        status,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        description ?? "Rate limit exceeded. Please wait before retrying.",
        { hypervergeCode: code, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        description ?? `HyperVerge API returned error ${status}. This may be temporary.`,
        { status, hypervergeCode: code },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        description ?? `Request failed with status ${status}.`,
        { status, hypervergeCode: code },
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
    const appId = config.custom?.appId;
    const appKey = config.custom?.appKey;

    if (!appId || !appKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "HyperVerge authentication requires an appId and appKey. Set auth.custom.appId and auth.custom.appKey.",
        {},
        undefined,
        401,
      );
    }

    return { token: `${appId}|${appKey}` };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // HyperVerge does not publish rate-limit headers; return conservative defaults
    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new HyperVergePaginationStrategy();
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
      "hyperverge",
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
