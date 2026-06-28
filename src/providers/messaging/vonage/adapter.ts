import { createHmac, timingSafeEqual } from "node:crypto";
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
import { VonagePaginationStrategy } from "./pagination.js";

export class VonageAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.nexmo.com") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    const url = new URL(endpoint, effectiveBaseUrl);

    const hasAuthHeader =
      options.headers &&
      Object.keys(options.headers).some((h) => h.toLowerCase() === "authorization");

    if (!hasAuthHeader) {
      url.searchParams.set("api_key", authToken.token);
      if (authToken.secret) {
        url.searchParams.set("api_secret", authToken.secret);
      }
    }

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (
      options.body !== undefined &&
      options.body !== null &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      if (typeof options.body === "string") {
        body = options.body;
      } else {
        if (headers["Content-Type"] === "application/x-www-form-urlencoded") {
          const params = new URLSearchParams();
          for (const [key, val] of Object.entries(options.body)) {
            params.append(key, String(val));
          }
          body = params.toString();
        } else {
          body = JSON.stringify(options.body);
          if (!headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
          }
        }
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
    return ResponseNormalizer.normalize(raw, "vonage", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    let vonageMessage = "";

    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      vonageMessage = String(b.detail ?? b.title ?? b["error-text"] ?? b.error_description ?? "");
      if (!vonageMessage && Array.isArray(b.messages)) {
        const firstMsg = b.messages[0];
        if (firstMsg && typeof firstMsg === "object") {
          vonageMessage = String(firstMsg["error-text"] ?? "");
        }
      }
    } else if (typeof body === "string") {
      vonageMessage = body;
    }

    const metadata = {
      vonageError: vonageMessage,
    };

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        vonageMessage || (status === 401 ? "Unauthorized" : "Forbidden"),
        metadata,
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        vonageMessage || "Not Found",
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
        vonageMessage || "Rate limit exceeded.",
        { ...metadata, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        vonageMessage || "Validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        vonageMessage || `Vonage API error ${status}`,
        metadata,
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "validation",
      false,
      vonageMessage || `Request failed with status ${status}`,
      metadata,
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const key = config.apiKey ?? config.username;
    const secret = config.apiSecret ?? config.password ?? config.custom?.apiSecret;

    if (!key) {
      throw this.createMeridianError(
        "auth",
        false,
        "Vonage authentication requires an API Key. Set auth.apiKey or auth.username.",
        {},
        undefined,
        401,
      );
    }

    return { token: key, secret };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    const limitStr = headers.get("X-RateLimit-Limit") ?? headers.get("ratelimit-limit");
    const remainingStr = headers.get("X-RateLimit-Remaining") ?? headers.get("ratelimit-remaining");
    const resetStr = headers.get("X-RateLimit-Reset") ?? headers.get("ratelimit-reset");

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
    return new VonagePaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map(),
    };
  }

  verifyWebhook(
    payload: string | Buffer | Record<string, unknown>,
    signature: string,
    secret: string,
  ): boolean {
    try {
      let body: Record<string, unknown> = {};

      if (typeof payload === "object" && payload !== null) {
        body = payload as Record<string, unknown>;
      } else {
        const str = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
        body = JSON.parse(str);
      }

      const sig = signature || String(body.sig ?? "");
      if (!sig) return false;

      const keys = Object.keys(body)
        .filter((k) => k !== "sig")
        .sort();
      let paramStr = "";
      for (const k of keys) {
        paramStr += `&${k}=${body[k]}`;
      }
      if (paramStr.startsWith("&")) {
        paramStr = paramStr.substring(1);
      }

      const expected = createHmac("sha256", secret).update(paramStr).digest("hex");

      const bufA = Buffer.from(expected);
      const bufB = Buffer.from(sig);
      if (bufA.length !== bufB.length) {
        return false;
      }

      return timingSafeEqual(bufA, bufB);
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
      "vonage",
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
