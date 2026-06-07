import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
import { BilldeskPaginationStrategy } from "./pagination.js";

interface BilldeskErrorBody {
  status?: number;
  error_type?: string;
  error_code?: string;
  message?: string;
  transaction_error_code?: string;
  transaction_error_desc?: string;
}

const JOSE_CONTENT_TYPE = "application/jose";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * BillDesk's payment APIs use JOSE (JWS-HMAC, alg HS256) instead of bearer tokens:
 * the request/response bodies are wrapped in a compact JWS, and the merchant's
 * `clientid` travels inside the JWS header rather than as a separate HTTP header.
 * `BD-Traceid` doubles as the request's idempotency key (BillDesk rejects a repeat
 * Traceid within the same day) and `BD-Timestamp` is the epoch seconds at send time.
 *
 * See: https://docs.billdesk.io/reference/authentications-and-endpoints
 */
export class BilldeskAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.billdesk.com/") {
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

    const [clientId, secretKey] = authToken.token.split("|BD|");
    const method = options.method ?? "GET";

    const headers: Record<string, string> = {
      Accept: JOSE_CONTENT_TYPE,
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      "BD-Timestamp": String(Math.floor(Date.now() / 1000)),
      "BD-Traceid": (options.idempotencyKey ?? randomUUID()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 35),
      ...options.headers,
    };

    let body: string | undefined;
    if (clientId && secretKey) {
      if (options.body && method !== "GET" && method !== "HEAD") {
        body = this.signJws(options.body, clientId, secretKey);
        headers["Content-Type"] = JOSE_CONTENT_TYPE;
      } else if (method !== "GET" && method !== "HEAD") {
        body = this.signJws({}, clientId, secretKey);
        headers["Content-Type"] = JOSE_CONTENT_TYPE;
      }
    }

    const built: BuiltRequest = { url: url.toString(), method, headers };
    if (body !== undefined) {
      built.body = body;
    }
    return built;
  }

  /** Builds a compact JWS (header.payload.signature, alg=HS256) per BillDesk's JOSE contract. */
  private signJws(payload: unknown, clientId: string, secretKey: string): string {
    const header = { alg: "HS256", clientid: clientId };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload ?? {}));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = base64url(createHmac("sha256", secretKey).update(signingInput).digest());
    return `${signingInput}.${signature}`;
  }

  /** Decodes a compact JWS payload segment back into JSON, without verifying the signature. */
  private decodeJwsPayload(token: string): unknown {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    try {
      return JSON.parse(base64urlDecode(parts[1]).toString("utf-8"));
    } catch {
      return null;
    }
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    let body = raw.body;
    if (typeof body === "string" && body.split(".").length === 3) {
      const decoded = this.decodeJwsPayload(body);
      if (decoded !== null) {
        body = decoded;
      }
    }

    const effectiveRaw: RawResponse = { ...raw, body };
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(effectiveRaw, paginationStrategy);
    return ResponseNormalizer.normalize(
      effectiveRaw,
      "billdesk",
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
    const { status } = error;
    let body = error.body as BilldeskErrorBody | string | undefined;
    if (typeof body === "string" && body.split(".").length === 3) {
      const decoded = this.decodeJwsPayload(body);
      if (decoded !== null) {
        body = decoded as BilldeskErrorBody;
      }
    }
    const errorBody = (typeof body === "object" ? body : undefined) as BilldeskErrorBody | undefined;
    const errorMessage =
      errorBody?.message ?? errorBody?.transaction_error_desc ?? errorBody?.error_code;

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your BillDesk client ID and secret key.",
        { errorCode: errorBody?.error_code },
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Resource not found.",
        { errorCode: errorBody?.error_code },
        undefined,
        404,
      );
    }

    if (status === 429) {
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Rate limit exceeded. Please wait before retrying.",
        { errorCode: errorBody?.error_code },
        undefined,
        429,
      );
    }

    if (status === 400 || status === 409 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { errorCode: errorBody?.error_code, errorType: errorBody?.error_type },
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `BillDesk API returned error ${status}. This may be temporary.`,
        { status },
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        { status },
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
    const clientId = config.clientId ?? config.username;
    const secretKey = config.clientSecret ?? config.apiSecret ?? config.password;

    if (!clientId || !secretKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "BillDesk authentication requires a client ID and secret key. " +
          "Set auth.clientId + auth.clientSecret (merchant client ID and HMAC secret key).",
        {},
        undefined,
        401,
      );
    }

    return { token: `${clientId}|BD|${secretKey}` };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // BillDesk does not publish rate-limit headers; return conservative defaults.
    return {
      limit: 60,
      remaining: 60,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new BilldeskPaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  /**
   * Verifies a webhook/LCM notification's JWS-HMAC signature. BillDesk delivers
   * webhook payloads as compact JWS strings signed with the merchant's secret key;
   * `signature` is the full `header.payload.signature` string (or just the signature
   * segment), and `payload` is the raw request body received from BillDesk.
   */
  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    const raw = typeof payload === "string" ? payload : payload.toString("utf-8");
    const parts = raw.split(".");

    let signingInput: string;
    let providedSignature: string;
    if (parts.length === 3 && parts[0] && parts[1]) {
      signingInput = `${parts[0]}.${parts[1]}`;
      providedSignature = signature.includes(".")
        ? (signature.split(".").pop() ?? signature)
        : signature;
    } else {
      signingInput = raw;
      providedSignature = signature;
    }

    const expected = base64url(createHmac("sha256", secret).update(signingInput).digest());
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(providedSignature);
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
      "billdesk",
      retryable,
      "",
      metadata,
      retryAfter,
      status,
    );
  }
}
