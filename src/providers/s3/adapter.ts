import { createHmac, timingSafeEqual } from "node:crypto";
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
import { IdempotencyLevel, MeridianError, SDK_VERSION } from "../../core/types.js";
import { S3PaginationStrategy } from "./pagination.js";
import { type SigV4Credentials, signSigV4 } from "./sigv4.js";

interface S3ErrorBody {
  Code?: string;
  Message?: string;
  RequestId?: string;
  Resource?: string;
}

function extractXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1] ?? null;
}

/**
 * The auth token carries SigV4 credentials JSON-encoded (see `authStrategy`).
 * Falls back to treating an opaque token string as the access key ID — this
 * keeps `buildRequest` resilient to non-JSON tokens (e.g. generic contract
 * tests that pass a placeholder string) without producing a usable signature.
 */
function parseSigV4Credentials(token: string): SigV4Credentials {
  try {
    return JSON.parse(token) as SigV4Credentials;
  } catch {
    return { accessKeyId: token, secretAccessKey: "", region: "us-east-1", service: "s3" };
  }
}

/** Parses S3/R2's XML error body into a plain object, when present. */
function parseS3ErrorXml(body: unknown): S3ErrorBody | undefined {
  if (typeof body !== "string" || !body.includes("<Error>")) {
    return typeof body === "object" && body !== null ? (body as S3ErrorBody) : undefined;
  }
  const result: S3ErrorBody = {};
  const code = extractXmlField(body, "Code");
  const message = extractXmlField(body, "Message");
  const requestId = extractXmlField(body, "RequestId");
  const resource = extractXmlField(body, "Resource");
  if (code !== null) result.Code = code;
  if (message !== null) result.Message = message;
  if (requestId !== null) result.RequestId = requestId;
  if (resource !== null) result.Resource = resource;
  return result;
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, and other S3-API stores)
 * authenticates every request with AWS Signature Version 4 — there's no bearer
 * token or static API key header. Each call is signed in `buildRequest` using
 * the access key / secret key (and, for R2, region `"auto"`) supplied via
 * `auth.custom`. Responses are XML, not JSON; pagination and error parsing
 * extract the handful of fields they need from that XML directly.
 *
 * Configure with `auth.username`/`auth.password` (access key / secret key) and
 * `auth.custom = { region, endpoint?, sessionToken? }`. For R2, set
 * `auth.custom.region = "auto"` and `auth.custom.endpoint` to your account's
 * `https://<account_id>.r2.cloudflarestorage.com` URL (or pass it as `baseUrl`
 * in the provider config).
 */
export class S3Adapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://s3.amazonaws.com/") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;
    const url = new URL(endpoint.replace(/^\//, ""), effectiveBaseUrl);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const credentials = parseSigV4Credentials(authToken.token);
    const method = options.method ?? "GET";

    let body: string | undefined;
    const baseHeaders: Record<string, string> = {
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };
    if (options.body && method !== "GET" && method !== "HEAD") {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      baseHeaders["Content-Type"] ??= "application/octet-stream";
    }

    const signed = signSigV4(
      body !== undefined
        ? { method, url, headers: baseHeaders, body, credentials }
        : { method, url, headers: baseHeaders, credentials },
    );

    const built: BuiltRequest = { url: url.toString(), method, headers: signed.headers };
    if (body !== undefined) {
      built.body = body;
    }
    return built;
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    return ResponseNormalizer.normalize(raw, "s3", rateLimitInfo, paginationInfo, [], "1.0.0");
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
    const errorBody = parseS3ErrorXml(error.body);
    const errorMessage = errorBody?.Message;
    const metadata = { code: errorBody?.Code, requestId: errorBody?.RequestId };

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ??
          "Authentication failed. Check your access key ID, secret access key, and signing region.",
        metadata,
        undefined,
        status,
      );
    }

    if (status === 404) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Bucket or object not found.",
        metadata,
        undefined,
        404,
      );
    }

    if (status === 409 || status === 412 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        metadata,
        undefined,
        status,
      );
    }

    if (status === 429 || (status === 503 && errorBody?.Code === "SlowDown")) {
      return this.createMeridianError(
        "rate_limit",
        true,
        errorMessage ?? "Request rate exceeded. Please slow down and retry.",
        metadata,
        undefined,
        status,
      );
    }

    if (status === 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        metadata,
        undefined,
        400,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `S3 API returned error ${status}. This may be temporary.`,
        metadata,
        undefined,
        status,
      );
    }

    if (status >= 400) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? `Request failed with status ${status}.`,
        metadata,
        undefined,
        status,
      );
    }

    return this.createMeridianError(
      "provider",
      false,
      `Unexpected response status ${status}.`,
      metadata,
      undefined,
      status,
    );
  }

  async authStrategy(config: AuthConfig): Promise<AuthToken> {
    const accessKeyId = config.username ?? config.apiKey ?? config.clientId;
    const secretAccessKey = config.password ?? config.apiSecret ?? config.clientSecret;
    const region = config.custom?.region ?? "us-east-1";
    const sessionToken = config.custom?.sessionToken ?? config.refreshToken;

    if (!accessKeyId || !secretAccessKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "S3 authentication requires an access key ID and secret access key. " +
          "Set auth.username (access key ID) + auth.password (secret access key), " +
          'and optionally auth.custom = { region, sessionToken } (use region: "auto" for R2).',
        {},
        undefined,
        401,
      );
    }

    const credentials: SigV4Credentials = {
      accessKeyId,
      secretAccessKey,
      region,
      service: "s3",
      ...(sessionToken ? { sessionToken } : {}),
    };

    return { token: JSON.stringify(credentials) };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // S3 does not publish rate-limit headers; it signals throttling via 503 SlowDown.
    return {
      limit: 100,
      remaining: 100,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new S3PaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>([["PUT", IdempotencyLevel.IDEMPOTENT]]),
    };
  }

  /**
   * Verifies an S3 Event Notification delivered via SNS/EventBridge webhook —
   * an HMAC-SHA256 digest of the raw request body, hex-encoded, keyed by a
   * shared secret configured on the destination (S3 itself does not sign
   * notifications; this supports the common "shared secret" relay pattern).
   */
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
    return new MeridianError(message, category, "s3", retryable, "", metadata, retryAfter, status);
  }
}
