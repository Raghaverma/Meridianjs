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
import { IdfyPaginationStrategy } from "./pagination.js";

interface IdfyErrorBody {
  status: number;
  message: string;
  error?: string;
}

export class IdfyAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.idfy.com") {
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

    // authToken.token is encoded as "apiKey|accountId"
    const [apiKey, accountId] = authToken.token.split("|");

    const headers: Record<string, string> = {
      "api-key": apiKey ?? "",
      "account-id": accountId ?? "",
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
    return ResponseNormalizer.normalize(raw, "idfy", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as IdfyErrorBody | undefined;
    const message = errorBody?.message ?? errorBody?.error;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        message ?? "Authentication failed. Check your IDfy api-key and account-id.",
        { idfyError: errorBody?.error },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        message ?? "Permission denied. Your credentials lack the required permissions.",
        { idfyError: errorBody?.error },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Resource not found.",
        { idfyError: errorBody?.error },
        undefined,
        404,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Request validation failed.",
        { idfyError: errorBody?.error },
        undefined,
        status,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        message ?? "Rate limit exceeded. Please wait before retrying.",
        { idfyError: errorBody?.error, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        message ?? `IDfy API returned error ${status}. This may be temporary.`,
        { status, idfyError: errorBody?.error },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? `Request failed with status ${status}.`,
        { status, idfyError: errorBody?.error },
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
    const apiKey = config.apiKey;
    const accountId = config.custom?.accountId;

    if (!apiKey || !accountId) {
      throw this.createMeridianError(
        "auth",
        false,
        "IDfy authentication requires an api-key and account-id. " +
          "Set auth.apiKey and auth.custom.accountId.",
        {},
        undefined,
        401,
      );
    }

    return { token: `${apiKey}|${accountId}` };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("x-ratelimit-limit");
    const remainingStr = headers.get("x-ratelimit-remaining");
    const resetStr = headers.get("x-ratelimit-reset");

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
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new IdfyPaginationStrategy();
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
      "idfy",
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
