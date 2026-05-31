import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { DelhiveryAdapter } from "./adapter.js";

describe("DelhiveryAdapter - Contract Tests", () => {
  const adapter = new DelhiveryAdapter("https://track.delhivery.com");

  describe("buildRequest", () => {
    it("should set auth header from token", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v1/packages/json/",
        options: { method: "GET" },
        authToken: { token: "test_token" },
      });
      expect(built.headers.Authorization).toMatch(/test_token/);
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v1/packages/json/",
        options: { method: "GET", query: { waybill: "1234567890" } },
        authToken: { token: "tok" },
      });
      expect(built.url).toContain("waybill=1234567890");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/backend/clientwarehouse/create/",
        options: { method: "POST", body: { format: "json", data: { shipments: [] } } },
        authToken: { token: "tok" },
      });
      expect(built.body).toContain('"format":"json"');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v1/packages/json/",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "tok" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { ShipmentData: [] } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("delhivery");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { error: "Auth failed." },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("delhivery");
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
      expect(adapter.parseError(new Error("network error")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept token or apiKey", async () => {
      const t = await adapter.authStrategy({ token: "test_token" });
      expect(t.token).toBe("test_token");
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
