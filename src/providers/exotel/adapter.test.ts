import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { ExotelAdapter } from "./adapter.js";

describe("ExotelAdapter - Contract Tests", () => {
  const adapter = new ExotelAdapter("https://api.exotel.com");
  const token = "test_sid:test_api_key";

  describe("buildRequest", () => {
    it("should set Basic auth header from SID:APIKey token", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/Accounts/test_sid/Calls",
        options: { method: "POST" },
        authToken: { token },
      });
      expect(built.headers.Authorization).toMatch(/^Basic /);
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/Accounts/test_sid/Calls",
        options: { method: "GET", query: { PageSize: 20 } },
        authToken: { token },
      });
      expect(built.url).toContain("PageSize=20");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/Accounts/test_sid/Calls",
        options: { method: "POST", body: { From: "0XXXXXXXXXX", To: "919999999999" } },
        authToken: { token },
      });
      expect(built.body).toBe('{"From":"0XXXXXXXXXX","To":"919999999999"}');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/Accounts/test_sid/Calls",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { Calls: [] } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("exotel");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { RestException: { Message: "Auth Failed", Code: "20003" } },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("exotel");
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
      const error = adapter.parseError(new Error("fetch failed"));
      expect(error.category).toBe("network");
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
    it("should accept SID + API key (username + password)", async () => {
      const t = await adapter.authStrategy({ username: "test_sid", password: "test_key" });
      expect(t.token).toContain("test_sid");
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
    const secret = "exotel_webhook_secret";
    const payload = '{"event":"call.completed","data":{}}';

    function hmacHex(s: string, p: string): string {
      return createHmac("sha256", s).update(p).digest("hex");
    }

    it("should return true for a valid HMAC-SHA256 hex signature", () => {
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong signature", () => {
      expect(adapter.verifyWebhook(payload, "badhex".padEnd(64, "0"), secret)).toBe(false);
    });

    it("should return false for a tampered payload", () => {
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(`${payload}tampered`, signature, secret)).toBe(false);
    });

    it("should work with Buffer payload", () => {
      const bufPayload = Buffer.from(payload);
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(bufPayload, signature, secret)).toBe(true);
    });
  });
});
