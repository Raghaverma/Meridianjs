import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { CcavenueAdapter, ccavenueDecrypt, ccavenueEncrypt } from "./adapter.js";

describe("CcavenueAdapter - Contract Tests", () => {
  const adapter = new CcavenueAdapter("https://api.ccavenue.com/");

  describe("ccavenueEncrypt / ccavenueDecrypt", () => {
    it("should round-trip a JSON payload", () => {
      const workingKey = "test_working_key_123";
      const payload = { order_no: "ORD123", amount: "100.00" };
      const enc = ccavenueEncrypt(payload, workingKey);
      expect(enc).toMatch(/^[0-9a-f]+$/);

      const decrypted = JSON.parse(ccavenueDecrypt(enc, workingKey));
      expect(decrypted).toEqual(payload);
    });

    it("should fail to decrypt with the wrong working key", () => {
      const enc = ccavenueEncrypt({ a: 1 }, "correct_key");
      expect(() => ccavenueDecrypt(enc, "wrong_key_wrong_key")).toThrow();
    });
  });

  describe("buildRequest", () => {
    it("should encrypt the body into enc_request and add access_code/request_type/response_type", async () => {
      const token = await adapter.authStrategy({
        apiKey: "AVAP00000000",
        apiSecret: "workingkey123",
      });
      const built = adapter.buildRequest({
        endpoint: "/apis/servlet/DoWebTrans",
        options: { method: "GET", body: { command: "orderStatusTracker", order_no: "ORD123" } },
        authToken: token,
      });

      const url = new URL(built.url);
      expect(url.searchParams.get("access_code")).toBe("AVAP00000000");
      expect(url.searchParams.get("request_type")).toBe("JSON");
      expect(url.searchParams.get("response_type")).toBe("JSON");

      const encRequest = url.searchParams.get("enc_request");
      expect(encRequest).toMatch(/^[0-9a-f]+$/);

      const decrypted = JSON.parse(ccavenueDecrypt(encRequest as string, "workingkey123"));
      expect(decrypted).toEqual({ command: "orderStatusTracker", order_no: "ORD123" });
    });

    it("should not include enc_request when there is no body", async () => {
      const token = await adapter.authStrategy({ apiKey: "AC1", apiSecret: "wk1" });
      const built = adapter.buildRequest({
        endpoint: "/apis/servlet/DoWebTrans",
        options: { method: "GET" },
        authToken: token,
      });
      const url = new URL(built.url);
      expect(url.searchParams.has("enc_request")).toBe(false);
    });
  });

  describe("decryptResponse", () => {
    it("should decrypt and JSON-parse an enc_response field", () => {
      const workingKey = "wk_resp_123";
      const payload = { order_status: "Success", order_no: "ORD123" };
      const encResponse = ccavenueEncrypt(payload, workingKey);

      const response = adapter.parseResponse({
        status: 200,
        headers: new Headers(),
        body: { enc_response: encResponse },
      });

      expect(adapter.decryptResponse(response, workingKey)).toEqual(payload);
    });

    it("should warn that the response payload is encrypted", () => {
      const response = adapter.parseResponse({
        status: 200,
        headers: new Headers(),
        body: { enc_response: "deadbeef" },
      });
      expect(response.meta.warnings.some((w) => w.toLowerCase().includes("encrypted"))).toBe(true);
    });

    it("should pass plain bodies through untouched", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { ok: true } };
      const response = adapter.parseResponse(raw);
      expect(response.data).toEqual({ ok: true });
      expect(adapter.decryptResponse(response, "anykey")).toEqual({ ok: true });
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: "0", reason: "Invalid access code", error_code: "AUTH_FAILED" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("ccavenue");
    });

    it("should map 404 to validation category", () => {
      expect(adapter.parseError({ status: 404, headers: new Headers(), body: {} }).category).toBe(
        "validation",
      );
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
      expect(adapter.parseError(new Error("ETIMEDOUT")).category).toBe("network");
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
    it("should accept apiKey (access code) + apiSecret (working key)", async () => {
      const token = await adapter.authStrategy({ apiKey: "AC123", apiSecret: "WK123" });
      expect(token.token).toContain("AC123");
      expect(token.token).toContain("WK123");
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

    it("should return a valid pagination strategy that reports no further pages", () => {
      const s = adapter.paginationStrategy();
      expect(s).toHaveProperty("extractCursor");
      expect(s.hasNext({ status: 200, headers: new Headers(), body: {} })).toBe(false);
    });

    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const secret = "working_key_456";
      const payload = "abcdef0123456789enc_response_hex";
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong secret", () => {
      const payload = "some-payload";
      const signature = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, "wrong")).toBe(false);
    });
  });
});
