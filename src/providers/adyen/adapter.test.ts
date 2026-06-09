import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { AdyenAdapter } from "./adapter.js";

describe("Adyen Adapter - Contract Tests", () => {
  const adapter = new AdyenAdapter("https://checkout-test.adyen.com/v70");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with API Key header and correct headers", () => {
      const input = {
        endpoint: "/paymentLinks",
        options: { method: "GET" as const, query: { limit: "20" } },
        authToken: { token: "adyen_key_123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://checkout-test.adyen.com/v70/paymentLinks?limit=20");
      expect(built.method).toBe("GET");
      expect(built.headers["X-API-Key"]).toBe("adyen_key_123");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should JSON-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/payments",
        options: {
          method: "POST" as const,
          body: { reference: "test-ref", amount: { value: 1000, currency: "EUR" } },
        },
        authToken: { token: "adyen_key_123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });

    it("should NOT include body for GET/HEAD requests", () => {
      const input = {
        endpoint: "/paymentLinks",
        options: { method: "GET" as const, body: { foo: "bar" } },
        authToken: { token: "adyen_key" },
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
          paymentLinks: [{ id: "link_123" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "adyen");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.limit).toBe(600);
      expect(normalized.meta.rateLimit.remaining).toBe(599);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination info from list response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          paymentLinks: [{ id: "link_1" }, { id: "link_2" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe("2");
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Access Denied",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("adyen");
      expect(error.message).toBe("Access Denied");
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
      const config: AuthConfig = { apiKey: "adyen-key-1234" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("adyen-key-1234");
    });

    it("should throw auth MeridianError when credentials are missing", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    const secret = "4476C6B9A89110B74C935BBA94786C6B9A89110B74C935BBA94786C6B9A89110";
    const pspReference = "8515291476900000";
    const originalReference = "";
    const merchantAccountCode = "TestMerchant";
    const merchantReference = "TestReference";
    const value = "1000";
    const currency = "EUR";
    const eventCode = "AUTHORISATION";
    const success = "true";

    it("should return true for a valid signature inside Adyen payload item", () => {
      // Adyen field ordering: pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success
      const toSign = `${pspReference}:${originalReference}:${merchantAccountCode}:${merchantReference}:${value}:${currency}:${eventCode}:${success}`;
      const keyBuffer = Buffer.from(secret, "hex");
      const signature = createHmac("sha256", keyBuffer).update(toSign).digest("base64");

      const payload = {
        notificationItems: [
          {
            NotificationRequestItem: {
              pspReference,
              originalReference,
              merchantAccountCode,
              merchantReference,
              amount: {
                value: 1000,
                currency,
              },
              eventCode,
              success,
              additionalData: {
                hmacSignature: signature,
              },
            },
          },
        ],
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(true);
    });

    it("should return true when signature is passed explicitly as a base64 argument", () => {
      const toSign = `${pspReference}:${originalReference}:${merchantAccountCode}:${merchantReference}:${value}:${currency}:${eventCode}:${success}`;
      const keyBuffer = Buffer.from(secret, "hex");
      const signature = createHmac("sha256", keyBuffer).update(toSign).digest("base64");

      const payload = {
        notificationItems: [
          {
            NotificationRequestItem: {
              pspReference,
              originalReference,
              merchantAccountCode,
              merchantReference,
              amount: {
                value: 1000,
                currency,
              },
              eventCode,
              success,
            },
          },
        ],
      };

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a tampered signature", () => {
      const payload = {
        notificationItems: [
          {
            NotificationRequestItem: {
              pspReference,
              originalReference,
              merchantAccountCode,
              merchantReference,
              amount: {
                value: 1000,
                currency,
              },
              eventCode,
              success,
              additionalData: {
                hmacSignature: "wrong-signature",
              },
            },
          },
        ],
      };

      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });
  });
});
