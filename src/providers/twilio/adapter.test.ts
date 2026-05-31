import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { TwilioAdapter } from "./adapter.js";
import { TwilioPaginationStrategy } from "./pagination.js";

describe("Twilio Adapter - Contract Tests", () => {
  const adapter = new TwilioAdapter("https://api.twilio.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with Basic auth and correct headers", () => {
      const input = {
        endpoint: "/2010-04-01/Accounts/AC123/Messages.json",
        options: { method: "GET" as const, query: { PageSize: "20" } },
        authToken: { token: "AC123:my-auth-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toContain("/2010-04-01/Accounts/AC123/Messages.json");
      expect(built.url).toContain("PageSize=20");
      expect(built.method).toBe("GET");

      const expectedCreds = Buffer.from("AC123:my-auth-token").toString("base64");
      expect(built.headers.Authorization).toBe(`Basic ${expectedCreds}`);
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should form-encode the body for POST requests and set Content-Type", () => {
      const input = {
        endpoint: "/2010-04-01/Accounts/AC123/Messages.json",
        options: {
          method: "POST" as const,
          body: { To: "+15005550006", From: "+15005550001", Body: "Hello world" },
        },
        authToken: { token: "AC123:my-auth-token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(built.body).toContain("To=%2B15005550006");
      expect(built.body).toContain("From=%2B15005550001");
      expect(built.body).toContain("Body=Hello+world");
    });

    it("should pass through a pre-encoded string body unchanged", () => {
      const input = {
        endpoint: "/2010-04-01/Accounts/AC123/Messages.json",
        options: {
          method: "POST" as const,
          body: "To=%2B15005550006&Body=test",
        },
        authToken: { token: "AC123:tok" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBe("To=%2B15005550006&Body=test");
      expect(built.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("should NOT include body for GET/HEAD requests", () => {
      const input = {
        endpoint: "/2010-04-01/Accounts/AC123/Messages.json",
        options: { method: "GET" as const, body: { foo: "bar" } },
        authToken: { token: "AC123:tok" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBeUndefined();
    });

    it("should include idempotency key header when provided", () => {
      const input = {
        endpoint: "/2010-04-01/Accounts/AC123/Messages.json",
        options: {
          method: "POST" as const,
          body: { To: "+1", From: "+2", Body: "x" },
          idempotencyKey: "idem-key-abc",
        },
        authToken: { token: "AC123:tok" },
      };

      const built = adapter.buildRequest(input);
      expect(built.headers["X-Idempotency-Key"]).toBe("idem-key-abc");
    });
  });

  // ─── parseResponse ────────────────────────────────────────────────────────────

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize a successful response with the correct structure", () => {
      const fixedTimestamp = 1700000000;
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({}),
        body: {
          messages: [{ sid: "SM123", body: "Hello" }],
          next_page_uri: null,
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "twilio");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);

      // Snapshot with deterministic values
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

    it("should extract pagination info from next_page_uri", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({}),
        body: {
          messages: [{ sid: "SM123" }],
          next_page_uri: "/2010-04-01/Accounts/AC123/Messages.json?Page=1&PageSize=20",
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toContain("Page=1");
    });

    it("should report hasNext=false when next_page_uri is absent", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({}),
        body: { messages: [], next_page_uri: null },
      };

      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.pagination?.hasNext ?? false).toBe(false);
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          code: 20003,
          message: "Authenticate",
          more_info: "https://www.twilio.com/docs/errors/20003",
          status: 401,
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("twilio");
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
        body: { code: 20004, message: "Forbidden", more_info: "", status: 403 },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map 404 to validation category", () => {
      const raw = {
        status: 404,
        headers: new Headers(),
        body: { code: 20404, message: "Resource not found", more_info: "", status: 404 },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category (retryable, parses Retry-After)", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: { code: 20429, message: "Too many requests", more_info: "", status: 429 },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 400 to validation category", () => {
      const raw = {
        status: 400,
        headers: new Headers(),
        body: { code: 21211, message: "Invalid phone number", more_info: "", status: 400 },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 422 to validation category", () => {
      const raw = {
        status: 422,
        headers: new Headers(),
        body: { code: 21610, message: "Message body required", more_info: "", status: 422 },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 5xx to provider category (retryable)", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: { code: 0, message: "Internal Server Error", more_info: "", status: 500 },
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

    it("should store twilioCode and twilioError in metadata and NOT leak raw body", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          code: 20003,
          message: "Authenticate",
          more_info: "https://www.twilio.com/docs/errors/20003",
          status: 401,
        },
      };

      const error = adapter.parseError(raw);

      expect((error as any).body).toBeUndefined();
      expect((error as any).more_info).toBeUndefined();
      if (error.metadata) {
        expect(error.metadata.twilioCode).toBe(20003);
        expect(error.metadata.twilioError).toBe("Authenticate");
      }
    });
  });

  // ─── authStrategy ─────────────────────────────────────────────────────────────

  describe("authStrategy", () => {
    it("should accept username + password and return combined token", async () => {
      const config: AuthConfig = { username: "ACsid", password: "authtoken" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("ACsid:authtoken");
    });

    it("should accept apiKey + custom.authToken and return combined token", async () => {
      const config: AuthConfig = { apiKey: "ACsid", custom: { authToken: "authtoken" } };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("ACsid:authtoken");
    });

    it("should throw auth MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};

      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const meridianError = error as MeridianError;
        expect(meridianError.category).toBe("auth");
        expect(meridianError.provider).toBe("twilio");
      }
    });

    it("should throw auth MeridianError when only SID is provided", async () => {
      const config: AuthConfig = { username: "ACsid" };
      await expect(adapter.authStrategy(config)).rejects.toMatchObject({
        category: "auth",
        provider: "twilio",
      });
    });
  });

  // ─── rateLimitPolicy ──────────────────────────────────────────────────────────

  describe("rateLimitPolicy - Normalized Rate Limit Info", () => {
    it("should return conservative defaults when no rate-limit headers are present", () => {
      const headers = new Headers();
      const rateLimit = adapter.rateLimitPolicy(headers);

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
      expect(rateLimit.limit).toBeGreaterThan(0);
      expect(rateLimit.remaining).toBeGreaterThan(0);
    });

    it("should parse rate-limit headers when present", () => {
      const resetTs = Math.floor(Date.now() / 1000) + 60;
      const headers = new Headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "42",
        "X-RateLimit-Reset": String(resetTs),
      });

      const rateLimit = adapter.rateLimitPolicy(headers);
      expect(rateLimit.limit).toBe(100);
      expect(rateLimit.remaining).toBe(42);
      expect(rateLimit.reset.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ─── paginationStrategy ───────────────────────────────────────────────────────

  describe("paginationStrategy", () => {
    it("should return a strategy instance with all required methods", () => {
      const strategy = adapter.paginationStrategy();

      expect(strategy).toBeDefined();
      expect(strategy).toHaveProperty("extractCursor");
      expect(strategy).toHaveProperty("extractTotal");
      expect(strategy).toHaveProperty("hasNext");
      expect(strategy).toHaveProperty("buildNextRequest");
    });

    it("extractCursor should read next_page_uri from response body", () => {
      const strategy = new TwilioPaginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          messages: [],
          next_page_uri: "/2010-04-01/Accounts/AC123/Messages.json?Page=1",
        },
      };

      expect(strategy.extractCursor(raw)).toBe("/2010-04-01/Accounts/AC123/Messages.json?Page=1");
    });

    it("extractCursor should read meta.next_page_url when next_page_uri is absent", () => {
      const strategy = new TwilioPaginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          messages: [],
          meta: {
            next_page_url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?Page=2",
          },
        },
      };

      const cursor = strategy.extractCursor(raw);
      expect(cursor).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?Page=2");
    });

    it("extractCursor should return null when no next page exists", () => {
      const strategy = new TwilioPaginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { messages: [] },
      };

      expect(strategy.extractCursor(raw)).toBeNull();
    });

    it("extractTotal should read meta.total", () => {
      const strategy = new TwilioPaginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { messages: [], meta: { total: 150 } },
      };

      expect(strategy.extractTotal(raw)).toBe(150);
    });

    it("buildNextRequest should strip origin from absolute cursor", () => {
      const strategy = new TwilioPaginationStrategy();
      const { endpoint } = strategy.buildNextRequest(
        "/2010-04-01/Accounts/AC123/Messages.json",
        {},
        "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json?Page=2",
      );

      expect(endpoint).toBe("/2010-04-01/Accounts/AC123/Messages.json?Page=2");
    });

    it("buildNextRequest should use a relative cursor as-is", () => {
      const strategy = new TwilioPaginationStrategy();
      const { endpoint } = strategy.buildNextRequest(
        "/2010-04-01/Accounts/AC123/Messages.json",
        {},
        "/2010-04-01/Accounts/AC123/Messages.json?Page=3",
      );

      expect(endpoint).toBe("/2010-04-01/Accounts/AC123/Messages.json?Page=3");
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    const secret = "test-signing-secret";
    const payload = "AccountSid=ACtest&MessageSid=SM123&Body=Hello";

    it("should return true for a valid HMAC-SHA1 signature", () => {
      const signature = createHmac("sha1", secret).update(payload).digest("base64");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a tampered payload", () => {
      const signature = createHmac("sha1", secret).update(payload).digest("base64");
      expect(adapter.verifyWebhook(`${payload}tampered`, signature, secret)).toBe(false);
    });

    it("should return false for an invalid/wrong signature", () => {
      expect(adapter.verifyWebhook(payload, "invalidsignature==", secret)).toBe(false);
    });

    it("should return false for an empty signature", () => {
      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });

    it("should work with Buffer payload", () => {
      const buf = Buffer.from(payload);
      const signature = createHmac("sha1", secret).update(buf).digest("base64");
      expect(adapter.verifyWebhook(buf, signature, secret)).toBe(true);
    });
  });

  // ─── Contract Invariants ──────────────────────────────────────────────────────

  describe("Contract Invariants", () => {
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
          body: { code: 0, message: "Error", more_info: "", status: testCase.status },
        };

        const error = adapter.parseError(raw);
        expect(error.category).toBe(testCase.expectedCategory);
      }
    });

    it("should ALWAYS normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { messages: [{ sid: "SM123" }] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "twilio");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit).toHaveProperty("limit");
      expect(normalized.meta.rateLimit).toHaveProperty("remaining");
      expect(normalized.meta.rateLimit).toHaveProperty("reset");
    });

    it("should NEVER expose raw Twilio error body on the error object", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: { code: 20003, message: "Authenticate", more_info: "...", status: 401 },
      };

      const error = adapter.parseError(raw);

      expect((error as any).body).toBeUndefined();
      expect((error as any).more_info).toBeUndefined();
      // error.code is the MeridianError computed getter (e.g. "AUTH_FAILED"), not a raw Twilio field
      expect(error.provider).toBe("twilio");
    });
  });
});
