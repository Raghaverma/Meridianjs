import { describe, expect, it } from "vitest";
import type { AuthConfig, NormalizedResponse, RawResponse } from "../../core/types.js";
import { ApolloAdapter } from "./adapter.js";

describe("Apollo Adapter - Contract Tests", () => {
  const adapter = new ApolloAdapter();

  describe("buildRequest", () => {
    it("should build request with correct structure", () => {
      const input = {
        endpoint: "/contacts/search",
        options: {
          method: "POST" as const,
          query: { page: "1" },
          body: { q_keywords: "developer" },
        },
        authToken: { token: "test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built).toMatchObject({
        url: expect.stringContaining("/contacts/search"),
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
      });
      expect(built.url).toContain("page=1");
      expect(built.body).toBe('{"q_keywords":"developer"}');
    });
  });

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize successful response with correct structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "x-rate-limit-minute": "200",
          "x-minute-requests-left": "199",
        }),
        body: {
          contacts: [{ id: "123" }],
          pagination: {
            page: 1,
            per_page: 10,
            total_entries: 25,
            total_pages: 3,
          },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "apollo");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toMatchObject({
        limit: 200,
        remaining: 199,
      });
      expect(normalized.meta.pagination).toMatchObject({
        hasNext: true,
        cursor: "2",
        total: 25,
      });
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Unauthorized",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("apollo");
    });

    it("should map 429 to rate_limit category", () => {
      const raw = {
        status: 429,
        headers: new Headers({
          "Retry-After": "30",
        }),
        body: {
          message: "Rate limit exceeded",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: "Not Found",
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 500 to provider category", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          error: "Internal Server Error",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });
  });

  describe("rateLimitPolicy", () => {
    it("should extract rate limits correctly", () => {
      const headers = new Headers({
        "x-rate-limit-minute": "150",
        "x-minute-requests-left": "75",
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 150,
        remaining: 75,
        reset: expect.any(Date),
      });
    });

    it("should fallback when headers are missing", () => {
      const headers = new Headers();
      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 100,
        remaining: 100,
      });
    });
  });

  describe("authStrategy", () => {
    it("should return token for valid config", async () => {
      const config: AuthConfig = { apiKey: "test-api-key" };
      const token = await adapter.authStrategy(config);
      expect(token).toMatchObject({ token: "test-api-key" });
    });

    it("should throw error for missing config", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });
});
