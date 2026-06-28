import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../../core/types.js";
import { IdfyAdapter } from "./adapter.js";

describe("IdfyAdapter - Contract Tests", () => {
  const adapter = new IdfyAdapter("https://api.idfy.com");
  const token = "test_api_key|test_account_id";

  describe("buildRequest", () => {
    it("should set api-key and account-id headers from pipe-encoded token", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/tasks/sync/verify_with_source/ind_pan",
        options: { method: "POST" },
        authToken: { token },
      });
      expect(built.headers["api-key"]).toBe("test_api_key");
      expect(built.headers["account-id"]).toBe("test_account_id");
    });

    it("should append query params to URL", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/tasks/sync/verify_with_source/ind_pan",
        options: { method: "GET", query: { status: "completed" } },
        authToken: { token },
      });
      expect(built.url).toContain("status=completed");
    });

    it("should serialize JSON body for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/tasks/sync/verify_with_source/ind_pan",
        options: { method: "POST", body: { task_id: "task_123", data: {} } },
        authToken: { token },
      });
      expect(built.body).toContain('"task_id":"task_123"');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/v3/tasks",
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
        body: { status: "completed", result: {} },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("idfy");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { status: 401, message: "Unauthorized" },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("idfy");
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
      expect(adapter.parseError(new Error("network error")).category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("should accept apiKey + accountId", async () => {
      const t = await adapter.authStrategy({
        apiKey: "test_api_key",
        custom: { accountId: "test_account_id" },
      });
      expect(t.token).toBe(token);
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
});
