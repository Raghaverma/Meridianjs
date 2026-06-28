import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../../core/types.js";
import { BraintreeAdapter } from "./adapter.js";

describe("Braintree Adapter - Contract Tests", () => {
  const adapter = new BraintreeAdapter("https://api.sandbox.braintreegateway.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────
  describe("buildRequest", () => {
    it("should parse compound token and build a request with basic auth and merchantId prepended", () => {
      const input = {
        endpoint: "/transactions",
        options: { method: "GET" as const, query: { limit: "10" } },
        authToken: { token: "merchant123:pubKey456:privKey789" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe(
        "https://api.sandbox.braintreegateway.com/merchants/merchant123/transactions?limit=10",
      );
      expect(built.method).toBe("GET");
      const expectedCredentials = Buffer.from("pubKey456:privKey789").toString("base64");
      expect(built.headers.Authorization).toBe(`Basic ${expectedCredentials}`);
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
      expect(built.headers.Accept).toBe("application/json");
    });

    it("should replace {merchant_id} placeholder in endpoint", () => {
      const input = {
        endpoint: "/merchants/{merchant_id}/clients",
        options: { method: "GET" as const },
        authToken: { token: "merchant123:pubKey456:privKey789" },
      };

      const built = adapter.buildRequest(input);
      expect(built.url).toBe(
        "https://api.sandbox.braintreegateway.com/merchants/merchant123/clients",
      );
    });

    it("should not prepend merchant path if already prepended", () => {
      const input = {
        endpoint: "/merchants/merchant123/transactions/some-id",
        options: { method: "GET" as const },
        authToken: { token: "merchant123:pubKey456:privKey789" },
      };

      const built = adapter.buildRequest(input);
      expect(built.url).toBe(
        "https://api.sandbox.braintreegateway.com/merchants/merchant123/transactions/some-id",
      );
    });

    it("should JSON-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/transactions",
        options: {
          method: "POST" as const,
          body: { amount: "10.00", paymentMethodNonce: "nonce" },
        },
        authToken: { token: "merchant123:pubKey456:privKey789" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });
  });

  // ─── parseResponse ────────────────────────────────────────────────────────────
  describe("parseResponse - Normalized Response Shape", () => {
    it("should normalize a successful response with the correct structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": "999",
          "X-RateLimit-Reset": "1700000000",
        }),
        body: {
          transactions: [{ id: "tx_123" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "braintree");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.limit).toBe(1000);
      expect(normalized.meta.rateLimit.remaining).toBe(999);
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should extract pagination info from search response using array size", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          searchResults: [{ id: "tx_1" }, { id: "tx_2" }],
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
          message: "Unauthorized access",
        },
      };

      const error = adapter.parseError(raw);

      expect(error).toBeInstanceOf(Error);
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("braintree");
      expect(error.message).toBe("Unauthorized access");
    });

    it("should map 403 to auth category", () => {
      const raw = {
        status: 403,
        headers: new Headers(),
        body: {
          message: "Forbidden access",
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
          message: "Object not found",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit category", () => {
      const raw = {
        status: 429,
        headers: new Headers({ "Retry-After": "10" }),
        body: {
          message: "Too many requests",
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 400 and 422 to validation category", () => {
      const raw = {
        status: 422,
        headers: new Headers(),
        body: {
          errors: {
            message: "Validation failed on input",
          },
        },
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("Validation failed on input");
    });

    it("should map 5xx to provider category", () => {
      const raw = {
        status: 500,
        headers: new Headers(),
        body: "Internal Server Error",
      };

      const error = adapter.parseError(raw);
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
      expect(error.message).toBe("Internal Server Error");
    });

    it("should map network errors to network category", () => {
      const raw = new Error("fetch failed: network timeout");

      const error = adapter.parseError(raw);
      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });
  });

  // ─── authStrategy ─────────────────────────────────────────────────────────────
  describe("authStrategy", () => {
    it("should parse configuration parameters and format compound token using clientId/username/password", async () => {
      const config: AuthConfig = {
        clientId: "merchant123",
        username: "pubKey456",
        password: "privKey789",
      };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("merchant123:pubKey456:privKey789");
    });

    it("should parse configuration parameters and format compound token using custom variables", async () => {
      const config: AuthConfig = {
        apiKey: "pubKey456",
        custom: {
          merchantId: "merchant123",
          privateKey: "privKey789",
        },
      };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("merchant123:pubKey456:privKey789");
    });

    it("should throw auth MeridianError if credentials are missing", async () => {
      const config: AuthConfig = {
        clientId: "merchant123",
      };
      await expect(adapter.authStrategy(config)).rejects.toThrow();
    });
  });

  // ─── verifyWebhook ────────────────────────────────────────────────────────────
  describe("verifyWebhook", () => {
    const secret = "private_key_secret";
    const payload = "test_payload";

    it("should return true for a valid signature with one public key and matching hmac", () => {
      const expectedHmac = createHmac("sha1", secret).update(payload).digest("hex");
      const signature = `publicKey|${expectedHmac}`;

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should handle multiline/ampersand signatures and match one", () => {
      const expectedHmac = createHmac("sha1", secret).update(payload).digest("hex");
      const signature = `otherKey|randomHmac\npublicKey|${expectedHmac}&thirdKey|something`;

      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for incorrect HMAC", () => {
      const signature = "publicKey|incorrectHmac";
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(false);
    });

    it("should return false if parsing signature fails", () => {
      expect(adapter.verifyWebhook(payload, "", secret)).toBe(false);
    });
  });
});
