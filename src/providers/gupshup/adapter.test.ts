import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { GupshupAdapter } from "./adapter.js";

describe("GupshupAdapter - Contract Tests", () => {
  const adapter = new GupshupAdapter("https://api.gupshup.io");

  describe("buildRequest", () => {
    it("should set apikey header", () => {
      const built = adapter.buildRequest({
        endpoint: "/sm/api/v1/msg",
        options: { method: "POST" },
        authToken: { token: "test_api_key" },
      });
      expect(built.headers.apikey).toBe("test_api_key");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/sm/api/v1/msg",
        options: { method: "GET", query: { app: "test" } },
        authToken: { token: "key" },
      });
      expect(built.url).toContain("app=test");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/sm/api/v1/msg",
        options: { method: "POST", body: { channel: "whatsapp", source: "918888888888" } },
        authToken: { token: "key" },
      });
      expect(built.body).toBe('{"channel":"whatsapp","source":"918888888888"}');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/sm/api/v1/msg",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "key" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { status: "submitted", messageId: "msg_123" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("gupshup");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: "error", message: "Invalid API Key" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("gupshup");
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
      expect(adapter.parseError(new Error("enotfound")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept apiKey", async () => {
      const token = await adapter.authStrategy({ apiKey: "test_key" });
      expect(token.token).toBe("test_key");
    });

    it("should throw MeridianError for missing apiKey", async () => {
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
      const s = adapter.paginationStrategy();
      expect(s).toHaveProperty("extractCursor");
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    const secret = "gupshup_webhook_secret";
    const payload = '{"type":"message","payload":{"id":"msg_123"}}';

    function hmacHex(s: string, p: string): string {
      return createHmac("sha256", s).update(p).digest("hex");
    }

    it("should return true for a valid HMAC-SHA256 hex signature", () => {
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong signature", () => {
      expect(adapter.verifyWebhook(payload, "badhex".padEnd(64, "0"), secret)).toBe(false);
    });

    it("should return false for a tampered payload", () => {
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(`${payload}tampered`, signature, secret)).toBe(false);
    });

    it("should work with Buffer payload", () => {
      const bufPayload = Buffer.from(payload);
      const signature = hmacHex(secret, payload);
      expect(adapter.verifyWebhook(bufPayload, signature, secret)).toBe(true);
    });
  });
});
