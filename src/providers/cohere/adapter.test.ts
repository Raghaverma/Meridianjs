import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { CohereAdapter } from "./adapter.js";

describe("Cohere Adapter - Contract Tests", () => {
  const adapter = new CohereAdapter("https://api.cohere.ai/v1");

  describe("buildRequest", () => {
    it("builds a POST with Bearer auth", () => {
      const input = {
        endpoint: "/chat",
        options: { method: "POST" as const, body: { model: "command-r", message: "Hello" } },
        authToken: { token: "co-test-key" },
      };
      const built = adapter.buildRequest(input);
      expect(built.url).toBe("https://api.cohere.ai/v1/chat");
      expect(built.headers.Authorization).toBe("Bearer co-test-key");
      expect(built.body).toBe(JSON.stringify(input.options.body));
    });
  });

  describe("parseResponse", () => {
    it("normalizes a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({ "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "999" }),
        body: { id: "gen_abc", text: "Hello there" },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("cohere");
      expect(normalized.meta.rateLimit.limit).toBe(1000);
    });
  });

  describe("parseError", () => {
    it("maps 401 to auth", () => {
      const e = adapter.parseError({ status: 401, headers: new Headers(), body: { message: "invalid api token" } });
      expect(e.category).toBe("auth");
      expect(e.provider).toBe("cohere");
    });

    it("maps 429 to rate_limit", () => {
      const e = adapter.parseError({ status: 429, headers: new Headers({ "Retry-After": "2" }), body: {} });
      expect(e.category).toBe("rate_limit");
      expect(e.retryable).toBe(true);
    });

    it("maps 5xx to provider", () => {
      const e = adapter.parseError({ status: 500, headers: new Headers(), body: "Internal Error" });
      expect(e.category).toBe("provider");
      expect(e.retryable).toBe(true);
    });

    it("maps network errors", () => {
      const e = adapter.parseError(new Error("fetch failed: econnreset"));
      expect(e.category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("accepts apiKey", async () => {
      const config: AuthConfig = { apiKey: "co-live-key" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("co-live-key");
    });

    it("throws if no key", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });
  });
});
