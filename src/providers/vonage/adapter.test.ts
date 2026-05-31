import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { VonageAdapter } from "./adapter.js";
import { VonagePaginationStrategy } from "./pagination.js";

describe("Vonage Adapter - Contract Tests", () => {
  const adapter = new VonageAdapter("https://api.nexmo.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with API key/secret in query and correct headers", () => {
      const input = {
        endpoint: "/v1/applications",
        options: { method: "GET" as const, query: { page_size: "20" } },
        authToken: { token: "vonage_key_123", secret: "vonage_secret_abc" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toContain("api_key=vonage_key_123");
      expect(built.url).toContain("api_secret=vonage_secret_abc");
      expect(built.url).toContain("page_size=20");
      expect(built.method).toBe("GET");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should not inject api_key/api_secret query parameters if Authorization header is set", () => {
      const input = {
        endpoint: "/v1/applications",
        options: {
          method: "GET" as const,
          headers: { Authorization: "Bearer my-jwt-token" },
        },
        authToken: { token: "vonage_key_123", secret: "vonage_secret_abc" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).not.toContain("api_key");
      expect(built.url).not.toContain("api_secret");
      expect(built.headers.Authorization).toBe("Bearer my-jwt-token");
    });

    it("should JSON-encode the body by default for POST requests and set Content-Type", () => {
      const input = {
        endpoint: "/v1/applications",
        options: {
          method: "POST" as const,
          body: { name: "test-app" },
        },
        authToken: { token: "vonage_key_123", secret: "vonage_secret_abc" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });

    it("should form-encode the body when Content-Type is application/x-www-form-urlencoded", () => {
      const input = {
        endpoint: "/sms/xml",
        options: {
          method: "POST" as const,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: { text: "hello", to: "12345" },
        },
        authToken: { token: "vonage_key" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(built.body).toContain("text=hello");
      expect(built.body).toContain("to=12345");
    });

    it("should pass through a pre-encoded string body unchanged", () => {
      const input = {
        endpoint: "/sms/json",
        options: {
          method: "POST" as const,
          body: "text=test",
        },
        authToken: { token: "vonage_key" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBe("text=test");
    });

    it("should NOT include body for GET/HEAD requests", () => {
      const input = {
        endpoint: "/v1/applications",
        options: { method: "GET" as const, body: { foo: "bar" } },
        authToken: { token: "key" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBeUndefined();
    });
  });

  // ─── parseResponse ────────────────────────────────────────────────────────────

  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize a successful response with the correct structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "600",
          "X-RateLimit-Remaining": "599",
          "X-RateLimit-Reset": "1700000000",
        }),
        body: {
          applications: [{ id: "app_123" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "vonage");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.limit).toBe(600);
      expect(normalized.meta.rateLimit.remaining).toBe(599);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination info from _links.next.href", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          applications: [],
          count: 50,
          _links: {
            next: {
              href: "https://api.nexmo.com/v1/applications?page_size=10&page=2",
            },
          },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe(
        "https://api.nexmo.com/v1/applications?page_size=10&page=2",
      );
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          detail: "Invalid API Key",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("vonage");
      expect(error.message).toBe("Invalid API Key");
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          title: "Forbidden",
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
          "error-text": "not found",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category (retryable)", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "15" }),
        body: {
          detail: "too many requests",
        },
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
        body: {
          detail: "bad request",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 5xx to provider category (retryable)", () => {
      const raw = {
        status: 502,
        headers: new Headers(),
        body: "Bad Gateway",
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
      expect(error.message).toBe("Bad Gateway");
    });

    it("should map network errors to network category", () => {
      const raw = new Error("fetch failed: network error");

      const error = adapter.parseError(raw);
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });
  });

  // ─── authStrategy ─────────────────────────────────────────────────────────────

  describe("authStrategy", () => {
    it("should accept apiKey and secret and return them", async () => {
      const config: AuthConfig = { apiKey: "vonage_key", apiSecret: "vonage_secret" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("vonage_key");
      expect(token.secret).toBe("vonage_secret");
    });

    it("should throw auth MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    const secret = "test-signature-secret";
    const timestamp = "1529147690";
    const messageId = "msg12345";

    it("should return true for a valid parameter-sorted signature", () => {
      // Keys sorted: messageId, timestamp
      const paramStr = `messageId=${messageId}&timestamp=${timestamp}`;
      const sig = createHmac("sha256", secret).update(paramStr).digest("hex");

      const payload = {
        timestamp,
        messageId,
        sig,
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(true);
    });

    it("should return false for a tampered signature", () => {
      const payload = {
        timestamp,
        messageId,
        sig: "wrong-signature",
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });

    it("should return false if payload is missing signature fields", () => {
      const payload = {
        message: "hello",
      };

      expect(adapter.verifyWebhook(payload, "sig", secret)).toBe(false);
    });
  });
});
