
import { describe, it, expect } from "vitest";
import { KarzaAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("KarzaAdapter - Contract Tests", () => {
  const adapter = new KarzaAdapter("https://api.karza.in");

  describe("buildRequest", () => {
    it("should set x-karza-key header", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/pan/verify",
        options: { method: "POST" },
        authToken: { token: "test_api_key" },
      });
      expect(built.headers["x-karza-key"]).toBe("test_api_key");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/pan/verify",
        options: { method: "GET", query: { consent: "Y" } },
        authToken: { token: "key" },
      });
      expect(built.url).toContain("consent=Y");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/pan/verify",
        options: { method: "POST", body: { pan: "ABCDE1234F", consent: "Y" } },
        authToken: { token: "key" },
      });
      expect(built.body).toContain('"pan":"ABCDE1234F"');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/pan/verify",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "key" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { statusCode: 101, result: {} } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("karza");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { status: 401, error: "Unauthorized access" } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("karza");
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
      expect(adapter.parseError(new Error("econnreset")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept apiKey", async () => {
      const t = await adapter.authStrategy({ apiKey: "test_key" });
      expect(t.token).toBe("test_key");
    });

    it("should throw MeridianError for missing apiKey", async () => {
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
