
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { PayuAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("PayuAdapter - Contract Tests", () => {
  const adapter = new PayuAdapter("https://info.payu.in");

  describe("buildRequest", () => {
    it("should set Basic auth header from key:salt token", () => {
      const built = adapter.buildRequest({
        endpoint: "/merchant/postservice",
        options: { method: "POST" },
        authToken: { token: "test_key:test_salt" },
      });
      expect(built.headers["Authorization"]).toMatch(/^Basic /);
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/merchant/postservice",
        options: { method: "GET", query: { form: "2" } },
        authToken: { token: "k:s" },
      });
      expect(built.url).toContain("form=2");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/merchant/postservice",
        options: { method: "POST", body: { txnid: "t123", amount: "500" } },
        authToken: { token: "k:s" },
      });
      expect(built.body).toBe('{"txnid":"t123","amount":"500"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/merchant/postservice",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "k:s" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { status: "success", txnid: "t123" } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("payu");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { status: 0, msg: "Invalid key" } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("payu");
    });

    it("should map 403 to auth category", () => {
      expect(adapter.parseError({ status: 403, headers: new Headers(), body: {} }).category).toBe("auth");
    });

    it("should map 404 to validation category", () => {
      expect(adapter.parseError({ status: 404, headers: new Headers(), body: {} }).category).toBe("validation");
    });

    it("should map 429 to rate_limit category", () => {
      const error = adapter.parseError({ status: 429, headers: new Headers({ "Retry-After": "60" }), body: {} });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map 500 to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      const error = adapter.parseError(new Error("network timeout"));
      expect(error.category).toBe("network");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" }, { status: 403, expected: "auth" },
        { status: 404, expected: "validation" }, { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" }, { status: 500, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(expected);
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should return sensible defaults", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });
  });

  describe("authStrategy", () => {
    it("should accept username + password (key + salt)", async () => {
      const token = await adapter.authStrategy({ username: "test_key", password: "test_salt" });
      expect(token.token).toContain("test_key");
      expect(token.token).toContain("test_salt");
    });

    it("should throw MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try {
        await adapter.authStrategy({});
      } catch (err) {
        expect((err as MeridianError).category).toBe("auth");
      }
    });
  });

  describe("paginationStrategy + getIdempotencyConfig", () => {
    it("should return a valid pagination strategy", () => {
      const s = adapter.paginationStrategy();
      expect(s).toHaveProperty("extractCursor");
      expect(s).toHaveProperty("hasNext");
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid signature", () => {
      const secret = "test_salt";
      const payload = "txnid|amount|productinfo|firstname|email";
      const signature = createHmac("sha512", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for wrong secret", () => {
      const payload = "some_payload";
      const sig = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, sig, "wrong")).toBe(false);
    });
  });
});
