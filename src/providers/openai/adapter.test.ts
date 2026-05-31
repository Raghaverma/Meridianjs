import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { OpenAIAdapter } from "./adapter.js";

describe("OpenAI Adapter - Contract Tests", () => {
  const adapter = new OpenAIAdapter("https://api.openai.com");

  describe("buildRequest", () => {
    it("should build request with Authorization: Bearer header", () => {
      const input = {
        endpoint: "/v1/chat/completions",
        options: {
          method: "POST" as const,
        },
        authToken: { token: "sk-openai-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers.Authorization).toBe("Bearer sk-openai-test-token");
      expect(built.headers["x-api-key"]).toBeUndefined();
    });

    it("should build request with correct url and query params", () => {
      const input = {
        endpoint: "/v1/models",
        options: {
          method: "GET" as const,
          query: { limit: "20" },
        },
        authToken: { token: "sk-openai-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toContain("/v1/models");
      expect(built.url).toContain("limit=20");
      expect(built.method).toBe("GET");
    });

    it("should serialize body for POST requests", () => {
      const input = {
        endpoint: "/v1/chat/completions",
        options: {
          method: "POST" as const,
          body: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
        },
        authToken: { token: "sk-openai-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBe('{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should add Idempotency-Key header when idempotencyKey provided", () => {
      const input = {
        endpoint: "/v1/chat/completions",
        options: {
          method: "POST" as const,
          idempotencyKey: "idem-key-xyz",
        },
        authToken: { token: "sk-openai-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Idempotency-Key"]).toBe("idem-key-xyz");
    });

    it("should NOT include anthropic-version header", () => {
      const input = {
        endpoint: "/v1/models",
        options: { method: "GET" as const },
        authToken: { token: "sk-openai-test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["anthropic-version"]).toBeUndefined();
    });
  });

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize successful response with correct structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "x-ratelimit-limit-requests": "3500",
          "x-ratelimit-remaining-requests": "3499",
          "x-ratelimit-reset-requests": "6m0s",
        }),
        body: { id: "chatcmpl-abc", object: "chat.completion", choices: [] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "openai");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit", 3500);
      expect(normalized.meta.rateLimit).toHaveProperty("remaining", 3499);
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);

      // OpenAI reset is Date.now() + duration; pin to a sentinel for a stable snapshot
      const snapshotNormalized = {
        ...normalized,
        meta: {
          ...normalized.meta,
          requestId: "test-request-id",
          rateLimit: {
            limit: normalized.meta.rateLimit.limit,
            remaining: normalized.meta.rateLimit.remaining,
            reset: new Date("2099-01-01T00:00:00.000Z"),
          },
        },
      };
      expect(snapshotNormalized).toMatchSnapshot();
    });

    it("should fall back to defaults when rate limit headers are missing", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { id: "chatcmpl-xyz" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.provider).toBe("openai");
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
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("openai");
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
          error: {
            message: "You are not allowed to use this resource",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("openai");
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: {
          error: {
            message: "The model does not exist",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
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
          error: {
            message: "Unprocessable entity",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 (plain rate limit) to rate_limit with retryable=true", () => {
      const raw = {
        status: 429,
        headers: new Headers({
          "Retry-After": "60",
        }),
        body: {
          error: {
            message: "Rate limit reached for gpt-4",
            type: "requests",
            param: null,
            code: null,
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 429 with insufficient_quota to rate_limit with retryable=false", () => {
      const raw = {
        status: 429,
        headers: new Headers(),
        body: {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(false);
    });

    it("should map 500 to provider category with retryable=true", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          error: {
            message: "The server had an error processing your request",
            type: "server_error",
            param: null,
            code: null,
          },
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

    it("should NEVER leak OpenAI-specific error structures", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
            openai_specific_field: "should not appear",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBeDefined();
      expect(error.provider).toBe("openai");
      expect((error as any).openai_specific_field).toBeUndefined();
      expect((error as any).type).toBeUndefined();
    });
  });

  describe("rateLimitPolicy - Normalized Rate Limit Info", () => {
    it("should parse x-ratelimit-* headers with duration reset string", () => {
      const headers = new Headers({
        "x-ratelimit-limit-requests": "3500",
        "x-ratelimit-remaining-requests": "3490",
        "x-ratelimit-reset-requests": "6m0s",
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 3500,
        remaining: 3490,
        reset: expect.any(Date),
      });
      expect(rateLimit.reset.getTime()).toBeGreaterThan(Date.now());
    });

    it("should handle 1s duration reset string", () => {
      const headers = new Headers({
        "x-ratelimit-limit-requests": "3500",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1s",
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit.limit).toBe(3500);
      expect(rateLimit.remaining).toBe(0);
      expect(rateLimit.reset).toBeInstanceOf(Date);
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
      const config: AuthConfig = { token: "sk-openai-valid-key" };

      const token = await adapter.authStrategy(config);

      expect(token).toMatchObject({
        token: "sk-openai-valid-key",
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
        expect(meridianError.provider).toBe("openai");
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
    it("should NEVER return raw OpenAI errors", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
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
        { status: 500, expectedCategory: "provider" },
      ];

      for (const testCase of testCases) {
        const raw = {
          status: testCase.status,
          headers: new Headers(),
          body: { error: { message: "Error", type: "error", param: null, code: null } },
        };

        const error = adapter.parseError(raw);
        expect(error.category).toBe(testCase.expectedCategory);
      }
    });

    it("should ALWAYS normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "x-ratelimit-limit-requests": "3500",
          "x-ratelimit-remaining-requests": "3499",
          "x-ratelimit-reset-requests": "6m0s",
        }),
        body: { any: "data", structure: "here" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "openai");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
    });
  });

  describe("Vendor Change Simulation", () => {
    it("should handle changed OpenAI error shape gracefully", () => {
      // Simulate a hypothetical future API response format change
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          // New hypothetical structure without nested error
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
