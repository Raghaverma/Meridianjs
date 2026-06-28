import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../../core/types.js";
import { CashfreeAdapter } from "./adapter.js";

describe("CashfreeAdapter - Contract Tests", () => {
  const adapter = new CashfreeAdapter("https://api.cashfree.com");

  describe("buildRequest", () => {
    it("should set x-client-id and x-client-secret headers from token", () => {
      const built = adapter.buildRequest({
        endpoint: "/pg/orders",
        options: { method: "GET" },
        authToken: { token: "test_id:test_secret" },
      });

      expect(built.headers["x-client-id"]).toBe("test_id");
      expect(built.headers["x-client-secret"]).toBe("test_secret");
      expect(built.headers["x-api-version"]).toBeDefined();
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/pg/orders",
        options: { method: "GET", query: { limit: 10 } },
        authToken: { token: "id:secret" },
      });
      expect(built.url).toContain("limit=10");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/pg/orders",
        options: { method: "POST", body: { order_amount: 100, order_currency: "INR" } },
        authToken: { token: "id:secret" },
      });
      expect(built.body).toBe('{"order_amount":100,"order_currency":"INR"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/pg/orders",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "id:secret" },
      });
      expect(built.body).toBeUndefined();
    });

    it("should set x-idempotency-key when provided", () => {
      const built = adapter.buildRequest({
        endpoint: "/pg/orders",
        options: { method: "POST", idempotencyKey: "order-key-123" },
        authToken: { token: "id:secret" },
      });
      expect(built.headers["x-idempotency-key"]).toBe("order-key-123");
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { cf_order_id: "123", order_status: "ACTIVE" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized).toHaveProperty("data");
      expect(normalized.meta.provider).toBe("cashfree");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { message: "Unauthorized", code: "UNAUTHORIZED", type: "AUTH" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("cashfree");
    });

    it("should map 403 to auth category", () => {
      const error = adapter.parseError({ status: 403, headers: new Headers(), body: {} });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map 404 to validation category", () => {
      const error = adapter.parseError({ status: 404, headers: new Headers(), body: {} });
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 400 to validation category", () => {
      const error = adapter.parseError({ status: 400, headers: new Headers(), body: {} });
      expect(error.category).toBe("validation");
    });

    it("should map 429 to rate_limit category", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: {},
      });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map 500 to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      const error = adapter.parseError(new Error("fetch failed"));
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
        { status: 503, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(
          expected,
        );
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should return sensible defaults when headers are absent", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });
  });

  describe("authStrategy", () => {
    it("should accept clientId + clientSecret via custom", async () => {
      const token = await adapter.authStrategy({
        custom: { clientId: "test_id", clientSecret: "test_secret" },
      });
      expect(token.token).toBe("test_id:test_secret");
    });

    it("should throw MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try {
        await adapter.authStrategy({});
      } catch (err) {
        expect((err as MeridianError).category).toBe("auth");
        expect((err as MeridianError).provider).toBe("cashfree");
      }
    });
  });

  describe("paginationStrategy", () => {
    it("should return a strategy with all required methods", () => {
      const s = adapter.paginationStrategy();
      expect(s).toHaveProperty("extractCursor");
      expect(s).toHaveProperty("hasNext");
      expect(s).toHaveProperty("buildNextRequest");
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET/HEAD/OPTIONS as safe", () => {
      const config = adapter.getIdempotencyConfig();
      expect(config.defaultSafeOperations.has("GET")).toBe(true);
      expect(config.defaultSafeOperations.has("POST")).toBe(false);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const secret = "webhook_secret";
      const payload = JSON.stringify({ type: "PAYMENT_SUCCESS" });
      const signature = createHmac("sha256", secret).update(payload).digest("base64");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a tampered payload", () => {
      const secret = "webhook_secret";
      const signature = createHmac("sha256", secret).update("original").digest("hex");
      expect(adapter.verifyWebhook("tampered", signature, secret)).toBe(false);
    });

    it("should return false for wrong secret", () => {
      const payload = "payload";
      const signature = createHmac("sha256", "real_secret").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, "wrong_secret")).toBe(false);
    });
  });
});
