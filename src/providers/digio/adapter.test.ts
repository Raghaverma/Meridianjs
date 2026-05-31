
import { describe, it, expect } from "vitest";
import { DigioAdapter } from "./adapter.js";
import type { RawResponse, MeridianError } from "../../core/types.js";

describe("DigioAdapter - Contract Tests", () => {
  const adapter = new DigioAdapter("https://api.digio.in");
  const token = Buffer.from("test_client_id:test_client_secret").toString("base64");

  describe("buildRequest", () => {
    it("should set Basic auth header from base64-encoded clientId:clientSecret", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/client/document/upload",
        options: { method: "POST" },
        authToken: { token },
      });
      expect(built.headers["Authorization"]).toBe(`Basic ${token}`);
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/client/document/upload",
        options: { method: "GET", query: { page: 1 } },
        authToken: { token },
      });
      expect(built.url).toContain("page=1");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/client/document/upload",
        options: { method: "POST", body: { document_id: "doc_123" } },
        authToken: { token },
      });
      expect(built.body).toContain('"document_id":"doc_123"');
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v2/client/document/upload",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token },
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { id: "doc_123", status: "pending" } };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("digio");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: { message: "Invalid credentials", code: 401 } });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("digio");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" }, { status: 403, expected: "auth" },
        { status: 404, expected: "validation" }, { status: 400, expected: "validation" },
        { status: 429, expected: "rate_limit" }, { status: 500, expected: "provider" },
      ] as const;
      for (const { status, expected } of cases) {
        expect(adapter.parseError({ status, headers: new Headers(), body: {} }).category).toBe(expected);
      }
    });

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("fetch failed")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept clientId + clientSecret", async () => {
      const t = await adapter.authStrategy({ clientId: "test_client_id", clientSecret: "test_client_secret" });
      expect(t.token).toBe(token);
    });

    it("should throw MeridianError for missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
      try { await adapter.authStrategy({}); } catch (err) {
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
});
