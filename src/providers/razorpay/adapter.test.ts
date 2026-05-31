import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { RazorpayAdapter } from "./adapter.js";

describe("Razorpay Adapter - Contract Tests", () => {
  const adapter = new RazorpayAdapter("https://api.razorpay.com");

  describe("buildRequest", () => {
    it("should build request with Basic auth header", () => {
      const input = {
        endpoint: "/v1/payments",
        options: { method: "GET" as const },
        authToken: { token: "key_id:key_secret" },
      };

      const built = adapter.buildRequest(input);

      expect(built).toMatchObject({
        url: expect.stringContaining("/v1/payments"),
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("key_id:key_secret").toString("base64")}`,
        }),
      });
    });

    it("should append query params to URL", () => {
      const input = {
        endpoint: "/v1/payments",
        options: {
          method: "GET" as const,
          query: { count: 10, skip: 0 },
        },
        authToken: { token: "key_id:key_secret" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toContain("count=10");
      expect(built.url).toContain("skip=0");
    });

    it("should serialize JSON body for POST requests", () => {
      const input = {
        endpoint: "/v1/orders",
        options: {
          method: "POST" as const,
          body: { amount: 50000, currency: "INR" },
        },
        authToken: { token: "key_id:key_secret" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBe('{"amount":50000,"currency":"INR"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should add X-Idempotency-Key header when provided", () => {
      const input = {
        endpoint: "/v1/orders",
        options: {
          method: "POST" as const,
          idempotencyKey: "unique-order-key-123",
        },
        authToken: { token: "key_id:key_secret" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["X-Idempotency-Key"]).toBe("unique-order-key-123");
    });

    it("should not include body for GET requests", () => {
      const input = {
        endpoint: "/v1/payments/pay_123",
        options: {
          method: "GET" as const,
          body: { should: "be ignored" },
        },
        authToken: { token: "key_id:key_secret" },
      };

      const built = adapter.buildRequest(input);

      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          entity: "collection",
          count: 2,
          items: [{ id: "pay_1" }, { id: "pay_2" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "razorpay");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination hasNext when items are returned", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          entity: "collection",
          count: 2,
          items: [{ id: "pay_1" }, { id: "pay_2" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination?.hasNext).toBe(true);
    });

    it("should report no next page when items array is empty", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { entity: "collection", count: 0, items: [] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination?.hasNext ?? false).toBe(false);
    });
  });

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Invalid key_id or key_secret",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("razorpay");
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Your account is not allowed to access this resource",
          },
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
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The id provided does not exist",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 400 to validation category", () => {
      const raw = {
        status: 400,
        headers: new Headers(),
        body: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "amount is required",
            field: "amount",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("amount is required");
    });

    it("should map 429 to rate_limit category with retryAfter", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Too many requests",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 500 to provider category and mark as retryable", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          error: {
            code: "SERVER_ERROR",
            description: "Internal server error",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map 502 to provider category and mark as retryable", () => {
      const raw = {
        status: 502,
        headers: new Headers(),
        body: {
          error: { code: "GATEWAY_ERROR", description: "Bad gateway" },
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

    it("should NOT expose raw Razorpay error body shape on the error object", () => {
      const raw = {
        status: 400,
        headers: new Headers(),
        body: {
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "Some validation issue",
            source: "business",
            step: "payment_initiation",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect((error as any).source).toBeUndefined();
      expect((error as any).step).toBeUndefined();
      expect((error as any).body).toBeUndefined();
      expect(error.provider).toBe("razorpay");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 400, expected: "validation" },
        { status: 422, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
        { status: 503, expected: "provider" },
      ] as const;

      for (const { status, expected } of cases) {
        const error = adapter.parseError({
          status,
          headers: new Headers(),
          body: { error: { code: "ERROR", description: "Error" } },
        });
        expect(error.category).toBe(expected);
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should return sensible defaults when headers are absent", () => {
      const rateLimit = adapter.rateLimitPolicy(new Headers());

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
      expect(rateLimit.limit).toBeGreaterThan(0);
    });

    it("should parse X-RateLimit headers when present", () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 60;
      const headers = new Headers({
        "X-RateLimit-Limit": "500",
        "X-RateLimit-Remaining": "499",
        "X-RateLimit-Reset": String(resetEpoch),
      });

      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit.limit).toBe(500);
      expect(rateLimit.remaining).toBe(499);
      expect(rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("authStrategy", () => {
    it("should accept username + password (key_id + key_secret)", async () => {
      const config: AuthConfig = {
        username: "rzp_live_key_id",
        password: "key_secret_value",
      };

      const token = await adapter.authStrategy(config);

      expect(token.token).toBe("rzp_live_key_id:key_secret_value");
    });

    it("should accept apiKey + custom.keySecret", async () => {
      const config: AuthConfig = {
        apiKey: "rzp_live_key_id",
        custom: { keySecret: "key_secret_value" },
      };

      const token = await adapter.authStrategy(config);

      expect(token.token).toBe("rzp_live_key_id:key_secret_value");
    });

    it("should throw MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};

      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (err) {
        const error = err as MeridianError;
        expect(error.category).toBe("auth");
        expect(error.provider).toBe("razorpay");
      }
    });

    it("should throw when key_id is present but key_secret is missing", async () => {
      const config: AuthConfig = { username: "rzp_live_key_id" };

      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  describe("paginationStrategy", () => {
    it("should return a strategy with all required methods", () => {
      const strategy = adapter.paginationStrategy();

      expect(strategy).toHaveProperty("extractCursor");
      expect(strategy).toHaveProperty("extractTotal");
      expect(strategy).toHaveProperty("hasNext");
      expect(strategy).toHaveProperty("buildNextRequest");
    });

    it("should extract cursor as item count", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { entity: "collection", count: 2, items: [{ id: "pay_1" }, { id: "pay_2" }] },
      };

      expect(strategy.extractCursor(raw)).toBe("2");
    });

    it("should return null cursor on empty items", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { entity: "collection", count: 0, items: [] },
      };

      expect(strategy.extractCursor(raw)).toBeNull();
    });

    it("should build next request by incrementing skip", () => {
      const strategy = adapter.paginationStrategy();
      const next = strategy.buildNextRequest(
        "/v1/payments",
        { method: "GET", query: { count: 10, skip: 0 } },
        "10",
      );

      expect(next.options.query?.skip).toBe(10);
    });

    it("should accumulate skip across multiple pages", () => {
      const strategy = adapter.paginationStrategy();

      const page2 = strategy.buildNextRequest(
        "/v1/payments",
        { method: "GET", query: { count: 10, skip: 0 } },
        "10",
      );
      const page3 = strategy.buildNextRequest("/v1/payments", page2.options, "10");

      expect(page3.options.query?.skip).toBe(20);
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET/HEAD/OPTIONS as safe", () => {
      const config = adapter.getIdempotencyConfig();

      expect(config.defaultSafeOperations.has("GET")).toBe(true);
      expect(config.defaultSafeOperations.has("HEAD")).toBe(true);
      expect(config.defaultSafeOperations.has("OPTIONS")).toBe(true);
    });

    it("should mark key write operations as CONDITIONAL", () => {
      const config = adapter.getIdempotencyConfig();

      expect(config.operationOverrides.has("POST /v1/orders")).toBe(true);
      expect(config.operationOverrides.has("POST /v1/refunds")).toBe(true);
    });
  });
});
