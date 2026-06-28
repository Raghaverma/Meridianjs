import { describe, expect, it } from "vitest";
import type { RawResponse } from "../../../core/types.js";
import { Auth0Adapter } from "./adapter.js";

describe("Auth0 Adapter - Contract Tests", () => {
  const adapter = new Auth0Adapter("https://tenant.auth0.com/api/v2");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a request with Bearer Auth header and correct headers", () => {
      const input = {
        endpoint: "/users",
        options: { method: "GET" as const, query: { page: "0" } },
        authToken: { token: "auth0_token_123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://tenant.auth0.com/api/v2/users?page=0");
      expect(built.method).toBe("GET");
      expect(built.headers.Authorization).toBe("Bearer auth0_token_123");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should JSON-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/users",
        options: {
          method: "POST" as const,
          body: { email: "user@example.com", connection: "Username-Password-Authentication" },
        },
        authToken: { token: "auth0_token_123" },
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
          "X-RateLimit-Limit": "600",
          "X-RateLimit-Remaining": "599",
          "X-RateLimit-Reset": "1700000000",
        }),
        body: [{ user_id: "auth0|123" }],
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "auth0");
      expect(normalized.meta.rateLimit.limit).toBe(600);
      expect(normalized.meta.rateLimit.remaining).toBe(599);
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Token is expired",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("Token is expired");
    });
  });
});
