import { describe, it, expect, beforeEach } from "vitest";
import { Meridian } from "../index.js";
import { MeridianError, type ObservabilityAdapter, type Metric } from "../core/types.js";

class MockObservability implements ObservabilityAdapter {
  public requests: any[] = [];
  public responses: any[] = [];
  public errors: any[] = [];
  public metrics: Metric[] = [];
  logRequest(context: any) { this.requests.push(context); }
  logResponse(context: any) { this.responses.push(context); }
  logError(context: any) { this.errors.push(context); }
  logWarning(message: string, metadata?: Record<string, unknown>) {}
  recordMetric(metric: Metric) { this.metrics.push(metric); }
}


class TestAdapter {
  provider = "test";
  async authStrategy(config: any) {
    return { token: "tok" };
  }
  buildRequest(input: any) {
    return {
      url: "https://example.test/ok",
      method: input.options.method ?? "GET",
      headers: input.options.headers ?? {},
      body: typeof input.options.body === "string" ? input.options.body : JSON.stringify(input.options.body ?? {}),
    };
  }
  parseResponse(raw: any) {
    return {
      data: raw.body,
      meta: {
        provider: "test",
        requestId: "r1",
        rateLimit: { limit: 100, remaining: 99, reset: new Date() },
        warnings: [],
        schemaVersion: "1.0.0",
      }
    };
  }
  parseError(raw: any) {
    return new MeridianError(
      "Provider error",
      "provider" as const,
      "test",
      false,
      "",
      { secret: "should-not-be-logged", inner: { apiKey: "topsecret" } }
    );
  }
  rateLimitPolicy(headers: Headers) {
    return { limit: 100, remaining: 99, reset: new Date() };
  }
  paginationStrategy() {
    return {
      extractCursor: () => null,
      extractTotal: () => null,
      hasNext: () => false,
      buildNextRequest: () => ({ endpoint: "", options: {} }),
    };
  }
  getIdempotencyConfig() {
    return { defaultSafeOperations: new Set(), operationOverrides: new Map() };
  }
}

describe("Observability sanitizer", () => {
  let mock: MockObservability;

  beforeEach(() => {
    mock = new MockObservability();
  });

  it("redacts secrets from request logs and metrics", async () => {
    
    (globalThis as any).fetch = async () => {
      const headers = new Headers({ "content-type": "application/json" });
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      };
    };

    const adapters = new Map();
    adapters.set("test", new (TestAdapter as any)());

    const meridian = await Meridian.create({
      providers: { test: { auth: { token: "t" } } },
      observability: [mock as any],
      observabilitySanitizer: { redactedKeys: ["authorization", "apikey", "body"] },
      localUnsafe: true,
    }, adapters as any);

    await (meridian as any).test.get("/endpoint", { headers: { Authorization: "Bearer secret", "X-Api-Key": "abc" }, body: { password: "p" } });

    
    expect(mock.requests.length).toBeGreaterThan(0);
    const req = mock.requests[0];
    expect(req.options.headers.Authorization).toBe("[REDACTED]");
    expect(req.options.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(req.options.body).toBe("[REDACTED]");

    
    expect(mock.metrics.length).toBeGreaterThan(0);
    const m = mock.metrics.find(mm => mm.name === "meridian.request.count");
    expect(m).toBeDefined();
    expect(m!.tags.provider).toBe("test");
  });

  it("redacts secrets from error metadata when adapters return sensitive info", async () => {
    
    (globalThis as any).fetch = async () => {
      const headers = new Headers({});
      return {
        ok: false,
        status: 500,
        headers,
        json: async () => ({ message: "error" }),
        text: async () => "error",
      };
    };

    const adapters = new Map();
    adapters.set("test", new (TestAdapter as any)());

    const meridian = await Meridian.create({
      providers: { test: { auth: { token: "t" } } },
      observability: [mock as any],
      observabilitySanitizer: { redactedKeys: ["secret", "apikey"] },
      localUnsafe: true,
    }, adapters as any);

    await expect((meridian as any).test.get("/endpoint")).rejects.toBeDefined();

    
    expect(mock.errors.length).toBeGreaterThan(0);
    const err = mock.errors[0];
    expect(err.error.metadata).toBeDefined();
    
    expect(err.error.metadata.secret).toBe("[REDACTED]");
    
    expect(err.error.metadata.inner.apiKey).toBe("[REDACTED]");
  });
});
