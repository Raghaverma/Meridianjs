import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { AnthropicAdapter } from "./adapter.js";

describe("Anthropic Adapter - Contract Tests", () => {
  const adapter = new AnthropicAdapter("https://api.anthropic.com");

  describe("buildRequest", () => {
    it("should build request with x-api-key auth header (not Bearer)", () => {
      const input = {
        endpoint: "/v1/messages",
        options: {
          method: "POST" as const,
        },
        authToken: { token: "sk-ant-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["x-api-key"]).toBe("sk-ant-test-token");
      expect(built.headers.Authorization).toBeUndefined();
    });

    it("should include anthropic-version header", () => {
      const input = {
        endpoint: "/v1/messages",
        options: { method: "POST" as const },
        authToken: { token: "sk-ant-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("should build request with correct url and query params", () => {
      const input = {
        endpoint: "/v1/messages",
        options: {
          method: "GET" as const,
          query: { limit: "10" },
        },
        authToken: { token: "sk-ant-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toContain("/v1/messages");
      expect(built.url).toContain("limit=10");
      expect(built.method).toBe("GET");
    });

    it("should serialize body for POST requests", () => {
      const input = {
        endpoint: "/v1/messages",
        options: {
          method: "POST" as const,
          body: { model: "claude-3-opus-20240229", max_tokens: 1024 },
        },
        authToken: { token: "sk-ant-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBe('{"model":"claude-3-opus-20240229","max_tokens":1024}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should add X-Idempotency-Key when idempotencyKey provided", () => {
      const input = {
        endpoint: "/v1/messages",
        options: {
          method: "POST" as const,
          idempotencyKey: "idem-key-abc",
        },
        authToken: { token: "sk-ant-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["X-Idempotency-Key"]).toBe("idem-key-abc");
    });
  });

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize successful response with correct structure", () => {
      // Use a fixed past ISO string so the adapter parses it deterministically
      const fixedResetTime = "2099-01-01T00:00:00.000Z";
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "anthropic-ratelimit-requests-limit": "1000",
          "anthropic-ratelimit-requests-remaining": "999",
          "anthropic-ratelimit-requests-reset": fixedResetTime,
        }),
        body: { id: "msg_01abc", type: "message", content: [] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "anthropic");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit", 1000);
      expect(normalized.meta.rateLimit).toHaveProperty("remaining", 999);
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);

      const snapshotNormalized = {
        ...normalized,
        meta: {
          ...normalized.meta,
          requestId: "test-request-id",
          rateLimit: {
            limit: normalized.meta.rateLimit.limit,
            remaining: normalized.meta.rateLimit.remaining,
            reset: new Date(fixedResetTime),
          },
        },
      };
      expect(snapshotNormalized).toMatchSnapshot();
    });

    it("should fall back to defaults when rate limit headers are missing", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { id: "msg_02xyz" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.provider).toBe("anthropic");
      expect(normalized.meta.rateLimit.limit).toBeGreaterThan(0);
      expect(normalized.meta.rateLimit.remaining).toBeGreaterThan(0);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("anthropic");
      expect(error.message).toBeTruthy();

      expect({
        category: error.category,
        retryable: error.retryable,
        provider: error.provider,
        message: error.message,
        hasMetadata: !!error.metadata,
      }).toMatchSnapshot();
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "permission_error", message: "Forbidden" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("anthropic");
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "not_found_error", message: "Not found" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 422 to validation category", () => {
      const raw = {
        status: 422,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "invalid_request_error", message: "Unprocessable entity" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category with retryable=true", () => {
      const raw = {
        status: 429,
        headers: new Headers({
          "Retry-After": "30",
        }),
        body: {
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limit exceeded" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 529 (Anthropic overloaded) to provider category with retryable=true", () => {
      const raw = {
        status: 529,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
      expect(error.provider).toBe("anthropic");
    });

    it("should map 500 to provider category with retryable=true", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "api_error", message: "Internal server error" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      const raw = new Error("fetch failed: network error");

      const error = adapter.parseError(raw);

      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });

    it("should NEVER leak Anthropic-specific error structures", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "authentication_error", message: "Bad key" },
          anthropic_specific_field: "should not appear",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBeDefined();
      expect(error.provider).toBe("anthropic");
      expect((error as any).anthropic_specific_field).toBeUndefined();
      expect((error as any).type).toBeUndefined();
    });
  });

  describe("rateLimitPolicy - Normalized Rate Limit Info", () => {
    it("should parse anthropic-ratelimit-* headers", () => {
      const resetTime = new Date(Date.now() + 3_600_000).toISOString();
      const headers = new Headers({
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "950",
        "anthropic-ratelimit-requests-reset": resetTime,
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 1000,
        remaining: 950,
        reset: expect.any(Date),
      });
      expect(rateLimit.reset.getTime()).toBeGreaterThan(Date.now());
    });

    it("should return defaults when rate limit headers are missing", () => {
      const headers = new Headers();

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
    });
  });

  describe("authStrategy", () => {
    it("should return token for valid config", async () => {
      const config: AuthConfig = { token: "sk-ant-valid-key" };

      const token = await adapter.authStrategy(config);

      expect(token).toMatchObject({
        token: "sk-ant-valid-key",
      });
    });

    it("should throw MeridianError with auth category for missing token", async () => {
      const config: AuthConfig = {};

      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const meridianError = error as MeridianError;
        expect(meridianError.category).toBe("auth");
        expect(meridianError.provider).toBe("anthropic");
      }
    });
  });

  describe("paginationStrategy", () => {
    it("should return pagination strategy instance", () => {
      const strategy = adapter.paginationStrategy();

      expect(strategy).toBeDefined();
      expect(strategy).toHaveProperty("extractCursor");
      expect(strategy).toHaveProperty("extractTotal");
      expect(strategy).toHaveProperty("hasNext");
      expect(strategy).toHaveProperty("buildNextRequest");
    });
  });

  describe("Contract Invariants", () => {
    it("should NEVER return raw Anthropic errors", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key" },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect((error as any).body).toBeUndefined();
      expect(typeof error.status).toBe("number");
    });

    it("should ALWAYS return canonical error categories", () => {
      const testCases = [
        { status: 401, expectedCategory: "auth" },
        { status: 403, expectedCategory: "auth" },
        { status: 404, expectedCategory: "validation" },
        { status: 422, expectedCategory: "validation" },
        { status: 429, expectedCategory: "rate_limit" },
        { status: 529, expectedCategory: "provider" },
        { status: 500, expectedCategory: "provider" },
      ];

      for (const testCase of testCases) {
        const raw = {
          status: testCase.status,
          headers: new Headers(),
          body: { type: "error", error: { type: "error", message: "Error" } },
        };

        const error = adapter.parseError(raw);
        expect(error.category).toBe(testCase.expectedCategory);
      }
    });

    it("should ALWAYS normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "anthropic-ratelimit-requests-limit": "1000",
          "anthropic-ratelimit-requests-remaining": "999",
          "anthropic-ratelimit-requests-reset": new Date(Date.now() + 60_000).toISOString(),
        }),
        body: { id: "msg_xyz", type: "message" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "anthropic");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
    });
  });

  describe("Vendor Change Simulation", () => {
    it("should handle changed Anthropic error shape gracefully", () => {
      // Simulate a hypothetical future API response format change
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          // New hypothetical structure
          code: "AUTH_FAILED",
          details: "Authentication failed",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should handle missing rate limit headers without throwing", () => {
      const headers = new Headers();

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
    });
  });
});
