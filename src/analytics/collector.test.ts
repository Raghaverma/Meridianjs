import { describe, expect, it } from "vitest";
import type { ErrorContext, ResponseContext } from "../core/types.js";
import { MeridianError } from "../core/types.js";
import { AnalyticsCollector } from "./collector.js";

const makeResponseCtx = (provider: string, duration: number): ResponseContext => ({
  provider,
  endpoint: "/test",
  method: "GET",
  requestId: "req-1",
  statusCode: 200,
  duration,
  timestamp: new Date(),
});

const makeErrorCtx = (provider: string, duration: number): ErrorContext => ({
  provider,
  endpoint: "/test",
  method: "GET",
  requestId: "req-2",
  error: new MeridianError("fail", "provider", provider, true),
  duration,
  timestamp: new Date(),
});

describe("AnalyticsCollector", () => {
  it("starts with empty stats", () => {
    const col = new AnalyticsCollector();
    expect(col.get()).toEqual({});
  });

  it("tracks request count on logResponse", () => {
    const col = new AnalyticsCollector();
    col.logResponse(makeResponseCtx("stripe", 100));
    col.logResponse(makeResponseCtx("stripe", 200));
    expect(col.get().stripe?.requests).toBe(2);
    expect(col.get().stripe?.errors).toBe(0);
  });

  it("tracks error count on logError", () => {
    const col = new AnalyticsCollector();
    col.logResponse(makeResponseCtx("stripe", 100));
    col.logError(makeErrorCtx("stripe", 150));
    const stats = col.get().stripe!;
    expect(stats.requests).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.errorRate).toBe("50.0%");
    expect(stats.successRate).toBe("50.0%");
  });

  it("computes avgLatency correctly", () => {
    const col = new AnalyticsCollector();
    col.logResponse(makeResponseCtx("stripe", 100));
    col.logResponse(makeResponseCtx("stripe", 300));
    expect(col.get().stripe?.avgLatency).toBe(200);
  });

  it("computes p95Latency correctly", () => {
    const col = new AnalyticsCollector();
    for (let i = 1; i <= 100; i++) {
      col.logResponse(makeResponseCtx("stripe", i * 10));
    }
    const stats = col.get().stripe!;
    // p95 should be around 950ms (95th percentile of 10..1000)
    expect(stats.p95Latency).toBeGreaterThanOrEqual(900);
    expect(stats.p95Latency).toBeLessThanOrEqual(1000);
  });

  it("tracks multiple providers independently", () => {
    const col = new AnalyticsCollector();
    col.logResponse(makeResponseCtx("stripe", 100));
    col.logResponse(makeResponseCtx("razorpay", 200));
    const stats = col.get();
    expect(Object.keys(stats)).toHaveLength(2);
    expect(stats.stripe?.requests).toBe(1);
    expect(stats.razorpay?.requests).toBe(1);
  });

  it("reset clears all stats", () => {
    const col = new AnalyticsCollector();
    col.logResponse(makeResponseCtx("stripe", 100));
    col.reset();
    expect(col.get()).toEqual({});
  });

  describe("getHealth", () => {
    it("returns healthy for 100% success rate", () => {
      const col = new AnalyticsCollector();
      for (let i = 0; i < 10; i++) col.logResponse(makeResponseCtx("stripe", 100));
      expect(col.getHealth().stripe?.status).toBe("healthy");
    });

    it("returns degraded for 96-98% success rate", () => {
      const col = new AnalyticsCollector();
      for (let i = 0; i < 97; i++) col.logResponse(makeResponseCtx("stripe", 100));
      for (let i = 0; i < 3; i++) col.logError(makeErrorCtx("stripe", 100));
      expect(col.getHealth().stripe?.status).toBe("degraded");
    });

    it("returns down for <95% success rate", () => {
      const col = new AnalyticsCollector();
      for (let i = 0; i < 80; i++) col.logResponse(makeResponseCtx("stripe", 100));
      for (let i = 0; i < 20; i++) col.logError(makeErrorCtx("stripe", 100));
      expect(col.getHealth().stripe?.status).toBe("down");
    });

    it("includes successRate and avgLatency", () => {
      const col = new AnalyticsCollector();
      col.logResponse(makeResponseCtx("stripe", 250));
      const h = col.getHealth().stripe!;
      expect(h.successRate).toBe("100.0%");
      expect(h.avgLatency).toBe(250);
    });
  });

  it("logRequest and logWarning and recordMetric are no-ops (no crash)", () => {
    const col = new AnalyticsCollector();
    expect(() => {
      col.logRequest({
        provider: "x",
        endpoint: "/",
        method: "GET",
        requestId: "r",
        timestamp: new Date(),
        options: {},
      });
      col.logWarning("warn");
      col.recordMetric({ name: "m", value: 1, tags: {}, timestamp: new Date() });
    }).not.toThrow();
  });
});
