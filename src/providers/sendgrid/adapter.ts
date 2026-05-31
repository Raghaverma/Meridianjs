import { createPublicKey, verify } from "node:crypto";
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
import { SendgridPaginationStrategy } from "./pagination.js";

interface SendgridErrorItem {
  message: string;
  field?: string | null;
  help?: string | null;
}

interface SendgridErrorBody {
  errors: SendgridErrorItem[];
}

export class SendgridAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.sendgrid.com") {
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
      Authorization: `Bearer ${authToken.token}`,
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
        body = JSON.stringify(options.body);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
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
    return ResponseNormalizer.normalize(
      raw,
      "sendgrid",
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
    const errorBody = body as SendgridErrorBody | undefined;
    const firstError = errorBody?.errors?.[0];
    const sendgridMessage = firstError?.message;
    const sendgridField = firstError?.field;
    const sendgridHelp = firstError?.help;

    const metadata = {
      sendgridErrors: errorBody?.errors,
      field: sendgridField,
      help: sendgridHelp,
    };

    if (status === 401) {
      return this.createMeridianError(
        "auth",
        false,
        sendgridMessage ?? "Authentication failed. Check your SendGrid API Key.",
        metadata,
        undefined,
        401,
      );
    }

    if (status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        sendgridMessage ?? "Permission denied. Your API Key lacks the required permissions.",
        metadata,
        undefined,
        403,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        sendgridMessage ?? "Resource not found.",
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
        sendgridMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { ...metadata, retryAfter: retryAfter?.toISOString() },
        retryAfter,
        429,
      );
    }

    if (status === 400 || status === 406 || status === 415) {
      return this.createMeridianError(
        "validation",
        false,
        sendgridMessage ?? "Request validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        sendgridMessage ?? `SendGrid API returned error ${status}. This may be temporary.`,
        { ...metadata, status },
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "validation",
      false,
      sendgridMessage ?? `Request failed with status ${status}.`,
      { ...metadata, status },
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
        "SendGrid authentication requires an API Key. Set auth.apiKey or auth.token.",
        {},
        undefined,
        401,
      );
    }

    return { token: key };
  }

  rateLimitPolicy(headers: Headers): RateLimitInfo {
    // SendGrid sets rate limit headers on specific resource paths
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
    return new SendgridPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map(),
    };
  }

  /**
   * Verify a SendGrid event webhook signature using Ed25519.
   *
   * @param payload The raw string or Buffer payload (typically timestamp + rawBody).
   * @param signature The base64-encoded signature from X-Twilio-Email-Event-Webhook-Signature.
   * @param secret The base64-encoded Ed25519 public key.
   */
  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    try {
      const rawPublicKey = Buffer.from(secret, "base64");
      if (rawPublicKey.length !== 32) {
        return false;
      }

      // Prepend SPKI DER header for 32-byte Ed25519 raw public key
      const oid = Buffer.from([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      ]);
      const derKey = Buffer.concat([oid, rawPublicKey]);

      const publicKey = createPublicKey({
        key: derKey,
        format: "der",
        type: "spki",
      });

      const data = typeof payload === "string" ? Buffer.from(payload) : payload;
      const sig = Buffer.from(signature, "base64");

      return verify(null, data, publicKey, sig);
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
      "sendgrid",
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
