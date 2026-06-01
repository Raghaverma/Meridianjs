import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { KlarnaAdapter } from "./adapter.js";

describe("Klarna Adapter - Contract Tests", () => {
  const adapter = new KlarnaAdapter("https://api.klarna.com");

  describe("buildRequest", () => {
    it("should build a POST request with Basic auth from username:password compound token", () => {
      const input = {
        endpoint: "/payments/v1/sessions",
        options: {
          method: "POST" as const,
          body: { purchase_country: "SE", purchase_currency: "SEK" },
        },
        authToken: { token: "user123:pass456" },
      };
      const built = adapter.buildRequest(input);
      expect(built.url).toBe("https://api.klarna.com/payments/v1/sessions");
      const expected = Buffer.from("user123:pass456").toString("base64");
      expect(built.headers.Authorization).toBe(`Basic ${expected}`);
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { session_id: "sess_abc", status: "complete" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("klarna");
    });
  });

  describe("parseError", () => {
    it("maps 401 to auth", () => {
      const e = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { message: "Unauthorized" },
      });
      expect(e.category).toBe("auth");
    });

    it("maps 429 to rate_limit", () => {
      const e = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "5" }),
        body: {},
      });
      expect(e.category).toBe("rate_limit");
      expect(e.retryable).toBe(true);
    });

    it("maps 5xx to provider", () => {
      const e = adapter.parseError({ status: 500, headers: new Headers(), body: "Error" });
      expect(e.category).toBe("provider");
      expect(e.retryable).toBe(true);
    });

    it("maps network errors", () => {
      const e = adapter.parseError(new Error("enotfound klarna"));
      expect(e.category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("builds compound token from username + password", async () => {
      const config: AuthConfig = { username: "user123", password: "pass456" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("user123:pass456");
    });

    it("throws if missing credentials", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });
  });
});
