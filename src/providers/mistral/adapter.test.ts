import { describe, expect, it } from "vitest";
import type { AuthConfig, RawResponse } from "../../core/types.js";
import { MistralAdapter } from "./adapter.js";

describe("Mistral Adapter - Contract Tests", () => {
  const adapter = new MistralAdapter("https://api.mistral.ai/v1");

  describe("buildRequest", () => {
    it("builds a POST request with Bearer auth", () => {
      const input = {
        endpoint: "/chat/completions",
        options: {
          method: "POST" as const,
          body: { model: "mistral-small", messages: [{ role: "user", content: "Hi" }] },
        },
        authToken: { token: "mistral-key-abc" },
      };
      const built = adapter.buildRequest(input);
      expect(built.url).toBe("https://api.mistral.ai/v1/chat/completions");
      expect(built.headers.Authorization).toBe("Bearer mistral-key-abc");
    });
  });

  describe("parseResponse", () => {
    it("normalizes a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({ "X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "598" }),
        body: { id: "chat_abc", choices: [{ message: { content: "Hello!" } }] },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("mistral");
      expect(normalized.meta.rateLimit.limit).toBe(600);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses a JSON SSE chunk", () => {
      const chunk = `{"choices":[{"delta":{"content":"hello"}}]}`;
      expect(adapter.parseStreamChunk(chunk)).toEqual(JSON.parse(chunk));
    });
    it("handles [DONE] sentinel", () => {
      expect(adapter.parseStreamChunk("[DONE]")).toEqual({ done: true });
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
      expect(e.provider).toBe("mistral");
    });
    it("maps 429 to rate_limit", () => {
      const e = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "3" }),
        body: {},
      });
      expect(e.category).toBe("rate_limit");
      expect(e.retryable).toBe(true);
    });
    it("maps 5xx to provider", () => {
      const e = adapter.parseError({ status: 503, headers: new Headers(), body: "Unavailable" });
      expect(e.category).toBe("provider");
      expect(e.retryable).toBe(true);
    });
    it("maps network errors", () => {
      const e = adapter.parseError(new Error("fetch econnreset"));
      expect(e.category).toBe("network");
    });
  });

  describe("authStrategy", () => {
    it("accepts apiKey", async () => {
      const config: AuthConfig = { apiKey: "live-key" };
      const token = await adapter.authStrategy(config);
      expect(token.token).toBe("live-key");
    });
    it("throws if no key", async () => {
      await expect(adapter.authStrategy({})).rejects.toThrow();
    });
  });
});
