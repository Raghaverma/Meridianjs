import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { BilldeskAdapter } from "./adapter.js";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

describe("BilldeskAdapter - Contract Tests", () => {
  const adapter = new BilldeskAdapter("https://api.billdesk.com/");

  describe("buildRequest", () => {
    it("should sign POST bodies as a compact JWS and set application/jose headers", async () => {
      const token = await adapter.authStrategy({ clientId: "merchant1", clientSecret: "s3cr3t" });
      const built = adapter.buildRequest({
        endpoint: "/payments/ve1_2/orders/create",
        options: { method: "POST", body: { mercid: "merchant1", orderid: "ORD123" } },
        authToken: token,
      });

      expect(built.headers["Content-Type"]).toBe("application/jose");
      expect(built.headers.Accept).toBe("application/jose");
      expect(built.headers["BD-Timestamp"]).toMatch(/^\d+$/);
      expect(built.headers["BD-Traceid"]).toBeDefined();
      expect((built.headers["BD-Traceid"] as string).length).toBeLessThanOrEqual(35);

      const body = built.body as string;
      const parts = body.split(".");
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf-8"));
      expect(header.alg).toBe("HS256");
      expect(header.clientid).toBe("merchant1");

      const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"));
      expect(payload).toEqual({ mercid: "merchant1", orderid: "ORD123" });

      const expectedSig = base64url(
        createHmac("sha256", "s3cr3t")
          .update(`${parts[0]}.${parts[1]}`)
          .digest(),
      );
      expect(parts[2]).toBe(expectedSig);
    });

    it("should use the supplied idempotency key as the BD-Traceid (sanitized)", async () => {
      const token = await adapter.authStrategy({ clientId: "m1", clientSecret: "s1" });
      const built = adapter.buildRequest({
        endpoint: "/orders/create",
        options: { method: "POST", body: {}, idempotencyKey: "trace-id-2024-001" },
        authToken: token,
      });
      expect(built.headers["BD-Traceid"]).toBe("traceid2024001");
    });

    it("should append query params to the URL", async () => {
      const token = await adapter.authStrategy({ clientId: "m1", clientSecret: "s1" });
      const built = adapter.buildRequest({
        endpoint: "/payments/ve1_2/transactions",
        options: { method: "GET", query: { orderid: "ORD123" } },
        authToken: token,
      });
      expect(built.url).toContain("orderid=ORD123");
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a plain JSON response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { orderid: "ORD123", status: "PSTL" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("billdesk");
      expect(normalized.data).toEqual({ orderid: "ORD123", status: "PSTL" });
    });

    it("should decode a compact-JWS response body into JSON", () => {
      const payload = { orderid: "ORD123", status: "success" };
      const encodedHeader = base64url(JSON.stringify({ alg: "HS256" }));
      const encodedPayload = base64url(JSON.stringify(payload));
      const jws = `${encodedHeader}.${encodedPayload}.signature`;

      const raw: RawResponse = {
        status: 200,
        headers: new Headers({ "content-type": "application/jose" }),
        body: jws,
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.data).toEqual(payload);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: 401, error_type: "auth_error", error_code: "AUTH001", message: "Bad signature" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("billdesk");
    });

    it("should map 422 to validation category", () => {
      const error = adapter.parseError({
        status: 422,
        headers: new Headers(),
        body: { status: 422, error_type: "api_validation_error", error_code: "AUAVE0011", message: "Invalid mercid" },
      });
      expect(error.category).toBe("validation");
    });

    it("should map 429 to rate_limit category", () => {
      const error = adapter.parseError({ status: 429, headers: new Headers(), body: {} });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map 500 to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      const error = adapter.parseError(new Error("network timeout"));
      expect(error.category).toBe("network");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(
          expected,
        );
      }
    });
  });

  describe("authStrategy", () => {
    it("should accept clientId + clientSecret", async () => {
      const token = await adapter.authStrategy({ clientId: "m1", clientSecret: "s1" });
      expect(token.token).toContain("m1");
      expect(token.token).toContain("s1");
    });

    it("should throw MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try {
        await adapter.authStrategy({});
      } catch (err) {
        expect((err as MeridianError).category).toBe("auth");
      }
    });
  });

  describe("rateLimitPolicy + paginationStrategy + getIdempotencyConfig", () => {
    it("should return sensible rate-limit defaults", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });

    it("should return a valid pagination strategy", () => {
      const s = adapter.paginationStrategy();
      expect(s).toHaveProperty("extractCursor");
      expect(s).toHaveProperty("hasNext");
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid JWS-HMAC signature", () => {
      const secret = "webhook_secret";
      const payload = { orderid: "ORD123", status: "success" };
      const encodedHeader = base64url(JSON.stringify({ alg: "HS256" }));
      const encodedPayload = base64url(JSON.stringify(payload));
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = base64url(createHmac("sha256", secret).update(signingInput).digest());
      const jws = `${signingInput}.${signature}`;

      expect(adapter.verifyWebhook(jws, jws, secret)).toBe(true);
      expect(adapter.verifyWebhook(jws, signature, secret)).toBe(true);
    });

    it("should return false for a wrong secret", () => {
      const payload = { orderid: "ORD123" };
      const encodedHeader = base64url(JSON.stringify({ alg: "HS256" }));
      const encodedPayload = base64url(JSON.stringify(payload));
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = base64url(createHmac("sha256", "real_secret").update(signingInput).digest());
      const jws = `${signingInput}.${signature}`;

      expect(adapter.verifyWebhook(jws, jws, "wrong_secret")).toBe(false);
    });

    it("should fall back to plain HMAC verification for non-JWS payloads", () => {
      const secret = "plain_secret";
      const payload = "raw-webhook-body";
      const signature = base64url(createHmac("sha256", secret).update(payload).digest());
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
      expect(adapter.verifyWebhook(payload, signature, "wrong")).toBe(false);
    });
  });
});
