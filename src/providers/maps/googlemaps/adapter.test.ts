import { describe, expect, it } from "vitest";
import type { AuthConfig, MeridianError, RawResponse } from "../../../core/types.js";
import { GoogleMapsAdapter } from "./adapter.js";

describe("GoogleMapsAdapter", () => {
  const adapter = new GoogleMapsAdapter("https://maps.googleapis.com/maps/api");

  describe("buildRequest", () => {
    it("should append the API key as a query parameter", () => {
      const built = adapter.buildRequest({
        endpoint: "/geocode/json",
        options: { method: "GET", query: { address: "1600+Amphitheatre+Parkway" } },
        authToken: { token: "AIzaTestKey123" },
      });

      expect(built.url).toContain("key=AIzaTestKey123");
      expect(built.url).toContain("address=1600%2BAmphitheatre%2BParkway");
      expect(built.method).toBe("GET");
    });

    it("should not allow callers to overwrite the key parameter", () => {
      const built = adapter.buildRequest({
        endpoint: "/geocode/json",
        options: { method: "GET", query: { key: "attacker-key", address: "test" } },
        authToken: { token: "AIzaRealKey" },
      });

      const url = new URL(built.url);
      expect(url.searchParams.get("key")).toBe("AIzaRealKey");
    });

    it("should include User-Agent and Accept headers", () => {
      const built = adapter.buildRequest({
        endpoint: "/place/nearbysearch/json",
        options: { method: "GET" },
        authToken: { token: "AIzaTestKey" },
      });

      expect(built.headers["User-Agent"]).toMatch(/^Meridian-SDK\//);
      expect(built.headers.Accept).toBe("application/json");
    });

    it("should serialize body and set Content-Type for POST requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/roads/v1/snapToRoads",
        options: { method: "POST", body: { path: "60.170880,24.942795" } },
        authToken: { token: "AIzaTestKey" },
      });

      expect(built.body).toBe('{"path":"60.170880,24.942795"}');
      expect(built.headers["Content-Type"]).toBe("application/json");
    });

    it("should not include body for GET requests", () => {
      const built = adapter.buildRequest({
        endpoint: "/geocode/json",
        options: { method: "GET", body: { ignored: true } },
        authToken: { token: "AIzaTestKey" },
      });

      expect(built.body).toBeUndefined();
    });

    it("should use a custom baseUrl when provided", () => {
      const built = adapter.buildRequest({
        endpoint: "/geocode/json",
        options: { method: "GET" },
        authToken: { token: "AIzaTestKey" },
        baseUrl: "https://custom.proxy.example.com/maps/api",
      });

      expect(built.url).toContain("custom.proxy.example.com");
    });
  });

  describe("parseResponse", () => {
    it("should normalize a successful geocode response", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: {
          status: "OK",
          results: [
            {
              formatted_address: "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA",
              geometry: { location: { lat: 37.4224764, lng: -122.0842499 } },
            },
          ],
        },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta.provider).toBe("googlemaps");
      expect(normalized.meta).toHaveProperty("rateLimit");
      expect(normalized.meta.rateLimit.reset).toBeInstanceOf(Date);
    });

    it("should return default rate-limit info (no headers from Maps API)", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { status: "OK", results: [] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized.meta.rateLimit.limit).toBeGreaterThan(0);
      expect(normalized.meta.rateLimit.remaining).toBeGreaterThan(0);
    });
  });

  describe("parseError — HTTP error codes", () => {
    it("should map 401 to auth category", () => {
      const error = adapter.parseError({
        status: 401,
        headers: new Headers(),
        body: { error: { message: "API key not valid." } },
      });

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
      expect(error.provider).toBe("googlemaps");
    });

    it("should map 403 to auth category", () => {
      const error = adapter.parseError({
        status: 403,
        headers: new Headers(),
        body: { error: { message: "The caller does not have permission." } },
      });

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map 404 to validation category", () => {
      const error = adapter.parseError({
        status: 404,
        headers: new Headers(),
        body: {},
      });

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map 429 to rate_limit with retryable=true", () => {
      const error = adapter.parseError({
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        body: {},
      });

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBeInstanceOf(Date);
    });

    it("should map 500 to provider category with retryable=true", () => {
      const error = adapter.parseError({
        status: 500,
        headers: new Headers(),
        body: {},
      });

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map 503 to provider category with retryable=true", () => {
      const error = adapter.parseError({
        status: 503,
        headers: new Headers(),
        body: {},
      });

      expect(error.category).toBe("provider");
      expect(error.retryable).toBe(true);
    });

    it("should map network errors to network category with retryable=true", () => {
      const error = adapter.parseError(new Error("fetch failed: connection refused"));

      expect(error.category).toBe("network");
      expect(error.retryable).toBe(true);
    });

    it("should always return provider=googlemaps", () => {
      const statuses = [401, 403, 404, 429, 500];
      for (const status of statuses) {
        const error = adapter.parseError({ status, headers: new Headers(), body: {} });
        expect(error.provider).toBe("googlemaps");
      }
    });
  });

  describe("parseError — Google Maps API-level status codes", () => {
    it("should map OVER_QUERY_LIMIT to rate_limit with retryable=true", () => {
      const error = adapter.parseError({
        status: 200,
        headers: new Headers(),
        body: {
          status: "OVER_QUERY_LIMIT",
          error_message: "You have exceeded your daily request quota.",
        },
      });

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map OVER_DAILY_LIMIT to rate_limit with retryable=true", () => {
      const error = adapter.parseError({
        status: 200,
        headers: new Headers(),
        body: { status: "OVER_DAILY_LIMIT" },
      });

      expect(error.category).toBe("rate_limit");
      expect(error.retryable).toBe(true);
    });

    it("should map REQUEST_DENIED to auth with retryable=false", () => {
      const error = adapter.parseError({
        status: 200,
        headers: new Headers(),
        body: {
          status: "REQUEST_DENIED",
          error_message: "This API project is not authorized to use this API.",
        },
      });

      expect(error.category).toBe("auth");
      expect(error.retryable).toBe(false);
    });

    it("should map INVALID_REQUEST to validation with retryable=false", () => {
      const error = adapter.parseError({
        status: 200,
        headers: new Headers(),
        body: { status: "INVALID_REQUEST", error_message: "Missing required parameter: address." },
      });

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });

    it("should map NOT_FOUND to validation with retryable=false", () => {
      const error = adapter.parseError({
        status: 200,
        headers: new Headers(),
        body: { status: "NOT_FOUND" },
      });

      expect(error.category).toBe("validation");
      expect(error.retryable).toBe(false);
    });
  });

  describe("authStrategy", () => {
    it("should accept config.apiKey", async () => {
      const config: AuthConfig = { apiKey: "AIzaTestKey123" };
      const token = await adapter.authStrategy(config);
      expect(token).toMatchObject({ token: "AIzaTestKey123" });
    });

    it("should accept config.token as fallback", async () => {
      const config: AuthConfig = { token: "AIzaFallbackKey" };
      const token = await adapter.authStrategy(config);
      expect(token).toMatchObject({ token: "AIzaFallbackKey" });
    });

    it("should throw a MeridianError for missing credentials", async () => {
      const config: AuthConfig = {};
      await expect(adapter.authStrategy(config)).rejects.toThrow();

      try {
        await adapter.authStrategy(config);
      } catch (error) {
        const e = error as MeridianError;
        expect(e.category).toBe("auth");
        expect(e.provider).toBe("googlemaps");
      }
    });
  });

  describe("rateLimitPolicy", () => {
    it("should return sensible defaults (Google Maps has no rate-limit headers)", () => {
      const rateLimit = adapter.rateLimitPolicy(new Headers());

      expect(rateLimit).toMatchObject({
        limit: expect.any(Number),
        remaining: expect.any(Number),
        reset: expect.any(Date),
      });
      expect(rateLimit.limit).toBeGreaterThan(0);
    });
  });

  describe("paginationStrategy", () => {
    it("should return a strategy with extractCursor and hasNext", () => {
      const strategy = adapter.paginationStrategy();

      expect(strategy).toHaveProperty("extractCursor");
      expect(strategy).toHaveProperty("hasNext");
      expect(strategy).toHaveProperty("buildNextRequest");
    });

    it("should extract next_page_token from the response body", () => {
      const strategy = adapter.paginationStrategy();
      const response: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: {
          status: "OK",
          next_page_token: "CpQCAgEA...",
          results: [],
        },
      };

      expect(strategy.extractCursor(response)).toBe("CpQCAgEA...");
      expect(strategy.hasNext(response)).toBe(true);
    });

    it("should return null when there is no next_page_token", () => {
      const strategy = adapter.paginationStrategy();
      const response: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { status: "OK", results: [] },
      };

      expect(strategy.extractCursor(response)).toBeNull();
      expect(strategy.hasNext(response)).toBe(false);
    });

    it("should build next request with pagetoken query param", () => {
      const strategy = adapter.paginationStrategy();
      const next = strategy.buildNextRequest(
        "/place/nearbysearch/json",
        { method: "GET", query: { location: "37.4,-122.0", radius: "500" } },
        "CpQCAgEA...",
      );

      expect(next.options.query).toMatchObject({
        location: "37.4,-122.0",
        radius: "500",
        pagetoken: "CpQCAgEA...",
      });
    });
  });

  describe("getIdempotencyConfig", () => {
    it("should mark GET as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("GET")).toBe(true);
    });

    it("should mark HEAD as safe", () => {
      expect(adapter.getIdempotencyConfig().defaultSafeOperations.has("HEAD")).toBe(true);
    });
  });

  describe("Contract Invariants", () => {
    it("should always return provider=googlemaps on errors", () => {
      const error = adapter.parseError({ status: 401, headers: new Headers(), body: {} });
      expect(error.provider).toBe("googlemaps");
    });

    it("should always normalize responses to Meridian structure", () => {
      const raw: RawResponse = {
        status: 200,
        headers: new Headers(),
        body: { status: "OK", results: [{ place_id: "ChIJ..." }] },
      };

      const normalized = adapter.parseResponse(raw);

      expect(normalized).toHaveProperty("data");
      expect(normalized).toHaveProperty("meta");
      expect(normalized.meta.provider).toBe("googlemaps");
      expect(normalized.meta).toHaveProperty("rateLimit");
    });

    it("should always return canonical error categories", () => {
      const cases = [
        { status: 401, expected: "auth" },
        { status: 403, expected: "auth" },
        { status: 404, expected: "validation" },
        { status: 429, expected: "rate_limit" },
        { status: 500, expected: "provider" },
      ];

      for (const { status, expected } of cases) {
        const error = adapter.parseError({ status, headers: new Headers(), body: {} });
        expect(error.category).toBe(expected);
      }
    });
  });
});
