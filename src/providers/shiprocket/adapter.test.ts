import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { ShiprocketAdapter } from "./adapter.js";

describe("ShiprocketAdapter - Contract Tests", () => {
  const adapter = new ShiprocketAdapter("https://apiv2.shiprocket.in");

  describe("buildRequest", () => {
    it("should set Bearer auth header from JWT token", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/external/orders",
        options: { method: "GET" },
        authToken: { token: "test_jwt_token" },
      });
      expect(built.headers.Authorization).toBe("Bearer test_jwt_token");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/external/orders",
        options: { method: "GET", query: { page: 1, per_page: 20 } },
        authToken: { token: "jwt" },
      });
      expect(built.url).toContain("page=1");
      expect(built.url).toContain("per_page=20");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/external/orders/create/adhoc",
        options: { method: "POST", body: { order_id: "ord_123", order_date: "2026-01-01" } },
        authToken: { token: "jwt" },
      });
      expect(built.body).toContain('"order_id":"ord_123"');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v1/external/orders",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "jwt" },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { data: [], total: 0 },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("shiprocket");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: 401, message: "Invalid token" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("shiprocket");
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
      expect(adapter.parseError(new Error("timeout")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept token or apiKey (pre-obtained JWT)", async () => {
      const t = await adapter.authStrategy({ token: "test_jwt" });
      expect(t.token).toBe("test_jwt");
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
      const secret = "wh_secret";
      const payload = JSON.stringify({ awb: "123456789", current_status: "Delivered" });
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for wrong secret", () => {
      const { createHmac } = require("node:crypto");
      const payload = "payload";
      const sig = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, sig, "wrong")).toBe(false);
    });
  });
});
