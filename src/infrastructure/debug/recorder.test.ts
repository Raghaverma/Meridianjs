import { describe, expect, it } from "vitest";
import type { ErrorContext, RequestContext, ResponseContext } from "../core/types.js";
import { CircuitState, MeridianError } from "../core/types.js";
import { DebugRecorder } from "./recorder.js";

const reqCtx = (requestId: string, provider = "stripe"): RequestContext => ({
  provider,
  endpoint: "/v1/charges",
  method: "POST",
  requestId,
  timestamp: new Date(),
  options: { method: "POST" },
});

const resCtx = (requestId: string, provider = "stripe"): ResponseContext => ({
  provider,
  endpoint: "/v1/charges",
  method: "POST",
  requestId,
  statusCode: 200,
  duration: 241,
  timestamp: new Date(),
  trace: { retries: 0, latency: 241, circuitBreaker: CircuitState.CLOSED, rateLimitRemaining: 99 },
});

const errCtx = (requestId: string, provider = "stripe"): ErrorContext => ({
  provider,
  endpoint: "/v1/charges",
  method: "POST",
  requestId,
  error: new MeridianError("fail", "network", provider, true),
  duration: 5000,
  timestamp: new Date(),
});

describe("DebugRecorder", () => {
  it("starts disabled", () => {
    const r = new DebugRecorder();
    expect(r.enabled).toBe(false);
    expect(r.recordings()).toHaveLength(0);
  });

  it("does not record when disabled", () => {
    const r = new DebugRecorder();
    r.logRequest(reqCtx("r1"));
    r.logResponse(resCtx("r1"));
    expect(r.recordings()).toHaveLength(0);
  });

  it("records successful requests when enabled", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r1"));
    r.logResponse(resCtx("r1"));
    const recs = r.recordings();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.requestId).toBe("r1");
    expect(recs[0]!.statusCode).toBe(200);
    expect(recs[0]!.duration).toBe(241);
  });

  it("records failed requests with error message", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r2"));
    r.logError(errCtx("r2"));
    const recs = r.recordings();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.error).toBe("fail");
    expect(recs[0]!.duration).toBe(5000);
  });

  it("captures trace on successful response", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r3"));
    r.logResponse(resCtx("r3"));
    const rec = r.recordings()[0]!;
    expect(rec.trace?.retries).toBe(0);
    expect(rec.trace?.latency).toBe(241);
    expect(rec.trace?.circuitBreaker).toBe(CircuitState.CLOSED);
  });

  it("merges rawOptions into recording", () => {
    const r = new DebugRecorder();
    r.enable();
    const opts = { method: "POST" as const, body: { amount: 1000 } };
    r.recordRaw("r4", opts);
    r.logRequest(reqCtx("r4"));
    r.logResponse(resCtx("r4"));
    const rec = r.recordings()[0]!;
    expect(rec.options?.body).toEqual({ amount: 1000 });
  });

  it("merges rawOptions into error recordings", () => {
    const r = new DebugRecorder();
    r.enable();
    r.recordRaw("r5", { method: "POST" as const, body: { x: 1 } });
    r.logRequest(reqCtx("r5"));
    r.logError(errCtx("r5"));
    expect(r.recordings()[0]!.options?.body).toEqual({ x: 1 });
  });

  it("recordRaw is a no-op when disabled", () => {
    const r = new DebugRecorder();
    r.recordRaw("r6", { method: "GET" as const });
    r.enable();
    r.logRequest(reqCtx("r6"));
    r.logResponse(resCtx("r6"));
    // options should not be present since recordRaw was called before enable
    expect(r.recordings()[0]!.options).toBeUndefined();
  });

  it("clear removes all recordings and pending", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r7"));
    r.logResponse(resCtx("r7"));
    r.clear();
    expect(r.recordings()).toHaveLength(0);
  });

  it("disable stops new recordings but keeps existing", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r8"));
    r.logResponse(resCtx("r8"));
    r.disable();
    r.logRequest(reqCtx("r9"));
    r.logResponse(resCtx("r9"));
    expect(r.recordings()).toHaveLength(1);
  });

  it("recordings() returns a copy, not internal reference", () => {
    const r = new DebugRecorder();
    r.enable();
    r.logRequest(reqCtx("r10"));
    r.logResponse(resCtx("r10"));
    const snapshot = r.recordings();
    r.clear();
    expect(snapshot).toHaveLength(1);
    expect(r.recordings()).toHaveLength(0);
  });

  it("logWarning and recordMetric are no-ops", () => {
    const r = new DebugRecorder();
    expect(() => {
      r.logWarning("test");
      r.recordMetric({ name: "m", value: 1, tags: {}, timestamp: new Date() });
    }).not.toThrow();
  });
});
