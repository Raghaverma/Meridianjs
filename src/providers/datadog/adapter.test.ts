import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeridianError, RawResponse } from "../../core/types.js";
import { DatadogAdapter } from "./adapter.js";

describe("DatadogAdapter - Contract Tests", () => {
  const adapter = new DatadogAdapter("https://api.datadoghq.com/api/");

  describe("buildRequest", () => {
    it("should set DD-API-KEY and DD-APPLICATION-KEY headers", async () => {
      const token = await adapter.authStrategy({ apiKey: "api_key_123", apiSecret: "app_key_456" });
      const built = adapter.buildRequest({
        endpoint: "v1/monitor",
        options: { method: "GET" },
        authToken: token,
      });
      expect(built.headers["DD-API-KEY"]).toBe("api_key_123");
      expect(built.headers["DD-APPLICATION-KEY"]).toBe("app_key_456");
    });

    it("should work with only an API key (no application key)", async () => {
      const token = await adapter.authStrategy({ apiKey: "api_key_only" });
      const built = adapter.buildRequest({
        endpoint: "v1/events",
        options: { method: "POST", body: { title: "Deploy", text: "Deployed v1.2.3" } },
        authToken: token,
      });
      expect(built.headers["DD-API-KEY"]).toBe("api_key_only");
      expect(built.headers["DD-APPLICATION-KEY"]).toBeUndefined();
      expect(built.body).toBe('{"title":"Deploy","text":"Deployed v1.2.3"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should append query params to the URL", async () => {
      const token = await adapter.authStrategy({ apiKey: "k" });
      const built = adapter.buildRequest({
        endpoint: "v2/logs/events/search",
        options: { method: "GET", query: { "page[cursor]": "abc123" } },
        authToken: token,
      });
      expect(built.url).toContain("page%5Bcursor%5D=abc123");
    });

    it("should not include a body for GET requests", async () => {
      const token = await adapter.authStrategy({ apiKey: "k" });
      const built = adapter.buildRequest({
        endpoint: "v1/monitor",
        options: { method: "GET", body: { ignored: true } },
        authToken: token,
      });
      expect(built.body).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { data: [{ id: "abc" }] },
      };
      const normalized = adapter.parseResponse(raw);
      expect(normalized.meta.provider).toBe("datadog");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });
  });

  describe("parseError", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { errors: ["Invalid API key"] },
      });
      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("datadog");
    });

    it("should map 403 to auth category", () => {
      expect(
        adapter.parseError({ status: 403, headers: new Headers(), body: { errors: ["Forbidden"] } })
          .category,
      ).toBe("auth");
    });

    it("should map 404 to validation category", () => {
      expect(
        adapter.parseError({ status: 404, headers: new Headers(), body: {} }).category,
      ).toBe("validation");
    });

    it("should map 429 to rate_limit category and extract Retry-After", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "10" }),
        body: { errors: ["Rate limit exceeded"] },
      });
      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 500 to provider category and mark retryable", () => {
      const error = adapter.parseError({ status: 500, headers: new Headers(), body: {} });
      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category", () => {
      expect(adapter.parseError(new Error("network timeout")).category).toBe("network");
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
  });

  describe("authStrategy", () => {
    it("should accept apiKey + apiSecret (application key)", async () => {
      const token = await adapter.authStrategy({ apiKey: "ak", apiSecret: "appk" });
      expect(token.token).toContain("ak");
      expect(token.token).toContain("appk");
    });

    it("should accept apiKey alone", async () => {
      const token = await adapter.authStrategy({ apiKey: "ak_only" });
      expect(token.token).toBe("ak_only");
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

  describe("rateLimitPolicy", () => {
    it("should parse Datadog rate-limit headers", () => {
      const rl = adapter.rateLimitPolicy(
        new Headers({
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "97",
          "X-RateLimit-Reset": "30",
        }),
      );
      expect(rl.limit).toBe(100);
      expect(rl.remaining).toBe(97);
      expect(rl.reset).toBeInstanceOf(Date);
    });

    it("should return sensible defaults without headers", () => {
      const rl = adapter.rateLimitPolicy(new Headers());
      expect(rl.limit).toBeGreaterThan(0);
      expect(rl.reset).toBeInstanceOf(Date);
    });
  });

  describe("paginationStrategy (meta.page.after cursor)", () => {
    it("should extract the cursor from meta.page.after", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { data: [], meta: { page: { after: "cursor_abc" } } },
      };
      expect(strategy.extractCursor(raw)).toBe("cursor_abc");
      expect(strategy.hasNext(raw)).toBe(true);
    });

    it("should report no next page when there is no cursor", () => {
      const strategy = adapter.paginationStrategy();
      const raw: RawResponse = { status: 200, headers: new Headers(), body: { data: [] } };
      expect(strategy.extractCursor(raw)).toBeNull();
      expect(strategy.hasNext(raw)).toBe(false);
    });

    it("should build the next request using page[cursor]", () => {
      const strategy = adapter.paginationStrategy();
      const next = strategy.buildNextRequest("v2/logs/events/search", { method: "GET" }, "cursor_abc");
      expect(next.options.query?.["page[cursor]"]).toBe("cursor_abc");
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });
  });

  describe("verifyWebhook", () => {
    it("should return true for a valid HMAC-SHA256 signature", () => {
      const secret = "webhook_secret";
      const payload = JSON.stringify({ alert_type: "error", title: "High CPU" });
      const signature = createHmac("sha256", secret).update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, secret)).toBe(true);
    });

    it("should return false for a wrong secret", () => {
      const payload = "raw-body";
      const signature = createHmac("sha256", "real").update(payload).digest("hex");
      expect(adapter.verifyWebhook(payload, signature, "wrong")).toBe(false);
    });
  });
});
