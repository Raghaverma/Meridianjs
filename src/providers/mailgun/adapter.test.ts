import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { MailgunAdapter } from "./adapter.js";
import { MailgunPaginationStrategy } from "./pagination.js";

describe("Mailgun Adapter - Contract Tests", () => {
  const adapter = new MailgunAdapter("https://api.mailgun.net");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with Basic auth and correct headers", () => {
      const input = {
        endpoint: "/v3/domains",
        options: { method: "GET" as const, query: { limit: "20" } },
        authToken: { token: "key-test123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://api.mailgun.net/v3/domains?limit=20");
      expect(built.method).toBe("GET");
      const credentials = Buffer.from("api:key-test123").toString("base64");
      expect(built.headers.Authorization).toBe(`Basic ${credentials}`);
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should form-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/v3/example.com/messages",
        options: {
          method: "POST" as const,
          body: { from: "test@example.com", to: "user@example.com", subject: "hello" },
        },
        authToken: { token: "key-test" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(built.body).toContain("from=test%40example.com");
      expect(built.body).toContain("to=user%40example.com");
      expect(built.body).toContain("subject=hello");
    });

    it("should JSON-encode the body for POST requests when Content-Type is application/json", () => {
      const input = {
        endpoint: "/v3/domains",
        options: {
          method: "POST" as const,
          headers: { "Content-Type": "application/json" },
          body: { name: "newdomain.com" },
        },
        authToken: { token: "key-test" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });

    it("should pass through a pre-encoded string body unchanged", () => {
      const input = {
        endpoint: "/v3/domains",
        options: {
          method: "POST" as const,
          body: "name=test.com",
        },
        authToken: { token: "key-test" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBe("name=test.com");
      expect(built.headers["Content-Type"]).toBeUndefined();
    });

    it("should NOT include body for GET/HEAD requests", () => {
      const input = {
        endpoint: "/v3/domains",
        options: { method: "GET" as const, body: { foo: "bar" } },
        authToken: { token: "key-test" },
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
          items: [{ name: "domain.com" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "mailgun");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.limit).toBe(600);
      expect(normalized.meta.rateLimit.remaining).toBe(599);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination info from paging.next", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          items: [],
          paging: {
            next: "https://api.mailgun.net/v3/domains?page=next&threshold=123",
          },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe(
        "https://api.mailgun.net/v3/domains?page=next&threshold=123",
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
          message: "Forbidden",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("mailgun");
      expect(error.message).toBe("Forbidden");
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          message: "Forbidden",
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
          message: "not found",
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
          message: "too many requests",
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
          message: "bad request",
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
    it("should accept apiKey and return token", async () => {
      const config: AuthConfig = { apiKey: "key-1234" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("key-1234");
    });

    it("should throw auth MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    const secret = "test-webhook-key";
    const timestamp = "1529147690";
    const token = "token123";

    it("should return true for a valid signature inside payload body", () => {
      const signature = createHmac("sha256", secret)
        .update(timestamp + token)
        .digest("hex");

      const payload = {
        signature: {
          timestamp,
          token,
          signature,
        },
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(true);
    });

    it("should return true when signature is passed explicitly as an argument", () => {
      const signature = createHmac("sha256", secret)
        .update(timestamp + token)
        .digest("hex");

      const payload = {
        signature: {
          timestamp,
          token,
        },
      };

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a tampered signature", () => {
      const payload = {
        signature: {
          timestamp,
          token,
          signature: "wrong-signature",
        },
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });

    it("should return false if payload is missing signature fields", () => {
      const payload = {
        data: "some event",
      };

      expect(adapter.verifyWebhook(payload, "sig", secret)).toBe(false);
    });
  });
});
