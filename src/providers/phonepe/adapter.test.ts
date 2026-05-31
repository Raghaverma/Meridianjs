import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { PhonePeAdapter } from "./adapter.js";

describe("PhonePe Adapter - Contract Tests", () => {
  const adapter = new PhonePeAdapter("https://api-preprod.phonepe.com/apis/pg-sandbox");

  // ─── buildRequest ────────────────────────────────────────────────────────────
  describe("buildRequest", () => {
    it("should build a GET request with correct X-VERIFY signature", () => {
      const input = {
        endpoint: "/pg/v1/status/MERCHANT123/TX98765",
        options: { method: "GET" as const },
        authToken: { token: "MERCHANT123:saltKeyValue:1" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe(
        "https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/status/MERCHANT123/TX98765",
      );
      expect(built.method).toBe("GET");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
      expect(built.headers.Accept).toBe("application/json");

      // Verify GET X-VERIFY calculation: sha256("" + endpoint + saltKey) + "###" + saltIndex
      const expectedSignaturePayload = "/pg/v1/status/MERCHANT123/TX98765saltKeyValue";

      const expectedHash = createHash("sha256").update(expectedSignaturePayload).digest("hex");
      expect(built.headers["X-VERIFY"]).toBe(`${expectedHash}###1`);
    });

    it("should build a POST request, base64-encoding the request body and generating correct signature", () => {
      const bodyPayload = { merchantId: "MERCHANT123", transactionId: "TX123", amount: 100 };
      const input = {
        endpoint: "/pg/v1/pay",
        options: {
          method: "POST" as const,
          body: bodyPayload,
        },
        authToken: { token: "MERCHANT123:saltKeyValue:2" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay");
      expect(built.method).toBe("POST");
      expect(built.headers["Content-Type"]).toBe("application/json");

      // Verify body is {"request": base64Request}
      const expectedBase64 = Buffer.from(JSON.stringify(bodyPayload)).toString("base64");
      expect(built.body).toBe(JSON.stringify({ request: expectedBase64 }));

      // Verify POST X-VERIFY calculation: sha256(base64Request + endpoint + saltKey) + "###" + saltIndex
      const expectedSignaturePayload = `${expectedBase64}/pg/v1/paysaltKeyValue`;

      const expectedHash = createHash("sha256").update(expectedSignaturePayload).digest("hex");
      expect(built.headers["X-VERIFY"]).toBe(`${expectedHash}###2`);
    });
  });

  // ─── parseResponse ────────────────────────────────────────────────────────────
  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": "999",
          "X-RateLimit-Reset": "1700000000",
        }),
        body: {
          success: true,
          code: "SUCCESS",
          message: "Request completed",
          data: { state: "COMPLETED" },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "phonepe");
      expect(normalized.meta.rateLimit.limit).toBe(1000);
      expect(normalized.meta.rateLimit.remaining).toBe(999);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────
  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          success: false,
          code: "AUTHORIZATION_FAILED",
          message: "Authorization token invalid",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("phonepe");
      expect(error.message).toBe("Authorization token invalid");
    });

    it("should map 429 to rate_limit category", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "5" }),
        body: {
          success: false,
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 400 and 422 to validation category", () => {
      const raw = {
        status: 400,
        headers: new Headers(),
        body: {
          success: false,
          code: "BAD_REQUEST",
          message: "Invalid transaction reference",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("Invalid transaction reference");
    });

    it("should map 5xx to provider category", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: "Internal Server Error",
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
      expect(error.message).toBe("Internal Server Error");
    });
  });

  // ─── authStrategy ─────────────────────────────────────────────────────────────
  describe("authStrategy", () => {
    it("should parse configuration parameters and format compound token", async () => {
      const config: AuthConfig = {
        clientId: "merchant123",
        apiKey: "saltKeyValue",
        password: "2",
      };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("merchant123:saltKeyValue:2");
    });

    it("should throw auth MeridianError if credentials are missing", async () => {
      const config: AuthConfig = {
        clientId: "merchant123",
      };
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────
  describe("verifyWebhook", () => {
    const secret = "saltKeySecret";
    const base64Response = Buffer.from(JSON.stringify({ state: "COMPLETED" })).toString("base64");

    it("should return true for a valid webhook signature when passed payload as an object", () => {
      const expectedHmac = createHash("sha256")
        .update(base64Response + secret)
        .digest("hex");
      const signature = `${expectedHmac}###1`;

      const payload = { response: base64Response };

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return true when payload is passed as a raw base64 string", () => {
      const expectedHmac = createHash("sha256")
        .update(base64Response + secret)
        .digest("hex");
      const signature = `${expectedHmac}###1`;

      expect(adapter.verifyWebhook(base64Response, signature, secret)).toBe(true);
    });

    it("should return false for incorrect signature", () => {
      const signature = "incorrectHmac###1";
      expect(adapter.verifyWebhook(base64Response, signature, secret)).toBe(false);
    });
  });
});
