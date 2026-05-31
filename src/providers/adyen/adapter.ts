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
import { MeridianError, SDK_VERSION } from "../../core/types.js";
import { AdyenPaginationStrategy } from "./pagination.js";

export class AdyenAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://checkout-test.adyen.com/v70") {
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
      "X-API-Key": authToken.token,
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
    return ResponseNormalizer.normalize(raw, "adyen", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    let adyenMessage = "";

    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      adyenMessage = String(b.message ?? b.error_description ?? b.detail ?? "");
    } else if (typeof body === "string") {
      adyenMessage = body;
    }

    const metadata = { adyenError: adyenMessage };

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        adyenMessage || (status === 401 ? "Unauthorized" : "Forbidden"),
        metadata,
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        adyenMessage || "Not Found",
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
        adyenMessage || "Rate limit exceeded.",
        { ...metadata, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        adyenMessage || "Validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        adyenMessage || `Adyen API error ${status}`,
        metadata,
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "validation",
      false,
      adyenMessage || `Request failed with status ${status}`,
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
        "Adyen authentication requires an API Key. Set auth.apiKey or auth.token.",
        {},
        undefined,
        401,
      );
    }

    return { token: key };
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
    return new AdyenPaginationStrategy();
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

      let toSign = "";
      let providedSig = signature;

      // Extract Adyen notification item if present
      const notificationItems = body.notificationItems as
        | Array<Record<string, unknown>>
        | undefined;
      const firstItem = notificationItems?.[0]?.NotificationRequestItem as
        | Record<string, unknown>
        | undefined;

      if (firstItem) {
        const amount = (firstItem.amount as Record<string, unknown>) ?? {};
        const pspReference = String(firstItem.pspReference ?? "");
        const originalReference = String(firstItem.originalReference ?? "");
        const merchantAccountCode = String(firstItem.merchantAccountCode ?? "");
        const merchantReference = String(firstItem.merchantReference ?? "");
        const value = String(amount.value ?? "");
        const currency = String(amount.currency ?? "");
        const eventCode = String(firstItem.eventCode ?? "");
        const success = String(firstItem.success ?? "");

        // Adyen field ordering: pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success
        toSign = `${pspReference}:${originalReference}:${merchantAccountCode}:${merchantReference}:${value}:${currency}:${eventCode}:${success}`;

        if (!providedSig) {
          const additionalData = (firstItem.additionalData as Record<string, unknown>) ?? {};
          providedSig = String(additionalData.hmacSignature ?? "");
        }
      } else {
        // Fallback for simple payload
        if (typeof payload === "string") {
          toSign = payload;
        } else if (Buffer.isBuffer(payload)) {
          toSign = payload.toString("utf8");
        } else {
          toSign = JSON.stringify(payload);
        }
      }

      if (!providedSig) return false;

      // Adyen webhook secret is hex or base64
      let keyBuffer: Buffer;
      if (secret.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(secret)) {
        keyBuffer = Buffer.from(secret, "hex");
      } else {
        keyBuffer = Buffer.from(secret, "base64");
      }

      const expected = createHmac("sha256", keyBuffer).update(toSign).digest("base64");

      const bufA = Buffer.from(expected);
      const bufB = Buffer.from(providedSig);

      if (bufA.length !== bufB.length) {
        // Check if providedSig is hex encoded
        const expectedHex = createHmac("sha256", keyBuffer).update(toSign).digest("hex");
        const bufAHex = Buffer.from(expectedHex);
        const bufBHex = Buffer.from(providedSig);
        if (bufAHex.length === bufBHex.length) {
          return timingSafeEqual(bufAHex, bufBHex);
        }
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
      "adyen",
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
