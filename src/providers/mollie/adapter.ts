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
import { MolliePaginationStrategy } from "./pagination.js";

export class MollieAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.mollie.com/v2") {
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
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    let body: string | undefined;
    const method = options.method ?? "GET";
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = JSON.stringify(options.body);
    }

    const built: BuiltRequest = { url: url.toString(), method, headers };
    if (body !== undefined) built.body = body;
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(raw, "mollie", rateLimitInfo, paginationInfo, [], "1.0.0");
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
        return this.createError("network", true, "Network request failed.", { originalError: raw.message });
      }
    }

    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>).status === "number"
    ) {
      return this.parseHttpError(raw as { status: number; headers?: Headers | Record<string, string>; body?: unknown });
    }

    return this.createError("provider", false, "An unexpected error occurred.", { raw });
  }

  private parseHttpError(error: {
    status: number;
    headers?: Headers | Record<string, string>;
    body?: unknown;
  }): MeridianError {
    const { status, body, headers } = error;
    let message = "";

    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      message = String(b.detail ?? b.title ?? b.message ?? "");
    } else if (typeof body === "string") {
      message = body;
    }

    const meta = { mollieError: message };

    if (status === 401 || status === 403) {
      return this.createError("auth", false, message || "Unauthorized", meta, undefined, status);
    }
    if (status === 404) {
      return this.createError("validation", false, message || "Not Found", meta, undefined, 404);
    }
    if (status === 422) {
      return this.createError("validation", false, message || "Unprocessable Entity", meta, undefined, 422);
    }
    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createError("rate_limit", true, message || "Rate limit exceeded.", { ...meta, retryAfter: retryAfter?.toISOString() }, retryAfter, 429);
    }
    if (status >= 500) {
      return this.createError("provider", true, message || `Mollie API error ${status}`, meta, undefined, status);
    }
    return this.createError("validation", false, message || `Request failed with status ${status}`, meta, undefined, status);
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const key = config.apiKey ?? config.token;
    if (!key) {
      throw this.createError("auth", false, "Mollie requires an API key. Set auth.apiKey.", {}, undefined, 401);
    }
    return { token: key };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    return { limit: 250, remaining: 250, reset: new Date(Date.now() + 1000) };
  }

  paginationStrategy(): PaginationStrategy {
    return new MolliePaginationStrategy();
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
      const payloadStr =
        typeof payload === "string"
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString("utf8")
            : JSON.stringify(payload);
      const expected = createHmac("sha256", secret).update(payloadStr).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private createError(
    category: MeridianError["category"],
    retryable: boolean,
    message: string,
    metadata?: Record<string, unknown>,
    retryAfter?: Date,
    status?: number,
  ): MeridianError {
    return new MeridianError(message, category, "mollie", retryable, "", metadata, retryAfter, status);
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
