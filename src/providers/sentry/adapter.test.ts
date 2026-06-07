import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { SentryAdapter } from "./adapter.js";

describe("SentryAdapter - Contract Tests", () => {
  const adapter = new SentryAdapter("https://sentry.io/api/0/");

  describe("buildRequest", () => {
    it("should set Bearer auth header from the auth token", () => {
      const built = adapter.buildRequest({
        endpoint: "organizations/acme/issues/",
        options: { method: "GET" },
        authToken: { token: "sntrys_test_token" },
      });
      expect(built.headers.Authorization).toBe("Bearer sntrys_test_token");
    });

    it("should append query params to the URL", () => {
      const built = adapter.buildRequest({
        endpoint: "organizations/acme/issues/",
        options: { method: "GET", query: { query: "is:unresolved", cursor: "100:0:0" } },
        authToken: { token: "t" },
      });
      expect(built.url).toContain("cursor=100%3A0%3A0");
      expect(built.url).toContain("query=is%3Aunresolved");
    });

    it("should serialize JSON bodies for unsafe methods", () => {
      const built = adapter.buildRequest({
        endpoint: "organizations/acme/issues/1/",
        options: { method: "PUT", body: { status: "resolved" } },
        authToken: { token: "t" },
      });
      expect(built.body).toBe('{"status":"resolved"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include a body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "organizations/acme/issues/",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "t" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: [{ id: "1", title: "TypeError" }],
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("sentry");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { detail: "Invalid token" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("sentry");
    });

    it("should map 403 to auth category", () => {
      expect(adapter.parseError({ status: 403, headers: new Headers(), body: {} }).category).toBe(
        "auth",
      );
    });

    it("should map 404 to validation category", () => {
      expect(adapter.parseError({ status: 404, headers: new Headers(), body: {} }).category).toBe(
        "validation",
      );
    });

    it("should map 429 to rate_limit category and extract Retry-After", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: { detail: "rate limited" },
      });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 500 to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("getaddrinfo ENOTFOUND")).category).toBe("network");
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
  });

  describe("authStrategy", () => {
    it("should accept a token via auth.token", async () => {
      const token = await adapter.authStrategy({ token: "sntrys_abc" });
      expect(token.token).toBe("sntrys_abc");
    });

    it("should fall back to auth.apiKey", async () => {
      const token = await adapter.authStrategy({ apiKey: "sntrys_def" });
      expect(token.token).toBe("sntrys_def");
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

  describe("rateLimitPolicy", () => {
    it("should parse Sentry rate-limit headers", () => {
      const rl = adapter.rateLimitPolicy(
        new Headers({
          "X-Sentry-Rate-Limit-Limit": "40",
          "X-Sentry-Rate-Limit-Remaining": "39",
          "X-Sentry-Rate-Limit-Reset": String(Math.floor(Date.now() / 1000) + 60),
        }),
      );
      expect(rl.limit).toBe(40);
      expect(rl.remaining).toBe(39);
      expect(rl.reset).toBeInstanceOf(Date);
    });

    it("should return sensible defaults without headers", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });
  });

  describe("paginationStrategy (Link-header cursor pagination)", () => {
    it("should extract the next cursor from the Link header", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          Link:
            '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:0>; rel="previous"; results="false"; cursor="0:0:0", ' +
            '<https://sentry.io/api/0/organizations/acme/issues/?cursor=100:0:0>; rel="next"; results="true"; cursor="100:0:0"',
        }),
        body: [],
      };
      expect(strategy.extractCursor(raw)).toBe("100:0:0");
      expect(strategy.hasNext(raw)).toBe(true);
    });

    it("should report no next page when results=false", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          Link: '<https://sentry.io/api/0/x/?cursor=0:0:0>; rel="next"; results="false"; cursor="0:0:0"',
        }),
        body: [],
      };
      expect(strategy.hasNext(raw)).toBe(false);
    });

    it("should report no next page without a Link header", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = { status: 200, headers: new Headers(), body: [] };
      expect(strategy.extractCursor(raw)).toBeNull();
      expect(strategy.hasNext(raw)).toBe(false);
    });

    it("should build the next request using the cursor query param", () => {
      const strategy = adapter.paginationStrategy();
      const next = strategy.buildNextRequest(
        "organizations/acme/issues/",
        { method: "GET" },
        "100:0:0",
      );
      expect(next.options.query?.cursor).toBe("100:0:0");
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const secret = "client_secret";
      const payload = JSON.stringify({ action: "created", data: {} });
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong secret", () => {
      const payload = "raw-body";
      const signature = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, "wrong")).toBe(false);
    });
  });
});
