import { describe, expect, it } from "vitest";
import type { RawResponse } from "../../../core/types.js";
import { GeminiAdapter } from "./adapter.js";

describe("Gemini Adapter - Contract Tests", () => {
  const adapter = new GeminiAdapter("https://generativelanguage.googleapis.com");

  // ─── buildRequest ────────────────────────────────────────────────────────────

  describe("buildRequest", () => {
    it("should build a request with x-goog-api-key header when using standard API key", () => {
      const input = {
        endpoint: "/v1beta/models/gemini-pro:generateContent",
        options: { method: "POST" as const, body: { contents: [] } },
        authToken: { token: "gemini_api_key_123" },
      };

      const built = adapter.buildRequest(input);

      expect(built.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      );
      expect(built.method).toBe("POST");
      expect(built.headers["x-goog-api-key"]).toBe("gemini_api_key_123");
      expect(built.headers.Authorization).toBeUndefined();
    });

    it("should build a request with Authorization Bearer header when using OAuth2 token", () => {
      const input = {
        endpoint: "/v1beta/models/gemini-pro:generateContent",
        options: { method: "POST" as const, body: { contents: [] } },
        authToken: { token: "ya29.google_oauth_token" },
      };

      const built = adapter.buildRequest(input);

      expect(built.headers.Authorization).toBe("Bearer ya29.google_oauth_token");
      expect(built.headers["x-goog-api-key"]).toBeUndefined();
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
        body: {
          candidates: [{ content: { parts: [{ text: "Hello!" }] } }],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta).toHaveProperty("provider", "gemini");
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
          error: {
            message: "API key not valid",
            status: "UNAUTHENTICATED",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.message).toBe("API key not valid");
    });

    it("should map 429 to rate_limit category", () => {
      const raw = {
        status: 429,
        headers: new Headers(),
        body: {
          error: {
            message: "Resource has been exhausted",
            status: "RESOURCE_EXHAUSTED",
          },
        },
      };

      const error = adapter.parseError(raw);

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });
  });

  // ─── parseStreamChunk ─────────────────────────────────────────────────────────

  describe("parseStreamChunk", () => {
    it("should parse an SSE chunk payload string to JSON", () => {
      const chunkStr = '{"candidates":[{"content":{"parts":[{"text":"chunk text"}]}}]}';
      const parsed = adapter.parseStreamChunk?.(chunkStr);
      expect(parsed).toEqual({
        candidates: [{ content: { parts: [{ text: "chunk text" }] } }],
      });
    });
  });
});
