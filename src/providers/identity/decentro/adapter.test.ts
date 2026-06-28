import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../../core/types.js";
import { DecentroAdapter } from "./adapter.js";

describe("DecentroAdapter - Contract Tests", () => {
  const adapter = new DecentroAdapter("https://in.decentro.tech");
  const token = "test_client|test_secret|test_module";

  describe("buildRequest", () => {
    it("should build a request with correct auth headers from pipe-encoded token", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/kyc/pan/verify",
        options: { method: "POST" },
        authToken: { token },
      });
      expect(built.url).toContain("/v2/kyc/pan/verify");
      expect(built.method).toBe("POST");
      expect(built.headers).toBeDefined();
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/kyc/pan/verify",
        options: { method: "GET", query: { reference_id: "ref_123" } },
        authToken: { token },
      });
      expect(built.url).toContain("reference_id=ref_123");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/kyc/pan/verify",
        options: { method: "POST", body: { reference_id: "ref_123", pan: "ABCDE1234F" } },
        authToken: { token },
      });
      expect(built.body).toContain('"pan":"ABCDE1234F"');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/kyc/pan/verify",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { decentroTxnId: "DEC_1234", status: "SUCCESS" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("decentro");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { responseCode: "E_UNAUTHORIZED", message: "Unauthorized" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("decentro");
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

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("econnreset")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept clientId, clientSecret, and moduleSecret", async () => {
      const t = await adapter.authStrategy({
        clientId: "cid",
        clientSecret: "csec",
        custom: { moduleSecret: "msec" },
      });
      expect(t.token).toBe("cid|csec|msec");
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

  describe("paginationStrategy + getIdempotencyConfig", () => {
    it("should return a valid pagination strategy", () => {
      expect(adapter.paginationStrategy()).toHaveProperty("extractCursor");
    });
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const { createHmac } = require("node:crypto");
      const secret = "webhook_secret";
      const payload = JSON.stringify({ event: "kyc.verified" });
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for tampered payload", () => {
      const { createHmac } = require("node:crypto");
      const secret = "secret";
      const sig = createHmac("sha256", secret).update("original").digest("hex");
      expect(adapter.verifyWebhook("tampered", sig, secret)).toBe(false);
    });
  });
});
