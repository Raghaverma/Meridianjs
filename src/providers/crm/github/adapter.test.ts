import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { GitHubAdapter } from "./adapter.js";

describe("GitHub Adapter - Contract Tests", () => {
  const adapter = new GitHubAdapter("https://api.github.com");

  describe("buildRequest", () => {
    it("should build request with correct structure", () => {
      const input = {
        endpoint: "/users/octocat",
        options: {
          method: "GET" as const,
          query: { page: "1" },
        },
        authToken: { token: "test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built).toMatchObject({
        url: expect.stringContaining("/users/octocat"),
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github.v3+json",
        }),
      });
      expect(built.url).toContain("page=1");
    });

    it("should serialize body for POST requests", () => {
      const input = {
        endpoint: "/repos/owner/repo/issues",
        options: {
          method: "POST" as const,
          body: { title: "Test issue" },
        },
        authToken: { token: "test-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBe('{"title":"Test issue"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize successful response with correct structure", () => {
      const fixedTimestamp = 1700000000;
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(fixedTimestamp),
          Link: '<https://api.github.com/user/repos?page=2>; rel="next"',
        }),
        body: { id: 1, login: "octocat" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "github");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);

      const snapshotNormalized = {
        ...normalized,
        meta: {
          ...normalized.meta,
          requestId: "test-request-id",
          rateLimit: {
            ...normalized.meta.rateLimit,
            reset: new Date(fixedTimestamp * 1000),
          },
        },
      };
      expect(snapshotNormalized).toMatchSnapshot();
    });

    it("should extract pagination information correctly", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
          Link: '<https://api.github.com/user/repos?page=2>; rel="next"',
        }),
        body: [{ id: 1 }],
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe("2");
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Bad credentials",
          documentation_url: "https://docs.github.com",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("github");
      expect(error.message).toBeTruthy();

      expect({
        category: error.category,
        retryable: error.retryable,
        provider: error.provider,
        message: error.message,
        hasMetadata: !!error.metadata,
      }).toMatchSnapshot();
    });

    it("should map 403 with rate limit to rate_limit category", () => {
      const raw = {
        status: 403,
        headers: new Headers({
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
        }),
        body: {
          message: "API rate limit exceeded",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 403 without rate limit to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers({
          "X-RateLimit-Remaining": "100",
        }),
        body: {
          message: "Resource not accessible by integration",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: {
          message: "Not Found",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 422 to validation category with field errors", () => {
      const raw = {
        status: 422,
        headers: new Headers(),
        body: {
          message: "Validation Failed",
          errors: [{ field: "title", code: "missing", message: "Title is required" }],
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("Validation failed");
      expect(error.metadata?.fieldErrors).toBeDefined();
    });

    it("should map 429 to rate_limit category", () => {
      const raw = {
        status: 429,
        headers: new Headers({
          "Retry-After": "60",
        }),
        body: {
          message: "API rate limit exceeded",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 5xx to provider category", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          message: "Internal Server Error",
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

    it("should NEVER leak GitHub-specific error structures", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Bad credentials",
          documentation_url: "https://docs.github.com/rest",

          github_specific_field: "should not appear",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBeDefined();
      expect(error.provider).toBe("github");

      expect((error as any).documentation_url).toBeUndefined();
      expect((error as any).github_specific_field).toBeUndefined();

      if (error.metadata) {
        expect(error.metadata.githubMessage).toBeDefined();
      }
    });
  });

  describe("rateLimitPolicy - Normalized Rate Limit Info", () => {
    it("should extract rate limit from GitHub headers", () => {
      const headers = new Headers({
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "4999",
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: 5000,
        remaining: 4999,
        reset: expect.any(Date),
      });

      expect(rateLimit.reset.getTime()).toBeGreaterThan(Date.now());
    });

    it("should handle missing headers gracefully", () => {
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
      const config: AuthConfig = { token: "test-token" };

      const token = await adapter.authStrategy(config);

      expect(token).toMatchObject({
        token: "test-token",
      });
    });

    it("should throw MeridianError for missing token", async () => {
      const config: AuthConfig = {};

      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const meridianError = error as MeridianError;
        expect(meridianError.category).toBe("auth");
        expect(meridianError.provider).toBe("github");
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
    it("should NEVER return raw GitHub errors", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: { message: "Bad credentials" },
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
          body: { message: "Error" },
        };

        const error = adapter.parseError(raw);
        expect(error.category).toBe(testCase.expectedCategory);
      }
    });

    it("should ALWAYS normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
        }),
        body: { any: "data", structure: "here" },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "github");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
    });
  });

  describe("Vendor Change Simulation", () => {
    it("should handle GitHub API changes gracefully", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          error: {
            code: "AUTH_FAILED",
            message: "Authentication failed",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should handle missing rate limit headers", () => {
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
