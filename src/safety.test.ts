import { describe, expect, it } from "vitest";
import {
  type ErrorContext,
  type MeridianConfig,
  MeridianError,
  type Metric,
  type ObservabilityAdapter,
  type RequestContext,
  type ResponseContext,
  type StateStorage,
} from "./core/types.js";
import { Meridian } from "./index.js";

class MockStateStorage implements StateStorage {
  private storage = new Map<string, { value: string; ttl?: number; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.storage.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.storage.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.storage.set(key, { value, ttl: ttlSeconds, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.storage.delete(key);
  }
}

class CapturingObservability implements ObservabilityAdapter {
  requests: RequestContext[] = [];
  responses: ResponseContext[] = [];
  errors: ErrorContext[] = [];
  metrics: Metric[] = [];
  warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];

  logRequest(context: RequestContext): void {
    this.requests.push(context);
  }

  logResponse(context: ResponseContext): void {
    this.responses.push(context);
  }

  logError(context: ErrorContext): void {
    this.errors.push(context);
  }

  logWarning(message: string, metadata?: Record<string, unknown>): void {
    this.warnings.push({ message, metadata });
  }

  recordMetric(metric: Metric): void {
    this.metrics.push(metric);
  }

  clear(): void {
    this.requests = [];
    this.responses = [];
    this.errors = [];
    this.metrics = [];
    this.warnings = [];
  }
}

describe("Safety Guarantees", () => {
  describe("1. Initialization Enforcement", () => {
    it("should throw if methods are called before initialization", async () => {
      const config: MeridianConfig = {
        github: {
          auth: { token: "test-token" },
        },
        localUnsafe: true,
      };

      const meridian = new Meridian(config);

      expect(() => {
        meridian.getCircuitStatus("github");
      }).toThrow("Meridian SDK must be initialized before use");

      await meridian.start();

      expect(() => {
        meridian.getCircuitStatus("github");
      }).not.toThrow();
    });

    it("should work after proper initialization", async () => {
      const meridian = await Meridian.create({
        github: {
          auth: { token: "test-token" },
        },
        localUnsafe: true,
      });

      expect(meridian).toBeDefined();

      expect(() => meridian.getCircuitStatus("github")).not.toThrow();
    });
  });

  describe("2. Fail-Closed State Management", () => {
    it("should throw in distributed mode without StateStorage", async () => {
      const config: MeridianConfig = {
        mode: "distributed",
        github: {
          auth: { token: "test-token" },
        },
      };

      await expect(Meridian.create(config)).rejects.toThrow(
        "Meridian requires a configured stateStorage in 'distributed' mode",
      );
    });

    it("should allow distributed mode with StateStorage", async () => {
      const stateStorage = new MockStateStorage();
      const meridian = await Meridian.create({
        mode: "distributed",
        stateStorage,
        providers: {
          github: {
            auth: { token: "test-token" },
          },
        },
      });

      expect(meridian).toBeDefined();
    });

    it("should throw without StateStorage unless localUnsafe is true", async () => {
      const config: MeridianConfig = {
        github: {
          auth: { token: "test-token" },
        },
      };

      await expect(Meridian.create(config)).rejects.toThrow(
        "Meridian requires a configured stateStorage unless 'localUnsafe' is set to true",
      );
    });

    it("should allow local mode with localUnsafe", async () => {
      const meridian = await Meridian.create({
        mode: "local",
        localUnsafe: true,
        github: {
          auth: { token: "test-token" },
        },
      });

      expect(meridian).toBeDefined();
    });
  });

  describe("3. Centralized Secret Redaction", () => {
    it("should never leak secrets in request logs", async () => {
      const capturingObs = new CapturingObservability();
      const meridian = await Meridian.create({
        github: {
          auth: { token: "secret-token-12345" },
        },
        observability: capturingObs,
        localUnsafe: true,
      });

      try {
        await (meridian as any).github.get("/test", {
          headers: {
            Authorization: "Bearer secret-token-12345",
            "X-API-Key": "api-key-secret",
          },
          body: { password: "secret-password" },
        });
      } catch {}

      const requestLog = capturingObs.requests[0];
      expect(requestLog).toBeDefined();

      const logStr = JSON.stringify(requestLog);
      expect(logStr).not.toContain("secret-token-12345");
      expect(logStr).not.toContain("api-key-secret");
      expect(logStr).not.toContain("secret-password");
      expect(logStr).toContain("[REDACTED]");
    });

    it("should never leak secrets in error logs", async () => {
      const capturingObs = new CapturingObservability();
      const meridian = await Meridian.create({
        github: {
          auth: { token: "secret-token-12345" },
        },
        observability: capturingObs,
        localUnsafe: true,
      });

      try {
        await (meridian as any).github.get("/test", {
          headers: {
            Authorization: "Bearer secret-token-12345",
          },
        });
      } catch {}

      const errorLog = capturingObs.errors[0];
      expect(errorLog).toBeDefined();

      const logStr = JSON.stringify(errorLog);
      expect(logStr).not.toContain("secret-token-12345");
    });

    it("should never leak secrets in metrics", async () => {
      const capturingObs = new CapturingObservability();
      const meridian = await Meridian.create({
        github: {
          auth: { token: "secret-token-12345" },
        },
        observability: capturingObs,
        localUnsafe: true,
      });

      try {
        await (meridian as any).github.get("/test", {
          headers: {
            Authorization: "Bearer secret-token-12345",
          },
        });
      } catch {}

      const metrics = capturingObs.metrics;
      expect(metrics.length).toBeGreaterThan(0);

      for (const metric of metrics) {
        const metricStr = JSON.stringify(metric);
        expect(metricStr).not.toContain("secret-token-12345");

        for (const [_key, value] of Object.entries(metric.tags)) {
          expect(String(value)).not.toContain("secret-token-12345");
        }
      }
    });

    it("should redact sensitive keys in query parameters", async () => {
      const capturingObs = new CapturingObservability();
      const meridian = await Meridian.create({
        github: {
          auth: { token: "test-token" },
        },
        observability: capturingObs,
        localUnsafe: true,
      });

      try {
        await (meridian as any).github.get("/test", {
          query: {
            api_key: "secret-api-key",
            token: "secret-token",
          },
        });
      } catch {}

      const requestLog = capturingObs.requests[0];
      const logStr = JSON.stringify(requestLog);
      expect(logStr).not.toContain("secret-api-key");
      expect(logStr).not.toContain("secret-token");
    });
  });

  describe("4. Adapter Validation Safety", () => {
    it("should fail startup if adapter validation fails", async () => {
      const invalidAdapter = {
        buildRequest: () => ({ url: "test", method: "GET", headers: {} }),
        parseResponse: () => ({
          data: {},
          meta: {
            provider: "test",
            requestId: "1",
            rateLimit: { limit: 1, remaining: 1, reset: new Date() },
            warnings: [],
            schemaVersion: "1.0",
          },
        }),
        parseError: () => {
          throw new Error("Invalid adapter");
        },
        authStrategy: async () => ({ token: "test" }),
        rateLimitPolicy: () => ({ limit: 1, remaining: 1, reset: new Date() }),
        paginationStrategy: () => ({
          extractCursor: () => null,
          extractTotal: () => null,
          hasNext: () => false,
          buildNextRequest: () => ({ endpoint: "", options: {} }),
        }),
        getIdempotencyConfig: () => ({
          defaultSafeOperations: new Set(),
          operationOverrides: new Map(),
        }),
      };

      await expect(
        Meridian.create({
          providers: {
            test: {
              auth: { token: "test" },
              adapter: invalidAdapter as any,
            },
          },
          localUnsafe: true,
        }),
      ).rejects.toThrow("Adapter validation failed");
    });

    it("should not trigger side effects during validation", async () => {
      let sideEffectTriggered = false;

      const adapterWithSideEffect = {
        buildRequest: () => ({ url: "test", method: "GET", headers: {} }),
        parseResponse: () => ({
          data: {},
          meta: {
            provider: "test",
            requestId: "1",
            rateLimit: { limit: 1, remaining: 1, reset: new Date() },
            warnings: [],
            schemaVersion: "1.0",
          },
        }),
        parseError: () => {
          return new MeridianError("test", "provider", "test", false, "");
        },
        authStrategy: async (config: any) => {
          if (config.token === "MERIDIAN_TEST_TOKEN_DO_NOT_VALIDATE") {
            return { token: "test-token" };
          }
          sideEffectTriggered = true;
          return { token: config.token };
        },
        rateLimitPolicy: () => ({ limit: 1, remaining: 1, reset: new Date() }),
        paginationStrategy: () => ({
          extractCursor: () => null,
          extractTotal: () => null,
          hasNext: () => false,
          buildNextRequest: () => ({ endpoint: "", options: {} }),
        }),
        getIdempotencyConfig: () => ({
          defaultSafeOperations: new Set(),
          operationOverrides: new Map(),
        }),
      };

      await Meridian.create({
        providers: {
          test: {
            auth: { token: "real-token" },
            adapter: adapterWithSideEffect as any,
          },
        },
        localUnsafe: true,
      });

      expect(sideEffectTriggered).toBe(false);
    });
  });

  describe("5. Pagination Safety", () => {
    it("should detect pagination cycles", async () => {
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ items: [] }),
        text: async () => JSON.stringify({ items: [] }),
      });

      let _callCount = 0;
      const adapter = {
        buildRequest: () => ({ url: "test", method: "GET", headers: {} }),
        parseResponse: (_raw: any) => {
          _callCount++;

          return {
            data: { items: [] },
            meta: {
              provider: "test",
              requestId: "1",
              rateLimit: { limit: 1, remaining: 1, reset: new Date() },
              pagination: {
                hasNext: true,
                cursor: "same-cursor",
              },
              warnings: [],
              schemaVersion: "1.0",
            },
          };
        },
        parseError: () => {
          return new MeridianError("test", "provider", "test", false, "");
        },
        authStrategy: async () => ({ token: "test" }),
        rateLimitPolicy: () => ({ limit: 1, remaining: 1, reset: new Date() }),
        paginationStrategy: () => ({
          extractCursor: () => "same-cursor",
          extractTotal: () => null,
          hasNext: () => true,
          buildNextRequest: () => ({ endpoint: "/test", options: {} }),
        }),
        getIdempotencyConfig: () => ({
          defaultSafeOperations: new Set(),
          operationOverrides: new Map(),
        }),
      };

      const meridian = await Meridian.create({
        providers: {
          test: {
            auth: { token: "test" },
            adapter: adapter as any,
          },
        },
        localUnsafe: true,
      });

      const paginator = (meridian as any).test.paginate("/test");

      let errorThrown = false;
      try {
        for await (const _ of paginator) {
        }
      } catch (error: any) {
        errorThrown = true;
        expect(error.message).toContain("Pagination cycle detected");
      }
      expect(errorThrown).toBe(true);
    });

