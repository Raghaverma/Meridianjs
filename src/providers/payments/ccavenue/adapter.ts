import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
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
import { CcavenuePaginationStrategy } from "./pagination.js";

interface CcavenueErrorBody {
  status?: string;
  reason?: string;
  error_code?: string;
  error_desc?: string;
}

// CCAvenue's published integration kit (Crypto.php / Crypto.java) derives a
// fixed 16-byte AES-128-CBC key/IV pair from the merchant's "working key":
//   key = MD5(workingKey)            (raw 16-byte digest)
//   iv  = ASCII bytes "0123456789abcdef" (constant across all merchants)
const CCAVENUE_IV = Buffer.from("0123456789abcdef", "utf-8");

/** Encrypts a JSON-serializable payload into the hex `enc_request` CCAvenue expects. */
export function ccavenueEncrypt(data: unknown, workingKey: string): string {
  const key = createHash("md5").update(workingKey, "utf-8").digest();
  const cipher = createCipheriv("aes-128-cbc", key, CCAVENUE_IV);
  const plaintext = typeof data === "string" ? data : JSON.stringify(data);
  return Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]).toString("hex");
}

/** Decrypts a hex `enc_response` string back into its plaintext (typically JSON). */
export function ccavenueDecrypt(encHex: string, workingKey: string): string {
  const key = createHash("md5").update(workingKey, "utf-8").digest();
  const decipher = createDecipheriv("aes-128-cbc", key, CCAVENUE_IV);
  const ciphertext = Buffer.from(encHex, "hex");
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

/**
 * CCAvenue's REST APIs exchange AES-128-CBC encrypted payloads (`enc_request` /
 * `enc_response`) keyed off a merchant "working key", alongside a plaintext
 * `access_code` that identifies the registered integration. Because
 * `parseResponse` doesn't have access to the working key, this adapter passes
 * `enc_response` through untouched in the normalized data — call the exported
 * `ccavenueDecrypt` helper (or the adapter's `decryptResponse`) with your
 * working key to recover the plaintext payload.
 */
export class CcavenueAdapter implements ProviderAdapter {
  private baseUrl: string;

  constructor(baseUrl = "https://api.ccavenue.com/") {
    this.baseUrl = baseUrl;
  }

  buildRequest(input: AdapterInput): BuiltRequest {
    const { endpoint, options, authToken, baseUrl } = input;
    const effectiveBaseUrl = baseUrl ?? this.baseUrl;
    const url = new URL(endpoint, effectiveBaseUrl);

    const [accessCode, workingKey] = authToken.token.split("|CCA|");
    const method = options.method ?? "GET";

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }
    if (accessCode) {
      url.searchParams.set("access_code", accessCode);
    }
    url.searchParams.set("request_type", "JSON");
    url.searchParams.set("response_type", "JSON");

    if (options.body && workingKey) {
      url.searchParams.set("enc_request", ccavenueEncrypt(options.body, workingKey));
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `Meridian-SDK/${SDK_VERSION}`,
      ...options.headers,
    };

    return { url: url.toString(), method, headers };
  }

  /** Decrypts a normalized response's `enc_response` field with the given working key. */
  decryptResponse(response: NormalizedResponse, workingKey: string): unknown {
    const data = response.data as { enc_response?: string } | undefined;
    if (!data?.enc_response) return response.data;
    try {
      return JSON.parse(ccavenueDecrypt(data.enc_response, workingKey));
    } catch {
      return ccavenueDecrypt(data.enc_response, workingKey);
    }
  }

  parseResponse(raw: RawResponse): NormalizedResponse {
    const rateLimitInfo = this.rateLimitPolicy(raw.headers);
    const paginationStrategy = this.paginationStrategy();
    const paginationInfo = ResponseNormalizer.extractPaginationInfo(raw, paginationStrategy);
    const warnings: string[] = [];
    if (typeof raw.body === "object" && raw.body !== null && "enc_response" in raw.body) {
      warnings.push(
        "Response payload is AES-encrypted (enc_response). Decrypt it with your working key " +
          "via `ccavenueDecrypt(encHex, workingKey)` or `adapter.decryptResponse(response, workingKey)`.",
      );
    }
    return ResponseNormalizer.normalize(
      raw,
      "ccavenue",
      rateLimitInfo,
      paginationInfo,
      warnings,
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
    const { status, body } = error;
    const errorBody = body as CcavenueErrorBody | undefined;
    const errorMessage = errorBody?.error_desc ?? errorBody?.reason;

    if (status === 401 || status === 403) {
      return this.createMeridianError(
        "auth",
        false,
        errorMessage ?? "Authentication failed. Check your CCAvenue access code and working key.",
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

    if (status === 400 || status === 422) {
      return this.createMeridianError(
        "validation",
        false,
        errorMessage ?? "Request validation failed.",
        { errorCode: errorBody?.error_code, reason: errorBody?.reason },
        undefined,
        status,
      );
    }

    if (status >= 500) {
      return this.createMeridianError(
        "provider",
        true,
        errorMessage ?? `CCAvenue API returned error ${status}. This may be temporary.`,
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
    const accessCode = config.apiKey ?? config.username;
    const workingKey = config.apiSecret ?? config.password ?? config.clientSecret;

    if (!accessCode || !workingKey) {
      throw this.createMeridianError(
        "auth",
        false,
        "CCAvenue authentication requires an access code and working key. " +
          "Set auth.apiKey (access code) + auth.apiSecret (working key).",
        {},
        undefined,
        401,
      );
    }

    return { token: `${accessCode}|CCA|${workingKey}` };
  }

  rateLimitPolicy(_headers: Headers): RateLimitInfo {
    // CCAvenue does not publish rate-limit headers; return conservative defaults.
    return {
      limit: 60,
      remaining: 60,
      reset: new Date(Date.now() + 60_000),
    };
  }

  paginationStrategy(): PaginationStrategy {
    return new CcavenuePaginationStrategy();
  }

  getIdempotencyConfig(): IdempotencyConfig {
    return {
      defaultSafeOperations: new Set(["GET", "HEAD", "OPTIONS"]),
      operationOverrides: new Map<string, IdempotencyLevel>(),
    };
  }

  /**
   * CCAvenue server-to-server (S2S) response/webhook payloads carry a plaintext
   * `enc_resp_hash` / signature derived as HMAC-SHA256 of the encrypted response
   * body using the working key. `payload` should be the raw `enc_response` (or
   * full body string) CCAvenue posted, and `secret` the merchant's working key.
   */
  verifyWebhook(payload: string | Buffer, signature: string, secret: string): boolean {
    const raw = typeof payload === "string" ? payload : payload.toString("utf-8");
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
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
      "ccavenue",
      retryable,
      "",
      metadata,
      retryAfter,
      status,
    );
  }
}
