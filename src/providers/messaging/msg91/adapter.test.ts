import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../../core/types.js";
import { Msg91Adapter } from "./adapter.js";

describe("Msg91Adapter - Contract Tests", () => {
  const adapter = new Msg91Adapter("https://api.msg91.com");

  describe("buildRequest", () => {
    it("should set authkey header", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v5/flow",
        options: { method: "POST" },
        authToken: { token: "test_auth_key" },
      });
      expect(built.headers.authkey).toBe("test_auth_key");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v5/flow",
        options: { method: "GET", query: { type: "1" } },
        authToken: { token: "key" },
      });
      expect(built.url).toContain("type=1");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v5/flow",
        options: { method: "POST", body: { template_id: "tpl_123", mobiles: "919999999999" } },
        authToken: { token: "key" },
      });
      expect(built.body).toBe('{"template_id":"tpl_123","mobiles":"919999999999"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/api/v5/flow",
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
        body: { message: "3", type: "success" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("msg91");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { message: "Authentication failed", type: "error" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("msg91");
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
      const error = adapter.parseError(new Error("etimedout"));
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
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
    it("should accept apiKey", async () => {
      const token = await adapter.authStrategy({ apiKey: "test_key" });
      expect(token.token).toBe("test_key");
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
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });
});
