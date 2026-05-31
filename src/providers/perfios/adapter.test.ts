import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { PerfiosAdapter } from "./adapter.js";

describe("PerfiosAdapter - Contract Tests", () => {
  const adapter = new PerfiosAdapter("https://api.perfios.com");

  describe("buildRequest", () => {
    it("should set x-api-key header", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/transactions/create",
        options: { method: "POST" },
        authToken: { token: "test_api_key" },
      });
      expect(built.headers["x-api-key"]).toBe("test_api_key");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/transactions",
        options: { method: "GET", query: { page: 1, size: 20 } },
        authToken: { token: "key" },
      });
      expect(built.url).toContain("page=1");
      expect(built.url).toContain("size=20");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/transactions/create",
        options: { method: "POST", body: { txnId: "txn_123", type: "BANK_STATEMENT" } },
        authToken: { token: "key" },
      });
      expect(built.body).toContain('"txnId":"txn_123"');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/transactions",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "key" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { txnId: "txn_123", status: "INITIATED" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("perfios");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { error: "Unauthorized", message: "Invalid API key" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("perfios");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(
          expected,
        );
      }
    });

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("timeout")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept apiKey", async () => {
      const t = await adapter.authStrategy({ apiKey: "test_key" });
      expect(t.token).toBe("test_key");
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
      expect(adapter.paginationStrategy()).toHaveProperty("extractCursor");
    });
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });
});
