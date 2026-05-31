import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { MollieAdapter } from "./adapter.js";

describe("Mollie Adapter - Contract Tests", () => {
  const adapter = new MollieAdapter("https://api.mollie.com/v2");

  describe("buildRequest", () => {
    it("should build a GET with Bearer auth", () => {
      const input = {
        endpoint: "/payments",
        options: { method: "GET" as const, query: { limit: "5" } },
        authToken: { token: "test_abc123" },
      };
      const built = adapter.buildRequest(input);
      expect(built.url).toBe("https://api.mollie.com/v2/payments?limit=5");
      expect(built.headers.Authorization).toBe("Bearer test_abc123");
    });
  });

  describe("parseResponse", () => {
    it("should normalize response and extract _links.next cursor", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          count: 5,
          _links: { next: { href: "https://api.mollie.com/v2/payments?from=tr_xyz" } },
          _embedded: { payments: [{ id: "tr_abc" }] },
        },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("mollie");
      expect(normalized.meta.pagination?.hasNext).toBe(true);
    });
  });

  describe("parseError", () => {
    it("maps 401 to auth", () => {
      const e = adapter.parseError({ status: 401, headers: new Headers(), body: { detail: "Unauthorized" } });
      expect(e.category).toBe("auth");
    });

    it("maps 429 to rate_limit", () => {
      const e = adapter.parseError({ status: 429, headers: new Headers({ "Retry-After": "10" }), body: {} });
      expect(e.category).toBe("rate_limit");
      expect(e.retryable).toBe(true);
    });

    it("maps 5xx to provider", () => {
      const e = adapter.parseError({ status: 503, headers: new Headers(), body: "Unavailable" });
      expect(e.category).toBe("provider");
      expect(e.retryable).toBe(true);
    });

    it("maps network errors", () => {
      const e = adapter.parseError(new Error("econnreset"));
      expect(e.category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("accepts apiKey", async () => {
      const config: AuthConfig = { apiKey: "live_xyz" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("live_xyz");
    });

    it("throws if no key", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });
  });
});
