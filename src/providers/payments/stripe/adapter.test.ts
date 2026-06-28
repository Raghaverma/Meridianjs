import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../../core/types.js";
import { StripeAdapter } from "./adapter.js";

describe("StripeAdapter - Contract Tests", () => {
  const adapter = new StripeAdapter("https://api.stripe.com");

  describe("buildRequest", () => {
    it("should build request with correct structure", () => {
      const input = {
        endpoint: "/v1/charges",
        options: {
          method: "GET" as const,
          query: { limit: "10" },
        },
        authToken: { token: "sk_test_abc123" },
      };

      const built = adapter.buildRequest(input);

      expect(built).toMatchObject({
        url: expect.stringContaining("/v1/charges"),
        method: "GET",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          "Stripe-Version": "2024-11-20.acacia",
        }),
      });
      expect(built.url).toContain("limit=10");
    });

    it("should serialize body for POST requests", () => {
      const input = {
        endpoint: "/v1/charges",
        options: {
          method: "POST" as const,
          body: { amount: 1000, currency: "usd" },
        },
        authToken: { token: "sk_test_abc123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBe('{"amount":1000,"currency":"usd"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/charges",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "sk_test_abc123" },
      });
      expect(built.body).toBeUndefined();
    });

    it("should set Idempotency-Key header when provided", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/charges",
        options: { method: "POST", idempotencyKey: "idem-key-123" },
        authToken: { token: "sk_test_abc123" },
      });
      expect(built.headers["Idempotency-Key"]).toBe("idem-key-123");
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response with correct structure", () => {
      const fixedTimestamp = 1700000000;
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "Stripe-Ratelimit-Limit": "100",
          "Stripe-Ratelimit-Remaining": "99",
        }),
        body: { id: "ch_123", object: "charge", amount: 1000 },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "stripe");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit", 100);
      expect(normalized.meta.rateLimit).toHaveProperty("remaining", 99);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);

      const snapshotNormalized = {
        ...normalized,
        meta: {
          ...normalized.meta,
          requestId: "test-request-id",
          rateLimit: {
            ...normalized.meta.rateLimit,
            reset: new Date(fixedTimestamp * 1000),
          },
        },
      };
      expect(snapshotNormalized).toMatchSnapshot();
    });

    it("should use default rate limit info when headers are missing", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { id: "ch_123" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.rateLimit.limit).toBeGreaterThan(0);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          error: {
            type: "invalid_request_error",
            message: "No such API key: sk_test_***",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("stripe");

      expect({
        category: error.category,
        retryable: error.retryable,
        provider: error.provider,
        message: error.message,
        hasMetadata: !!error.metadata,
      }).toMatchSnapshot();
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          error: {
            type: "invalid_request_error",
            message: "Permission denied.",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("stripe");
    });

    it("should map 402 (card declined) to validation category", () => {
      const raw = {
        status: 402,
        headers: new Headers(),
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Your card has insufficient funds.",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: { error: { type: "invalid_request_error", message: "No such charge: ch_xyz" } },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 409 to validation category", () => {
      const raw = {
        status: 409,
        headers: new Headers(),
        body: {
          error: {
            type: "idempotency_error",
            message: "Keys for idempotent requests can only be used once.",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 422 to validation category", () => {
      const raw = {
        status: 422,
        headers: new Headers(),
        body: { error: { type: "invalid_request_error", message: "Invalid parameter." } },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category with retryable=true", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: { error: { type: "rate_limit_error", message: "Too many requests." } },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 500 to provider category with retryable=true", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: { error: { type: "api_error", message: "An error occurred." } },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map 503 to provider category with retryable=true", () => {
      const raw = {
        status: 503,
        headers: new Headers(),
        body: { error: { type: "api_error", message: "Service temporarily unavailable." } },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      const error = adapter.parseError(new Error("fetch failed: network error"));

      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });

    it("should always return canonical error categories", () => {
      const testCases = [
        { status: 401, expectedCategory: "auth" },
        { status: 403, expectedCategory: "auth" },
        { status: 402, expectedCategory: "validation" },
        { status: 404, expectedCategory: "validation" },
        { status: 409, expectedCategory: "validation" },
        { status: 422, expectedCategory: "validation" },
        { status: 429, expectedCategory: "rate_limit" },
        { status: 500, expectedCategory: "provider" },
      ];

      for (const testCase of testCases) {
        const raw = {
          status: testCase.status,
          headers: new Headers(),
          body: { error: { type: "test_error", message: "Error" } },
        };

        const error = adapter.parseError(raw);
        expect(error.category).toBe(testCase.expectedCategory);
      }
    });
  });

  describe("authStrategy", () => {
    it("should accept config.apiKey", async () => {
      const config: AuthConfig = { apiKey: "sk_test_abc123" };

      const token = await adapter.authStrategy(config);

      expect(token).toMatchObject({ token: "sk_test_abc123" });
    });

    it("should accept config.token as fallback", async () => {
      const config: AuthConfig = { token: "sk_test_xyz" };

      const token = await adapter.authStrategy(config);

      expect(token).toMatchObject({ token: "sk_test_xyz" });
    });

    it("should throw MeridianError for missing credentials", async () => {
      const config: AuthConfig = {};

      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const meridianError = error as MeridianError;
        expect(meridianError.category).toBe("auth");
        expect(meridianError.provider).toBe("stripe");
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should parse Stripe-Ratelimit-Limit and Stripe-Ratelimit-Remaining headers", () => {
      const headers = new Headers({
        "Stripe-Ratelimit-Limit": "100",
        "Stripe-Ratelimit-Remaining": "75",
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 100,
        remaining: 75,
        reset: expect.any(Date),
      });
    });

    it("should return defaults when headers are missing", () => {
      const rateLimit = adapter.rateLimitPolicy(new Headers());

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
    });
  });

  describe("paginationStrategy", () => {
    it("should return a pagination strategy instance", () => {
      const strategy = adapter.paginationStrategy();

      expect(strategy).toBeDefined();
      expect(strategy).toHaveProperty("extractCursor");
      expect(strategy).toHaveProperty("hasNext");
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });

    it("should mark POST /v1/charges as CONDITIONAL", () => {
      const overrides = adapter.getIdempotencyConfig().operationOverrides;
      expect(overrides.has("POST /v1/charges")).toBe(true);
    });
  });

  describe("Contract Invariants", () => {
    it("should always return provider=stripe on errors", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: {} });
      expect(error.provider).toBe("stripe");
    });

    it("should always normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { id: "ch_123" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "stripe");
      expect(normalized.meta).toHaveProperty("rateLimit");
    });
  });

  describe("verifyWebhook", () => {
    const secret = "whsec_test_secret_key";
    const payload = '{"type":"payment_intent.succeeded","data":{"object":{}}}';

    function hmacHex(s: string, p: string): string {
      return createHmac("sha256", s).update(p).digest("hex");
    }

    it("should return true for a correct raw-hex signature", () => {
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong raw-hex signature", () => {
      expect(adapter.verifyWebhook(payload, "deadbeef".repeat(8), secret)).toBe(false);
    });

    it("should return true for a valid Stripe-Signature header (t=...,v1=... format)", () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signingPayload = `${timestamp}.${payload}`;
      const v1 = hmacHex(secret, signingPayload);
      const header = `t=${timestamp},v1=${v1}`;
      expect(adapter.verifyWebhook(payload, header, secret)).toBe(true);
    });

    it("should return false for a tampered payload with a valid Stripe-Signature header", () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signingPayload = `${timestamp}.${payload}`;
      const v1 = hmacHex(secret, signingPayload);
      const header = `t=${timestamp},v1=${v1}`;
      const tamperedPayload = `${payload}tampered`;
      expect(adapter.verifyWebhook(tamperedPayload, header, secret)).toBe(false);
    });

    it("should reject a replayed signature whose timestamp is outside the tolerance", () => {
      // A correctly-signed but stale event must not verify — otherwise a single
      // captured webhook can be replayed forever.
      const stale = "1700000000"; // Nov 2023
      const v1 = hmacHex(secret, `${stale}.${payload}`);
      const header = `t=${stale},v1=${v1}`;
      expect(adapter.verifyWebhook(payload, header, secret)).toBe(false);
      // ...but an explicit caller can widen the tolerance if they really mean to.
      expect(adapter.verifyWebhook(payload, header, secret, Number.POSITIVE_INFINITY)).toBe(true);
    });

    it("should return false for a Stripe-Signature header missing v1", () => {
      expect(adapter.verifyWebhook(payload, "t=1700000000", secret)).toBe(false);
    });

    it("should return false for an empty signature", () => {
      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });

    it("should work with Buffer payload", () => {
      const bufPayload = Buffer.from(payload);
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(bufPayload, signature, secret)).toBe(true);
    });
  });
});
