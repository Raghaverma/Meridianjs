import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { HubSpotAdapter } from "./adapter.js";
import { HubSpotPaginationStrategy } from "./pagination.js";

describe("HubSpot Adapter - Contract Tests", () => {
  const adapter = new HubSpotAdapter("https://api.hubapi.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a GET request with Bearer token in Authorization header", () => {
      const input = {
        endpoint: "/crm/v3/objects/contacts",
        options: { method: "GET" as const, query: { limit: "10" } },
        authToken: { token: "hubspot_token_123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe("https://api.hubapi.com/crm/v3/objects/contacts?limit=10");
      expect(built.method).toBe("GET");
      expect(built.headers.Authorization).toBe("Bearer hubspot_token_123");
      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
    });

    it("should JSON-encode the body by default for POST requests", () => {
      const input = {
        endpoint: "/crm/v3/objects/contacts",
        options: {
          method: "POST" as const,
          body: { properties: { email: "user@example.com" } },
        },
        authToken: { token: "hubspot_token_123" },
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
          "X-HubSpot-RateLimit-Daily": "250000",
          "X-HubSpot-RateLimit-Daily-Remaining": "249999",
        }),
        body: {
          results: [{ id: "contact_123" }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "hubspot");
      expect(normalized.meta.rateLimit.limit).toBe(250000);
      expect(normalized.meta.rateLimit.remaining).toBe(249999);
    });

    it("should extract pagination info from paging.next.after", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          results: [],
          paging: {
            next: {
              after: "NTI1Cg==",
              link: "https://api.hubapi.com/crm/v3/objects/contacts?limit=10&after=NTI1Cg==",
            },
          },
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.pagination).toBeDefined();
      expect(normalized.meta.pagination?.hasNext).toBe(true);
      expect(normalized.meta.pagination?.cursor).toBe("NTI1Cg==");
    });
  });

  // ─── parseError ──────────────────────────────────────────────────────────────

  describe("parseError - Canonical Error Categories", () => {
    it("should map 401 to auth category", () => {
      const raw = {
        status: 401,
        headers: new Headers(),
        body: {
          message: "The API key provided is invalid.",
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("The API key provided is invalid.");
    });
  });
});
