import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../core/types.js";
import { SendgridAdapter } from "./adapter.js";
import { SendgridPaginationStrategy } from "./pagination.js";

describe("SendGrid Adapter - Contract Tests", () => {
  const adapter = new SendgridAdapter("https://api.sendgrid.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with Bearer auth and correct headers", () => {
      const input = {
        endpoint: "/v3/templates",
        options: { method: "GET" as const, query: { page_size: "20" } },
        authToken: { token: "SG.test_api_key" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://api.sendgrid.com/v3/templates?page_size=20");
      expect(built.method).toBe("GET");
      expect(built.headers.Authorization).toBe("Bearer SG.test_api_key");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should encode the body as JSON for POST requests and set Content-Type", () => {
      const input = {
        endpoint: "/v3/mail/send",
        options: {
          method: "POST" as const,
          body: { personalizations: [], from: { email: "test@example.com" } },
        },
        authToken: { token: "SG.test" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });

    it("should pass through a pre-encoded string body unchanged", () => {
      const input = {
        endpoint: "/v3/mail/send",
        options: {
          method: "POST" as const,
          body: '{"foo":"bar"}',
        },
        authToken: { token: "SG.test" },
      };

      const built = adapter.buildRequest(input);
      expect(built.body).toBe('{"foo":"bar"}');
      expect(built.headers["Content-Type"]).toBeUndefined();
    });

    it("should NOT include body for GET/HEAD requests", () => {
      const input = {
        endpoint: "/v3/templates",
        options: { method: "GET" as const, body: { foo: "bar" } },
        authToken: { token: "SG.test" },
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
          result: [{ id: "tmpl_123" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "sendgrid");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.limit).toBe(600);
      expect(normalized.meta.rateLimit.remaining).toBe(599);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination info from _metadata.next", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          result: [],
          _metadata: {
            next: "https://api.sendgrid.com/v3/templates?page_token=xyz",
            count: 50,
          },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe(
        "https://api.sendgrid.com/v3/templates?page_token=xyz",
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
          errors: [{ message: "authorization required" }],
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("sendgrid");
      expect(error.message).toBe("authorization required");
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          errors: [{ message: "access forbidden" }],
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
          errors: [{ message: "not found" }],
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category (retryable)", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: {
          errors: [{ message: "too many requests" }],
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
          errors: [{ message: "bad request" }],
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 5xx to provider category (retryable)", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: {
          errors: [{ message: "internal error" }],
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
  });

  // ─── authStrategy ─────────────────────────────────────────────────────────────

  describe("authStrategy", () => {
    it("should accept apiKey and return Bearer token", async () => {
      const config: AuthConfig = { apiKey: "SG.test_key" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("SG.test_key");
    });

    it("should throw auth MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── rateLimitPolicy ──────────────────────────────────────────────────────────

  describe("rateLimitPolicy", () => {
    it("should parse rate-limit headers when present", () => {
      const resetTs = Math.floor(Date.now() / 1000) + 60;
      const headers = new Headers({
        "X-RateLimit-Limit": "600",
        "X-RateLimit-Remaining": "42",
        "X-RateLimit-Reset": String(resetTs),
      });

      const rateLimit = adapter.rateLimitPolicy(headers);
      expect(rateLimit.limit).toBe(600);
      expect(rateLimit.remaining).toBe(42);
      expect(rateLimit.reset.getTime()).toBe(resetTs * 1000);
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    it("should return true for a valid Ed25519 signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const der = publicKey.export({ type: "spki", format: "der" });
      // The OID/header portion is 12 bytes for Ed25519 SPKI DER keys
      const rawPublicKey = der.subarray(12);
      const secret = rawPublicKey.toString("base64");

      const payload = "test-webhook-payload";
      const sigBuffer = sign(null, Buffer.from(payload), privateKey);
      const signature = sigBuffer.toString("base64");

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a tampered payload", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const der = publicKey.export({ type: "spki", format: "der" });
      const rawPublicKey = der.subarray(12);
      const secret = rawPublicKey.toString("base64");

      const payload = "test-webhook-payload";
      const sigBuffer = sign(null, Buffer.from(payload), privateKey);
      const signature = sigBuffer.toString("base64");

      expect(adapter.verifyWebhook(`${payload}tampered`, signature, secret)).toBe(false);
    });

    it("should return false if public key is not 32 bytes", () => {
      const payload = "test-payload";
      const signature = Buffer.alloc(64).toString("base64");
      const secret = Buffer.alloc(16).toString("base64"); // 16 bytes instead of 32

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(false);
    });

    it("should return false on invalid signature format", () => {
      const secret = Buffer.alloc(32).toString("base64");
      expect(adapter.verifyWebhook("payload", "invalid-sig", secret)).toBe(false);
    });
  });
});
