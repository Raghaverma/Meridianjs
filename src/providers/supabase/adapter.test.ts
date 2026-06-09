import { describe, expect, it } from "vitest";
import type { RawResponse } from "../../core/types.js";
import { SupabaseAdapter } from "./adapter.js";

describe("Supabase Adapter - Contract Tests", () => {
  const adapter = new SupabaseAdapter("https://project.supabase.co/rest/v1");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with apikey and Authorization Bearer headers", () => {
      const input = {
        endpoint: "/users",
        options: { method: "GET" as const },
        authToken: { token: "supabase_anon_key" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://project.supabase.co/rest/v1/users");
      expect(built.method).toBe("GET");
      expect(built.headers.apikey).toBe("supabase_anon_key");
      expect(built.headers.Authorization).toBe("Bearer supabase_anon_key");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should JSON-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/users",
        options: {
          method: "POST" as const,
          body: { username: "alice" },
        },
        authToken: { token: "supabase_anon_key" },
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
          "Content-Range": "0-9/100",
        }),
        body: [{ id: 1 }],
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "supabase");
      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe("10:10");
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "Invalid API key",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("Invalid API key");
    });
  });
});
