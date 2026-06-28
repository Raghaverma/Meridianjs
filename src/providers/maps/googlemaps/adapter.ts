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
import { GoogleMapsPaginationStrategy } from "./pagination.js";

/**
 * Google Maps Platform error response body.
 * Returned on HTTP 4xx/5xx and also embedded in 200 responses when
 * the API-level status is not "OK" (e.g. OVER_QUERY_LIMIT).
 */
interface GoogleMapsErrorBody {
  error_message?: string;
  status?: string;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

// Google Maps API-level status codes that indicate specific failure modes.
const OVER_QUOTA_STATUSES = new Set(["OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT"]);
const AUTH_STATUSES = new Set(["REQUEST_DENIED"]);
const VALIDATION_STATUSES = new Set([
  "INVALID_REQUEST",
  "MAX_WAYPOINTS_EXCEEDED",
  "MAX_ROUTE_LENGTH_EXCEEDED",
  "NOT_FOUND",
  "ZERO_RESULTS",
]);

export class GoogleMapsAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://maps.googleapis.com/maps/api") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const url = new URL(endpoint.replace(/^\//, ""), `${effectiveBaseUrl}/`);

    // API key is passed as a query parameter — this is the standard auth
    // mechanism for Google Maps Platform REST APIs.
    url.searchParams.set("key", authToken.token);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        // Don't let callers overwrite the auth key.
        if (key !== "key") url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      Accept: "application/json",
      ...options.headers,
    };

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
    return ResponseNormalizer.normalize(
      raw,
      "googlemaps",
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
    const errorBody = body as GoogleMapsErrorBody | undefined;

    // Google Maps often returns 200 with a non-OK status in the body.
    // When the pipeline surfaces an error, check the body status first.
    const apiStatus = errorBody?.status ?? errorBody?.error?.status;
    const message = errorBody?.error_message ?? errorBody?.error?.message;

    if (apiStatus && OVER_QUOTA_STATUSES.has(apiStatus)) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        message ?? "Google Maps quota exceeded. Check your usage limits in Google Cloud Console.",
        { apiStatus },
        retryAfter,
        429,
      );
    }

    if (apiStatus && AUTH_STATUSES.has(apiStatus)) {
      return this.createMeridianError(
        "auth",
        false,
        message ??
          "Request denied. Check that your API key is valid and the Maps API is enabled in Google Cloud Console.",
        { apiStatus },
        undefined,
        403,
      );
    }

    if (apiStatus && VALIDATION_STATUSES.has(apiStatus)) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? `Request failed with status ${apiStatus}.`,
        { apiStatus },
        undefined,
        400,
      );
    }

    if (status === 400) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Bad request. Check the request parameters.",
        { googleMapsError: errorBody },
        undefined,
        400,
      );
    }

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        message ??
          "Authentication failed. Ensure your API key is valid and billing is enabled in Google Cloud Console.",
        { googleMapsError: errorBody },
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Resource not found.",
        { googleMapsError: errorBody },
        undefined,
        404,
      );
    }

    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        message ?? "Rate limit exceeded. Check your quota settings in Google Cloud Console.",
        { retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        message ?? `Google Maps API returned error ${status}. This may be temporary.`,
        { status, googleMapsError: errorBody },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? `Request failed with status ${status}.`,
        { status, googleMapsError: errorBody },
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
        "Google Maps authentication requires an API key. Set auth.apiKey to your Google Maps Platform API key.",
        {},
        undefined,
        401,
      );
    }
    return { token: key };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // Google Maps Platform does not expose rate-limit headers in responses.
    // Quotas are managed in Google Cloud Console (per-day and per-minute limits).
    return {
      limit: 3000,
      remaining: 3000,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new GoogleMapsPaginationStrategy();
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
      "googlemaps",
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
