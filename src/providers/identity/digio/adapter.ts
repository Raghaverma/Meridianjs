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
import { DigioPaginationStrategy } from "./pagination.js";

interface DigioErrorBody {
  message: string;
  error_code?: string;
  status?: number;
}

export class DigioAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.digio.in") {
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

    // authToken.token is the base64-encoded "clientId:clientSecret"
    const headers: Record<string, string> = {
      Authorization: `Basic ${authToken.token}`,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    if (options.idempotencyKey) {
      headers["x-idempotency-key"] = options.idempotencyKey;
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
    return ResponseNormalizer.normalize(raw, "digio", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = body as DigioErrorBody | undefined;
    const message = errorBody?.message;
    const errorCode = errorBody?.error_code;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        message ?? "Authentication failed. Check your Digio clientId and clientSecret.",
        { digioErrorCode: errorCode },
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        message ?? "Permission denied. Your credentials lack the required permissions.",
        { digioErrorCode: errorCode },
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Resource not found.",
        { digioErrorCode: errorCode },
        undefined,
        404,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? "Request validation failed.",
        { digioErrorCode: errorCode },
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
        { digioErrorCode: errorCode, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        message ?? `Digio API returned error ${status}. This may be temporary.`,
        { status, digioErrorCode: errorCode },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        message ?? `Request failed with status ${status}.`,
        { status, digioErrorCode: errorCode },
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
    const clientId = config.clientId ?? config.custom?.clientId;
    const clientSecret = config.clientSecret ?? config.custom?.clientSecret;

    if (!clientId || !clientSecret) {
      throw this.createMeridianError(
        "auth",
        false,
        "Digio authentication requires a clientId and clientSecret. " +
          "Set auth.clientId + auth.clientSecret, or auth.custom.clientId + auth.custom.clientSecret.",
        {},
        undefined,
        401,
      );
    }

    // Base64-encode "clientId:clientSecret" for Basic auth in buildRequest
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    return { token: encoded };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // Digio does not publish rate-limit headers; return conservative defaults
    return {
      limit: 200,
      remaining: 200,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new DigioPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map([
        ["POST /v2/client/kyc/initiate", IdempotencyLevel.CONDITIONAL],
        ["POST /v2/client/kyc/upload_documents", IdempotencyLevel.CONDITIONAL],
        ["POST /v2/signing/create", IdempotencyLevel.CONDITIONAL],
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
      "digio",
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
