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
import { MeridianError, SDK_VERSION } from "../../../core/types.js";
import { HubSpotPaginationStrategy } from "./pagination.js";

export class HubSpotAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.hubapi.com") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const baseUrlStripped = effectiveBaseUrl.endsWith("/")
      ? effectiveBaseUrl.slice(0, -1)
      : effectiveBaseUrl;
    const endpointStripped = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = new URL(baseUrlStripped + endpointStripped);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken.token}`,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
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
    return ResponseNormalizer.normalize(raw, "hubspot", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    let hubspotMessage = "";

    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      hubspotMessage = String(b.message ?? b.error_description ?? b.error ?? "");
    } else if (typeof body === "string") {
      hubspotMessage = body;
    }

    const metadata = { hubspotError: hubspotMessage };

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        hubspotMessage || (status === 401 ? "Unauthorized" : "Forbidden"),
        metadata,
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        hubspotMessage || "Not Found",
        metadata,
        undefined,
        404,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        hubspotMessage || "Rate limit exceeded.",
        { ...metadata, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        hubspotMessage || "Validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        hubspotMessage || `HubSpot API error ${status}`,
        metadata,
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "validation",
      false,
      hubspotMessage || `Request failed with status ${status}`,
      metadata,
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
        "HubSpot authentication requires an API Key or Token. Set auth.apiKey or auth.token.",
        {},
        undefined,
        401,
      );
    }

    return { token: key };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("X-HubSpot-RateLimit-Daily") ?? headers.get("ratelimit-limit");
    const remainingStr =
      headers.get("X-HubSpot-RateLimit-Daily-Remaining") ?? headers.get("ratelimit-remaining");
    const resetStr = headers.get("X-HubSpot-RateLimit-Reset") ?? headers.get("ratelimit-reset");

    if (limitStr && remainingStr) {
      const limit = Number.parseInt(limitStr, 10);
      const remaining = Number.parseInt(remainingStr, 10);

      if (!Number.isNaN(limit) && !Number.isNaN(remaining)) {
        const reset = resetStr
          ? new Date(Number.parseInt(resetStr, 10) * 1000)
          : new Date(Date.now() + 60000);
        return { limit, remaining, reset };
      }
    }

    return {
      limit: 600,
      remaining: 600,
      reset: new Date(Date.now() + 60000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new HubSpotPaginationStrategy();
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
      "hubspot",
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
