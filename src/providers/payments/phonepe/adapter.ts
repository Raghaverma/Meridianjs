import { createHash, timingSafeEqual } from "node:crypto";
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
import { PhonePePaginationStrategy } from "./pagination.js";

export class PhonePeAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api-preprod.phonepe.com/apis/pg-sandbox") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;

    // Parse PhonePe compound token: merchantId:saltKey:saltIndex
    const parts = authToken.token.split(":");
    const merchantId = parts[0] ?? "";
    const saltKey = parts[1] ?? "";
    const saltIndex = parts[2] ?? "1";

    let finalEndpoint = endpoint;
    if (endpoint.includes("{merchant_id}")) {
      finalEndpoint = endpoint.replace("{merchant_id}", merchantId);
    }

    const baseUrlStripped = effectiveBaseUrl.endsWith("/")
      ? effectiveBaseUrl.slice(0, -1)
      : effectiveBaseUrl;
    const endpointStripped = finalEndpoint.startsWith("/") ? finalEndpoint : `/${finalEndpoint}`;
    const url = new URL(baseUrlStripped + endpointStripped);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    let bodyStr: string | undefined;
    const method = options.method ?? "GET";
    let base64Request = "";

    if (options.body && method !== "GET" && method !== "HEAD") {
      base64Request = Buffer.from(JSON.stringify(options.body)).toString("base64");
      bodyStr = JSON.stringify({ request: base64Request });
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    // X-VERIFY calculation: sha256(base64Request + endpoint + saltKey) + "###" + saltIndex
    const signaturePayload = base64Request + endpointStripped + saltKey;
    const signature = `${createHash("sha256").update(signaturePayload).digest("hex")}###${saltIndex}`;

    headers["X-VERIFY"] = signature;

    const built: BuiltRequest = {
      url: url.toString(),
      method,
      headers,
    };
    if (bodyStr !== undefined) {
      built.body = bodyStr;
    }
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(raw, "phonepe", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    let phonepeMessage = "";
    let phonepeCode = "";

    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      phonepeMessage = String(b.message ?? b.error_description ?? b.error ?? "");
      phonepeCode = String(b.code ?? "");
    } else if (typeof body === "string") {
      phonepeMessage = body;
    }

    const metadata = { phonepeError: phonepeMessage, phonepeCode };

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        phonepeMessage || (status === 401 ? "Unauthorized" : "Forbidden"),
        metadata,
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        phonepeMessage || "Not Found",
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
        phonepeMessage || "Rate limit exceeded.",
        { ...metadata, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        phonepeMessage || "Validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        phonepeMessage || `PhonePe API error ${status}`,
        metadata,
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "validation",
      false,
      phonepeMessage || `Request failed with status ${status}`,
      metadata,
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const merchantId = config.clientId ?? config.username ?? config.custom?.merchantId;
    const saltKey = config.apiKey ?? config.custom?.saltKey;
    const saltIndex = config.password ?? config.custom?.saltIndex ?? "1";

    if (!merchantId || !saltKey || !saltIndex) {
      throw this.createMeridianError(
        "auth",
        false,
        "PhonePe authentication requires a merchantId, saltKey, and saltIndex. " +
          "Set auth.clientId + auth.apiKey + auth.password, or auth.custom.merchantId + auth.custom.saltKey + auth.custom.saltIndex.",
        {},
        undefined,
        401,
      );
    }

    return { token: `${merchantId}:${saltKey}:${saltIndex}` };
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
    return new PhonePePaginationStrategy();
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
      let base64Payload = "";
      if (typeof payload === "object" && payload !== null) {
        if (Buffer.isBuffer(payload)) {
          const rawStr = payload.toString("utf8");
          try {
            const parsed = JSON.parse(rawStr);
            base64Payload = parsed.response ?? rawStr;
          } catch {
            base64Payload = rawStr;
          }
        } else {
          base64Payload =
            ((payload as Record<string, unknown>).response as string) ?? JSON.stringify(payload);
        }
      } else if (typeof payload === "string") {
        try {
          const parsed = JSON.parse(payload);
          base64Payload = parsed.response ?? payload;
        } catch {
          base64Payload = payload;
        }
      }

      // Check if signature contains "###"
      const parts = signature.split("###");
      const actualHmac = parts[0] ?? "";

      const expectedHmac = createHash("sha256")
        .update(base64Payload + secret)
        .digest("hex");

      const bufA = Buffer.from(expectedHmac);
      const bufB = Buffer.from(actualHmac);

      return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
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
      "phonepe",
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
