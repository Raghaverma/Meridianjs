import { describe, expect, it } from "vitest";
import type { ErrorContext, RequestContext, ResponseContext } from "../../core/types.js";
import { MeridianError } from "../../core/types.js";
import { PrometheusObservability } from "./prometheus.js";

const reqCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  provider: "stripe",
  endpoint: "/v1/charges/123",
  method: "POST",
  requestId: "r1",
  timestamp: new Date(),
  options: { method: "POST" },
  ...overrides,
});

const resCtx = (overrides: Partial<ResponseContext> = {}): ResponseContext => ({
  provider: "stripe",
  endpoint: "/v1/charges/123",
  method: "POST",
  requestId: "r1",
  statusCode: 200,
  duration: 42,
  timestamp: new Date(),
  ...overrides,
});

const errCtx = (overrides: Partial<ErrorContext> = {}): ErrorContext => ({
  provider: "stripe",
  endpoint: "/v1/charges",
  method: "POST",
  requestId: "r1",
  error: new MeridianError("rate limited", "rate_limit", "stripe", true),
  duration: 12,
  timestamp: new Date(),
  ...overrides,
});

describe("PrometheusObservability", () => {
  it("exposes a requests_total counter with provider/method/endpoint labels", () => {
    const p = new PrometheusObservability();
    p.logRequest(reqCtx());

    const output = p.getMetrics();
    expect(output).toContain("# TYPE meridian_requests_total counter");
    expect(output).toMatch(/meridian_requests_total\{.*provider="stripe".*\} 1/);
  });

  it("normalizes numeric IDs and UUIDs in endpoint labels to reduce cardinality", () => {
    const p = new PrometheusObservability();
    p.logRequest(reqCtx({ endpoint: "/v1/charges/123" }));
    p.logRequest(
      reqCtx({ requestId: "r2", endpoint: "/v1/customers/3fa85f64-5717-4562-b3fc-2c963f66afa6" }),
    );

    const output = p.getMetrics();
    expect(output).toContain('endpoint="/v1/charges/:id"');
    expect(output).toContain('endpoint="/v1/customers/:uuid"');
  });

  it("accumulates counters across multiple events with the same labels", () => {
    const p = new PrometheusObservability();
    p.logRequest(reqCtx());
    p.logRequest(reqCtx({ requestId: "r2" }));
    p.logRequest(reqCtx({ requestId: "r3" }));

    const output = p.getMetrics();
    expect(output).toMatch(/meridian_requests_total\{.*\} 3/);
  });

  it("records request duration as a histogram with buckets, sum, and count", () => {
    const p = new PrometheusObservability();
    p.logResponse(resCtx({ duration: 42 }));
    p.logResponse(resCtx({ duration: 42 }));

    const output = p.getMetrics();
    expect(output).toContain("# TYPE meridian_request_duration_ms histogram");
    // 42ms falls in the 50-bucket and every larger bucket, not the 25-bucket.
    expect(output).toMatch(/meridian_request_duration_ms_bucket\{.*le="25".*\} 0/);
    expect(output).toMatch(/meridian_request_duration_ms_bucket\{.*le="50".*\} 2/);
    expect(output).toMatch(/meridian_request_duration_ms_sum\{.*\} 84/);
    expect(output).toMatch(/meridian_request_duration_ms_count\{.*\} 2/);
  });

  it("tracks errors_total with category and retryable labels, separately from successes", () => {
    const p = new PrometheusObservability();
    p.logError(errCtx());

    const output = p.getMetrics();
    expect(output).toMatch(
      /meridian_errors_total\{.*category="rate_limit".*retryable="true".*\} 1/,
    );
  });

  it("escapes backslashes, quotes, and newlines in label values", () => {
    const p = new PrometheusObservability();
    p.logRequest(reqCtx({ endpoint: 'weird"value\\with\nnewline' }));

    const output = p.getMetrics();
    expect(output).toContain('weird\\"value\\\\with\\nnewline');
  });

  it("applies defaultLabels to every metric", () => {
    const p = new PrometheusObservability({ defaultLabels: { env: "prod" } });
    p.logRequest(reqCtx());

    expect(p.getMetrics()).toContain('env="prod"');
  });

  it("registers ad-hoc recordMetric() calls as their own counter", () => {
    const p = new PrometheusObservability();
    p.recordMetric({ name: "custom.thing", value: 5, tags: { x: "y" }, timestamp: new Date() });

    const output = p.getMetrics();
    expect(output).toContain("meridian_custom_thing");
    expect(output).toMatch(/meridian_custom_thing\{x="y"\} 5/);
  });

  it("omits HELP/TYPE comment lines when includeHelp is false", () => {
    const p = new PrometheusObservability({ includeHelp: false });
    p.logRequest(reqCtx());

    expect(p.getMetrics()).not.toContain("# HELP");
  });

  it("reset() clears all accumulated counters and histograms", () => {
    const p = new PrometheusObservability();
    p.logRequest(reqCtx());
    p.logResponse(resCtx());
    p.reset();

    const output = p.getMetrics();
    expect(output).not.toMatch(/meridian_requests_total\{.+\}/);
    expect(output).not.toMatch(/meridian_request_duration_ms_count\{.+\}/);
  });

  it("uses a custom prefix for every metric name", () => {
    const p = new PrometheusObservability({ prefix: "acme" });
    p.logRequest(reqCtx());

    expect(p.getMetrics()).toContain("acme_requests_total");
  });

  it("logWarning is a no-op", () => {
    const p = new PrometheusObservability();
    expect(() => p.logWarning("test", {})).not.toThrow();
  });
});
