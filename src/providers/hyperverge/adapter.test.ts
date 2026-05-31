import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { HyperVergeAdapter } from "./adapter.js";

describe("HyperVergeAdapter - Contract Tests", () => {
  const adapter = new HyperVergeAdapter("https://ind.hyperverge.co");
  const token = "test_app_id|test_app_key";

  describe("buildRequest", () => {
    it("should set appid and appkey headers from pipe-encoded token", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/readId",
        options: { method: "POST" },
        authToken: { token },
      });
      expect(built.headers.appid).toBe("test_app_id");
      expect(built.headers.appkey).toBe("test_app_key");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/readId",
        options: { method: "GET", query: { type: "ind_pan" } },
        authToken: { token },
      });
      expect(built.url).toContain("type=ind_pan");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/readId",
        options: { method: "POST", body: { document: { type: "ind_pan" } } },
        authToken: { token },
      });
      expect(built.body).toContain('"type":"ind_pan"');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/readId",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { status: "success", result: {} },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("hyperverge");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: "failure", statusCode: 401, error: "UNAUTHORIZED" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("hyperverge");
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
      expect(adapter.parseError(new Error("econnreset")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept appId + appKey via custom", async () => {
      const t = await adapter.authStrategy({
        custom: { appId: "test_app_id", appKey: "test_app_key" },
      });
      expect(t.token).toBe("test_app_id|test_app_key");
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
