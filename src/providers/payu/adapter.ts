
import { createHmac, timingSafeEqual } from "node:crypto";
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
import { PayuPaginationStrategy } from "./pagination.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
import { parseRetryAfter } from "../../core/header-parser.js";


interface PayuErrorBody {
  status: number;
  msg: string;
  error?: string;
  error_Message?: string;
}


export class PayuAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = "https://info.payu.in") {
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

    // authToken.token is encoded as "key:salt" — base64 for Basic auth
    const credentials = Buffer.from(authToken.token).toString("base64");

    const headers: Record<string, string> = {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/json",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

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
    return ResponseNormalizer.normalize(raw, "payu", rateLimitInfo, paginationInfo, [], "1.0.0");
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
          { originalError: raw.message }
        );
      }
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>)["status"] === "number"
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
    const errorBody = body as PayuErrorBody | undefined;
    const errorMessage = errorBody?.error_Message ?? errorBody?.error ?? errorBody?.msg;

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your PayU merchant key and salt.",
        { payuMsg: errorBody?.msg },
        undefined,
        401
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Permission denied. Your API credentials lack the required permissions.",
        { payuMsg: errorBody?.msg },
        undefined,
        403
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { payuMsg: errorBody?.msg },
        undefined,
        404
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
        429
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { payuMsg: errorBody?.msg },
        undefined,
        status
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `PayU API returned error ${status}. This may be temporary.`,
        { status },
        undefined,
        status
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status },
        undefined,
        status
      );
    }

    return this.createMeridianError(
      "provider",
      false,
      `Unexpected response status ${status}.`,
      { status },
      undefined,
      status
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const key = config.username;
    const salt = config.password;

    if (!key || !salt) {
      throw this.createMeridianError(
        "auth",
        false,
        "PayU authentication requires a merchant key and merchant salt. " +
          "Set auth.username (merchant key) + auth.password (merchant salt).",
        {},
        undefined,
        401
      );
    }

    return { token: `${key}:${salt}` };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // PayU does not publish rate-limit headers; return defaults
    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new PayuPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    const expected = createHmac("sha512", secret).update(payload).digest("hex");
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
    status?: number
  ): MeridianError {
    return new MeridianError(message, category, "payu", retryable, "", metadata, retryAfter, status);
  }

  private extractRetryAfter(
    headers: Headers | Record<string, string> | undefined
  ): Date | undefined {
    if (!headers) return undefined;

    const value =
      headers instanceof Headers
        ? headers.get("retry-after")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);

    return parseRetryAfter(value) ?? undefined;
  }
}
