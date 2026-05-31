
import { describe, it, expect } from "vitest";
import { JuspayAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("JuspayAdapter - Contract Tests", () => {
  const adapter = new JuspayAdapter("https://api.juspay.in");
  const encodedToken = Buffer.from("test_api_key:").toString("base64");

  describe("buildRequest", () => {
    it("should set Basic auth header", () => {
      const built = adapter.buildRequest({
        endpoint: "/orders",
        options: { method: "GET" },
        authToken: { token: encodedToken },
      });
      expect(built.headers["Authorization"]).toBe(`Basic ${encodedToken}`);
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/orders",
        options: { method: "GET", query: { count: 10 } },
        authToken: { token: encodedToken },
      });
      expect(built.url).toContain("count=10");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/orders",
        options: { method: "POST", body: { order_id: "ord_123", amount: 5000 } },
        authToken: { token: encodedToken },
      });
      expect(built.body).toBe('{"order_id":"ord_123","amount":5000}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/orders",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: encodedToken },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { order_id: "ord_123", status: "CREATED" } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("juspay");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { error_code: "JP_001", error_message: "Auth failed" } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("juspay");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" }, { status: 403, expected: "auth" },
        { status: 404, expected: "validation" }, { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" }, { status: 500, expected: "provider" },
        { status: 503, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(expected);
      }
    });

    it("should map network errors to network category", () => {
      const error = adapter.parseError(new Error("econnreset"));
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });

    it("should not leak provider-specific fields on the error", () => {
      const error = adapter.parseError({ status: 400, headers: new Headers(), body: { internal: "leak" } });
      expect((error as any).internal).toBeUndefined();
      expect((error as any).body).toBeUndefined();
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
    it("should accept apiKey and return base64-encoded token", async () => {
      const token = await adapter.authStrategy({ apiKey: "test_api_key" });
      expect(token.token).toBe(encodedToken);
    });

    it("should throw MeridianError for missing apiKey", async () => {
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
      expect(s).toHaveProperty("buildNextRequest");
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });
});
