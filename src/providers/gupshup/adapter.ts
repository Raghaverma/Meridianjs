import { createHmac, timingSafeEqual } from "node:crypto";
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
import { type IdempotencyLevel, MeridianError, SDK_VERSION } from "../../core/types.js";
import { GupshupPaginationStrategy } from "./pagination.js";

interface GupshupErrorBody {
  status: string;
  message: string;
}

export class GupshupAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.gupshup.io") {
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
      apikey: authToken.token,
      "Content-Type": "application/x-www-form-urlencoded",
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
    return ResponseNormalizer.normalize(raw, "gupshup", rateLimitInfo, paginationInfo, [], "1.0.0");
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
        return this.createMeridianError("network", true, "Network request failed.", {
          originalError: raw.message,
        });
      }
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>)["status"] === "number"
    ) {
      return this.parseHttpError(
        raw as {
          status: number;
          headers?: Headers | Record<string, string>;
          body?: unknown;
          message?: string;
        },
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
    const errorBody = body as GupshupErrorBody | string | undefined;
    const errorMessage =
      typeof errorBody === "string"
        ? errorBody
        : typeof errorBody === "object" && errorBody !== null
          ? errorBody.message
          : undefined;

    if (status === 401)
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed.",
        {},
        undefined,
        401,
      );
    if (status === 403)
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied.",
        {},
        undefined,
        403,
      );
    if (status === 404)
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        {},
        undefined,
        404,
      );
    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError(
        "rate_limit",
        true,
        "Rate limit exceeded.",
        {},
        retryAfter,
        429,
      );
    }
    if (status === 400 || status === 422)
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Validation failed.",
        {},
        undefined,
        status,
      );
    if (status >= 500)
      return this.createMeridianError(
        "provider",
        true,
        `Gupshup API returned error ${status}.`,
        { status },
        undefined,
        status,
      );
    if (status >= 400)
      return this.createMeridianError(
        "validation",
        false,
        `Request failed with status ${status}.`,
        { status },
        undefined,
        status,
      );
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
    if (!apiKey)
      throw this.createMeridianError("auth", false, "Requires apiKey.", {}, undefined, 401);
    return { token: apiKey };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    return { limit: 1000, remaining: 1000, reset: new Date(Date.now() + 60_000) };
  }

  paginationStrategy(): PaginationStrategy {
    return new GupshupPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

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
      "gupshup",
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
