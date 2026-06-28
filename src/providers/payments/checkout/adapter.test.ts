import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { CheckoutAdapter } from "./adapter.js";

describe("Checkout.com Adapter - Contract Tests", () => {
  const adapter = new CheckoutAdapter("https://api.checkout.com");

  describe("buildRequest", () => {
    it("should build a GET request with Bearer auth", () => {
      const input = {
        endpoint: "/payments",
        options: { method: "GET" as const, query: { limit: "10" } },
        authToken: { token: "sk_test_abc123" },
      };
      const built = adapter.buildRequest(input);
      expect(built.url).toBe("https://api.checkout.com/payments?limit=10");
      expect(built.headers.Authorization).toBe("Bearer sk_test_abc123");
      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should JSON-encode body for POST", () => {
      const input = {
        endpoint: "/payments",
        options: { method: "POST" as const, body: { amount: 1000, currency: "USD" } },
        authToken: { token: "sk_test_abc123" },
      };
      const built = adapter.buildRequest(input);
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({ "Cko-RateLimit-Limit": "400", "Cko-RateLimit-Remaining": "399" }),
        body: { id: "pay_123", status: "Authorized" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("checkout");
      expect(normalized.meta.rateLimit.limit).toBe(400);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { message: "Unauthorized" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "5" }),
        body: { message: "Too Many Requests" },
      });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map 5xx to provider", () => {
      const error = adapter.parseError({
        status: 500,
        headers: new Headers(),
        body: "Server Error",
      });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors", () => {
      const error = adapter.parseError(new Error("fetch failed"));
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });
  });

  describe("authStrategy", () => {
    it("should accept apiKey", async () => {
      const config: AuthConfig = { apiKey: "sk_test_abc123" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("sk_test_abc123");
    });

    it("should throw if no key provided", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });
  });

  describe("verifyWebhook", () => {
    const secret = "webhook_secret";
    const payload = JSON.stringify({ type: "payment_approved", id: "pay_123" });

    it("should return true for a valid HMAC-SHA256 signature", () => {
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for invalid signature", () => {
      expect(adapter.verifyWebhook(payload, "badsig", secret)).toBe(false);
    });
  });
});
