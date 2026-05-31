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
import { DelhiveryPaginationStrategy } from "./pagination.js";
import { ResponseNormalizer } from "../../core/normalizer.js";
import { parseRetryAfter } from "../../core/header-parser.js";

interface DelhiveryErrorBody {
  status?: boolean;
  error?: string;
  rmk?: string;
  Error?: string;
}

export class DelhiveryAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = "https://track.delhivery.com") {
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
      "Authorization": `Token ${authToken.token}`,
      "Content-Type": "application/json",
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
    return ResponseNormalizer.normalize(raw, "delhivery", rateLimitInfo, paginationInfo, [], "1.0.0");
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
        return this.createMeridianError("network", true, "Network request failed.", { originalError: raw.message });
      }
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      "status" in raw &&
      typeof (raw as Record<string, unknown>)["status"] === "number"
    ) {
      return this.parseHttpError(
        raw as { status: number; headers?: Headers | Record<string, string>; body?: unknown; message?: string }
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
    const errorBody = body as DelhiveryErrorBody | undefined;
    const errorMessage =
      errorBody?.error ?? errorBody?.rmk ?? errorBody?.Error;

    if (status === 401)
      return this.createMeridianError("auth", false, errorMessage ?? "Authentication failed.", {}, undefined, 401);
    if (status === 403)
      return this.createMeridianError("auth", false, errorMessage ?? "Permission denied.", {}, undefined, 403);
    if (status === 404)
      return this.createMeridianError("validation", false, errorMessage ?? "Resource not found.", {}, undefined, 404);
    if (status === 429) {
      const retryAfter = this.extractRetryAfter(headers);
      return this.createMeridianError("rate_limit", true, "Rate limit exceeded.", {}, retryAfter, 429);
    }
    if (status === 400 || status === 422)
      return this.createMeridianError("validation", false, errorMessage ?? "Validation failed.", {}, undefined, status);
    if (status >= 500)
      return this.createMeridianError("provider", true, `Delhivery API returned error ${status}.`, { status }, undefined, status);
    if (status >= 400)
      return this.createMeridianError("validation", false, `Request failed with status ${status}.`, { status }, undefined, status);
    return this.createMeridianError("provider", false, `Unexpected response status ${status}.`, { status }, undefined, status);
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const token = config.token ?? config.apiKey;
    if (!token) throw this.createMeridianError("auth", false, "Requires token or apiKey.", {}, undefined, 401);
    return { token };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    return { limit: 200, remaining: 200, reset: new Date(Date.now() + 60_000) };
  }

  paginationStrategy(): PaginationStrategy {
    return new DelhiveryPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  private createMeridianError(
    category: MeridianError["category"],
    retryable: boolean,
    message: string,
    metadata?: Record<string, unknown>,
    retryAfter?: Date,
    status?: number
  ): MeridianError {
    return new MeridianError(message, category, "delhivery", retryable, "", metadata, retryAfter, status);
  }

  private extractRetryAfter(headers: Headers | Record<string, string> | undefined): Date | undefined {
    if (!headers) return undefined;
    const value =
      headers instanceof Headers
        ? headers.get("retry-after")
        : (Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1] ?? null);
    return parseRetryAfter(value) ?? undefined;
  }
}
