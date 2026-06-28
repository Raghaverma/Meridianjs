import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../../core/types.js";
import { HunterAdapter } from "./adapter.js";

describe("Hunter Adapter - Contract Tests", () => {
  const adapter = new HunterAdapter();

  describe("buildRequest", () => {
    it("should inject the api_key query parameter and preserve caller query", () => {
      const input = {
        endpoint: "/domain-search",
        options: {
          method: "GET" as const,
          query: { domain: "stripe.com", limit: 10 },
        },
        authToken: { token: "test-key" },
      };

      const built = adapter.buildRequest(input);

      expect(built.method).toBe("GET");
      const url = new URL(built.url);
      expect(url.pathname).toContain("/domain-search");
      expect(url.searchParams.get("api_key")).toBe("test-key");
      expect(url.searchParams.get("domain")).toBe("stripe.com");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(built.headers).toMatchObject({ Accept: "application/json" });
      // GET carries no body.
      expect(built.body).toBeUndefined();
    });

    it("should not let a caller override the api_key", () => {
      const built = adapter.buildRequest({
        endpoint: "/account",
        options: { method: "GET", query: { api_key: "attacker" } },
        authToken: { token: "real-key" },
      });
      expect(new URL(built.url).searchParams.get("api_key")).toBe("real-key");
    });

    it("should JSON-encode the body and set Content-Type for writes", () => {
      const built = adapter.buildRequest({
        endpoint: "/leads",
        options: { method: "POST", body: { email: "lead@example.com" } },
        authToken: { token: "test-key" },
      });
      expect(built.method).toBe("POST");
      expect(built.body).toBe('{"email":"lead@example.com"}');
      expect(built.headers).toMatchObject({ "Content-Type": "application/json" });
    });
  });

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize a domain-search response with offset pagination", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "15",
          "X-RateLimit-Remaining": "14",
        }),
        body: {
          data: { domain: "stripe.com", emails: [{ value: "a@stripe.com" }] },
          meta: { results: 35, limit: 10, offset: 0 },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized.meta).toHaveProperty("provider", "hunter");
      expect(normalized.meta.rateLimit).toMatchObject({ limit: 15, remaining: 14 });
      expect(normalized.meta.pagination).toMatchObject({
        hasNext: true,
        cursor: "10",
        total: 35,
      });
    });

    it("should report no next page once the window covers the total", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { data: {}, meta: { results: 8, limit: 10, offset: 0 } },
      };
      const normalized = adapter.parseResponse(raw);
      // The normalizer omits the pagination block entirely when there is no next page.
      expect(normalized.meta.pagination).toBeUndefined();
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth from Hunter's errors[] body", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { errors: [{ id: "unauthorized", code: 401, details: "Invalid API key." }] },
      });

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("hunter");
      expect(error.message).toBe("Invalid API key.");
    });

    it("should map 429 to a retryable rate_limit error", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: { errors: [{ id: "too_many_requests", code: 429, details: "Slow down." }] },
      });

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 422 to validation", () => {
      const error = adapter.parseError({
        status: 422,
        headers: new Headers(),
        body: { errors: [{ id: "invalid_email", code: 422, details: "Bad email." }] },
      });
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 500 to a retryable provider error", () => {
      const error = adapter.parseError({
        status: 500,
        headers: new Headers(),
        body: {},
      });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });
  });

  describe("rateLimitPolicy", () => {
    it("should read X-RateLimit headers when present", () => {
      const rateLimit = adapter.rateLimitPolicy(
        new Headers({ "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "12" }),
      );
      expect(rateLimit).toMatchObject({ limit: 50, remaining: 12, reset: expect.any(Date) });
    });

    it("should fall back to a numeric default when headers are absent", () => {
      const rateLimit = adapter.rateLimitPolicy(new Headers());
      expect(rateLimit.limit).toBe(15);
      expect(rateLimit.remaining).toBe(15);
      expect(rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("authStrategy", () => {
    it("should return a token for a valid api key", async () => {
      const config: AuthConfig = { apiKey: "test-api-key" };
      await expect(adapter.authStrategy(config)).resolves.toMatchObject({ token: "test-api-key" });
    });

    it("should reject when no key is provided", async () => {
      await expect(adapter.authStrategy({} as AuthConfig)).rejects.toThrow();
    });
  });
});
