
import { describe, it, expect } from "vitest";
import { SetuAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("SetuAdapter - Contract Tests", () => {
  const adapter = new SetuAdapter("https://prod.setu.co");

  describe("buildRequest", () => {
    it("should set Bearer auth header", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v2/payments/upi/paymentLink",
        options: { method: "POST" },
        authToken: { token: "test_bearer_token" },
      });
      expect(built.headers["Authorization"]).toBe("Bearer test_bearer_token");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v2/payments/upi/paymentLink",
        options: { method: "GET", query: { page: 1 } },
        authToken: { token: "tok" },
      });
      expect(built.url).toContain("page=1");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v2/payments/upi/paymentLink",
        options: { method: "POST", body: { amount: { value: 1000, currencyCode: "INR" } } },
        authToken: { token: "tok" },
      });
      expect(built.body).toContain('"value":1000');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v2/payments/upi/paymentLink",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "tok" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { status: "SUCCESS", data: {} } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("setu");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { code: "unauthorized", message: "Invalid token", traceId: "abc" } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("setu");
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

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("fetch failed")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept token or apiKey", async () => {
      const t = await adapter.authStrategy({ token: "test_token" });
      expect(t.token).toContain("test_token");
    });

    it("should throw MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try { await adapter.authStrategy({}); } catch (err) {
        expect((err as MeridianError).category).toBe("auth");
      }
    });
  });

  describe("paginationStrategy + getIdempotencyConfig", () => {
    it("should return a valid pagination strategy", () => {
      expect(adapter.paginationStrategy()).toHaveProperty("extractCursor");
    });
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });
});