    it("should enforce max page limit deterministically", async () => {
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ items: [] }),
        text: async () => JSON.stringify({ items: [] }),
      });

      let _requestCount = 0;
      let paginationCallCount = 0;
      const adapter = {
        buildRequest: () => ({ url: "test", method: "GET", headers: {} }),
        parseResponse: (raw: any) => {
          _requestCount++;

          const isValidation = raw.status === 200 && raw.body?.test === "data";
          if (!isValidation) {
            paginationCallCount++;
          }

          const hasMore = paginationCallCount < 3 && !isValidation;
          return {
            data: { items: [] },
            meta: {
              provider: "test",
              requestId: "1",
              rateLimit: { limit: 1, remaining: 1, reset: new Date() },
              pagination: {
                hasNext: hasMore,
                cursor: hasMore ? `cursor-${paginationCallCount}` : undefined,
              },
              warnings: [],
              schemaVersion: "1.0",
            },
          };
        },
        parseError: () => {
          return new MeridianError("test", "provider", "test", false, "");
        },
        authStrategy: async () => ({ token: "test" }),
        rateLimitPolicy: () => ({ limit: 1, remaining: 1, reset: new Date() }),
        paginationStrategy: () => ({
          extractCursor: (response: any) => response.meta.pagination?.cursor ?? null,
          extractTotal: () => null,
          hasNext: (response: any) => response.meta.pagination?.hasNext ?? false,
          buildNextRequest: () => ({ endpoint: "/test", options: {} }),
        }),
        getIdempotencyConfig: () => ({
          defaultSafeOperations: new Set(),
          operationOverrides: new Map(),
        }),
      };

      const meridian = await Meridian.create({
        providers: {
          test: {
            auth: { token: "test" },
            adapter: adapter as any,
          },
        },
        localUnsafe: true,
      });

      const paginator = (meridian as any).test.paginate("/test");

      let pagesYielded = 0;
      for await (const _page of paginator) {
        pagesYielded++;
      }
      expect(pagesYielded).toBe(3);
      expect(paginationCallCount).toBe(3);
    });
  });

  describe("6. Typed Public API", () => {
    it("should have typed request options", async () => {
      (globalThis as any).fetch = async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ message: "Not found" }),
        text: async () => "Not found",
      });

      const meridian = await Meridian.create({
        github: {
          auth: { token: "test-token" },
        },
        localUnsafe: true,
      });

      const client = (meridian as any).github;

      await expect(
        client.get("/test", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          query: { page: 1 },
        }),
      ).rejects.toThrow();
    });
  });
});
