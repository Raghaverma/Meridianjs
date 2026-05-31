
import { describe, it, expect } from "vitest";
import { MapmyindiaAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("MapmyindiaAdapter - Contract Tests", () => {
  const adapter = new MapmyindiaAdapter("https://atlas.mapmyindia.com");

  describe("buildRequest", () => {
    it("should set Bearer auth header", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/places/geocode",
        options: { method: "GET" },
        authToken: { token: "test_token" },
      });
      expect(built.headers["Authorization"]).toBe("Bearer test_token");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/places/geocode",
        options: { method: "GET", query: { address: "Connaught Place, New Delhi" } },
        authToken: { token: "tok" },
      });
      expect(built.url).toContain("address=");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/places/geocode",
        options: { method: "POST", body: { address: "Bangalore" } },
        authToken: { token: "tok" },
      });
      expect(built.body).toContain('"address":"Bangalore"');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/places/geocode",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "tok" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { results: [] } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("mapmyindia");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { error: "Unauthorized", message: "Invalid token" } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("mapmyindia");
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
      expect(adapter.parseError(new Error("enotfound")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept token or apiKey", async () => {
      const t = await adapter.authStrategy({ token: "test_token" });
      expect(t.token).toBe("test_token");
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
