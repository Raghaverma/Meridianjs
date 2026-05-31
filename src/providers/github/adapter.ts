import { parseRateLimitHeaders, parseRetryAfter } from "../../core/header-parser.js";
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
import { GitHubPaginationStrategy } from "./pagination.js";

interface GitHubErrorResponse {
  message?: string;
  documentation_url?: string;
  errors?: Array<{
    resource?: string;
    field?: string;
    code?: string;
    message?: string;
  }>;
}

export class GitHubAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.github.com") {
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
      Accept: "application/vnd.github.v3+json",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    if (authToken.token) {
      headers.Authorization = `Bearer ${authToken.token}`;
    }

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

    return ResponseNormalizer.normalize(raw, "github", rateLimitInfo, paginationInfo, [], "1.0.0");
  }

  parseError(raw: unknown): MeridianError {
    if (raw instanceof Error) {
      const errorMessage = raw.message.toLowerCase();
      if (
        errorMessage.includes("fetch") ||
        errorMessage.includes("network") ||
        errorMessage.includes("econnreset") ||
        errorMessage.includes("etimedout") ||
        errorMessage.includes("enotfound") ||
        errorMessage.includes("timeout")
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
      typeof raw.status === "number"
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
    const status = error.status;
    const body = error.body as GitHubErrorResponse | undefined;
    const headers = error.headers;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        "Authentication failed. Check your token is valid and not expired.",
        {
          githubMessage: body?.message,
          documentationUrl: body?.documentation_url,
        },
        undefined,
        401,
      );
    }

    if (status === 403) {
      const rateLimitRemaining = this.getHeaderValue(headers, "X-RateLimit-Remaining");
      if (rateLimitRemaining === "0") {
        const retryAfter = this.extractRetryAfter(headers);
        return this.createMeridianError(
          "rate_limit",
          true,
          "Rate limit exceeded. Please wait before retrying.",
          {
            githubMessage: body?.message,
            retryAfter: retryAfter?.toISOString(),
          },
          retryAfter,
          403,
        );
      }

      return this.createMeridianError(
        "auth",
        false,
        "Permission denied. Check your token has the required scopes.",
        {
          githubMessage: body?.message,
          documentationUrl: body?.documentation_url,
        },
        undefined,
        403,
      );
    }

    if (status === 404) {
      const message = body?.message?.toLowerCase() ?? "";
      if (
        message.includes("not found") ||
        message.includes("does not exist") ||
        message.includes("not accessible")
      ) {
        return this.createMeridianError(
          "validation",
          false,
          "Resource not found or not accessible.",
          {
            githubMessage: body?.message,
            note: "GitHub returns 404 for both missing resources and inaccessible resources",
          },
          undefined,
          404,
        );
      }

      return this.createMeridianError(
        "validation",
        false,
        "Resource not found.",
        {
          githubMessage: body?.message,
        },
        undefined,
        404,
      );
    }

    if (status === 422) {
      const fieldErrors = body?.errors
        ?.map((e) => `${e.field ?? "unknown"}: ${e.message ?? e.code ?? "validation error"}`)
        .join("; ");

      return this.createMeridianError(
        "validation",
        false,
        fieldErrors
          ? `Validation failed: ${fieldErrors}`
          : (body?.message ?? "Request validation failed."),
        {
          githubMessage: body?.message,
          fieldErrors: body?.errors,
        },
        undefined,
        422,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        "Rate limit exceeded. Please wait before retrying.",
        {
          githubMessage: body?.message,
          retryAfter: retryAfter?.toISOString(),
        },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        `GitHub API returned error ${status}. This may be temporary.`,
        {
          status,
          githubMessage: body?.message,
        },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        body?.message ?? `Request failed with status ${status}.`,
        {
          status,
          githubMessage: body?.message,
        },
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "provider",
      false,
      `Unexpected response status ${status}.`,
      {
        status,
        githubMessage: body?.message,
      },
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    if (!config.token) {
      throw this.createMeridianError(
        "auth",
        false,
        "GitHub authentication requires a token.",
        {},
        undefined,
        401,
      );
    }

    return {
      token: config.token,
    };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const parsed = parseRateLimitHeaders(headers);

    if (parsed) {
      return {
        limit: parsed.limit,
        remaining: parsed.remaining,
        reset: parsed.reset,
      };
    }

    return {
      limit: 5000,
      remaining: 5000,
      reset: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new GitHubPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /repos/:owner/:repo/pulls", IdempotencyLevel.CONDITIONAL],
        ["POST /repos/:owner/:repo/issues", IdempotencyLevel.CONDITIONAL],

        ["GET /search/code", IdempotencyLevel.UNSAFE],
        ["GET /search/repositories", IdempotencyLevel.UNSAFE],
        ["GET /search/users", IdempotencyLevel.UNSAFE],

        ["DELETE /repos/:owner/:repo", IdempotencyLevel.IDEMPOTENT],
        ["DELETE /repos/:owner/:repo/issues/:issue_number", IdempotencyLevel.IDEMPOTENT],
      ]),
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
      "github",
      retryable,
      "",
      metadata,
      retryAfter,
      status,
    );
  }

  private getHeaderValue(
    headers: Headers | Record<string, string> | undefined,
    name: string,
  ): string | null {
    if (!headers) {
      return null;
    }

    if (headers instanceof Headers) {
      return headers.get(name);
    }

    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }

    return null;
  }

  private extractRetryAfter(
    headers: Headers | Record<string, string> | undefined,
  ): Date | undefined {
    if (!headers) {
      return undefined;
    }

    const retryAfterValue = this.getHeaderValue(headers, "Retry-After");
    const parsed = parseRetryAfter(retryAfterValue);
    if (parsed) {
      return parsed;
    }

    const resetValue = this.getHeaderValue(headers, "X-RateLimit-Reset");
    if (resetValue) {
      const timestamp = Number.parseInt(resetValue.trim(), 10);
      if (!Number.isNaN(timestamp) && timestamp > 0) {
        const now = Math.floor(Date.now() / 1000);

        if (timestamp >= now - 60 && timestamp < now + 86400 * 365) {
          return new Date(timestamp * 1000);
        }
      }
    }

    return undefined;
  }
}
