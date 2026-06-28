import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorContext, RequestContext, ResponseContext } from "../../core/types.js";
import { MeridianError } from "../../core/types.js";
import { Meridian } from "../../index.js";
import { MockAdapter } from "../../testing/mock-adapter.js";
import type { ReliabilityEvent, ReliabilitySession } from "./recorder.js";
import { ReliabilityRecorder } from "./recorder.js";
import { renderTimeline, replaySession, summarizeSession } from "./replayer.js";
import { ReliabilityStore } from "./store.js";

function requestCtx(provider: string, endpoint: string, requestId: string): RequestContext {
  return {
    provider,
    endpoint,
    method: "GET",
    requestId,
    timestamp: new Date(),
    options: { method: "GET" },
  };
}

function responseCtx(
  provider: string,
  endpoint: string,
  requestId: string,
  extra: Partial<ResponseContext> = {},
): ResponseContext {
  return {
    provider,
    endpoint,
    method: "GET",
    requestId,
    statusCode: 200,
    duration: 50,
    timestamp: new Date(),
    ...extra,
  };
}

function errorCtx(provider: string, endpoint: string, requestId: string): ErrorContext {
  return {
    provider,
    endpoint,
    method: "GET",
    requestId,
    error: new MeridianError("HTTP 503", "provider", provider, true),
    duration: 80,
    timestamp: new Date(),
  };
}

/** A hand-built outage: openai fails (breaker opens), traffic fails over to anthropic. */
function outageSession(): ReliabilitySession {
  const e = (
    partial: Partial<ReliabilityEvent> & Pick<ReliabilityEvent, "type" | "offsetMs" | "provider">,
  ): ReliabilityEvent => ({
    at: new Date(1700000000000 + partial.offsetMs).toISOString(),
    endpoint: "/v1/chat",
    method: "POST",
    requestId: `r${partial.offsetMs}`,
    ...partial,
  });
  return {
    version: 1,
    name: "outage-test",
    startedAt: new Date(1700000000000).toISOString(),
    endedAt: new Date(1700000010000).toISOString(),
    events: [
      e({ type: "request", offsetMs: 0, provider: "openai" }),
      e({
        type: "response",
        offsetMs: 120,
        provider: "openai",
        statusCode: 200,
        duration: 120,
        retries: 0,
        circuitBreaker: "CLOSED",
      }),
      e({ type: "request", offsetMs: 500, provider: "openai" }),
      e({
        type: "error",
        offsetMs: 900,
        provider: "openai",
        errorCategory: "provider",
        errorMessage: "HTTP 503",
        retryable: true,
        duration: 400,
        circuitBreaker: "OPEN",
      }),
      e({ type: "request", offsetMs: 950, provider: "anthropic" }),
      e({
        type: "response",
        offsetMs: 1500,
        provider: "anthropic",
        statusCode: 200,
        duration: 550,
        retries: 2,
        circuitBreaker: "CLOSED",
      }),
    ],
  };
}

describe("ReliabilityRecorder", () => {
  it("is inert until started", () => {
    const recorder = new ReliabilityRecorder();
    recorder.logRequest(requestCtx("github", "/a", "r1"));
    expect(recorder.recording).toBe(false);
    expect(() => recorder.stop()).toThrow(/No recording session/);
  });

  it("captures request, response, and error events with offsets", () => {
    const recorder = new ReliabilityRecorder(() => "OPEN");
    recorder.start("incident-1");
    recorder.logRequest(requestCtx("github", "/repos", "r1"));
    recorder.logResponse(
      responseCtx("github", "/repos", "r1", {
        trace: {
          retries: 1,
          latency: 42,
          circuitBreaker: "CLOSED" as never,
          rateLimitRemaining: 99,
        },
      }),
    );
    recorder.logError(errorCtx("github", "/repos", "r2"));
    const session = recorder.stop();

    expect(session.name).toBe("incident-1");
    expect(session.events).toHaveLength(3);
    expect(session.events[1]).toMatchObject({ type: "response", retries: 1, statusCode: 200 });
    // Error events get breaker state from the injected resolver.
    expect(session.events[2]).toMatchObject({
      type: "error",
      errorCategory: "provider",
      circuitBreaker: "OPEN",
      retryable: true,
    });
    expect(session.events.every((e) => e.offsetMs >= 0)).toBe(true);
  });

  it("rejects overlapping sessions", () => {
    const recorder = new ReliabilityRecorder();
    recorder.start("a");
    expect(() => recorder.start("b")).toThrow(/already active/);
  });

  it("caps the timeline at maxEvents and marks the session truncated, instead of growing forever", () => {
    // Regression: a session left running indefinitely accumulated events
    // without bound. FIFO eviction would silently delete the middle of an
    // incident timeline and corrupt replay/outage analysis, so the cap drops
    // new events once reached and flags the session instead.
    const recorder = new ReliabilityRecorder(undefined, 3);
    recorder.start("long-running");
    for (let i = 0; i < 5; i++) {
      recorder.logRequest(requestCtx("github", "/a", `r${i}`));
    }
    const session = recorder.stop();

    expect(session.events).toHaveLength(3);
    expect(session.events.map((e) => e.requestId)).toEqual(["r0", "r1", "r2"]);
    expect(session.truncated).toBe(true);
  });
});

describe("ReliabilityStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "meridian-replay-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips sessions and lists them", async () => {
    const store = new ReliabilityStore(dir);
    await store.save(outageSession());
    expect(await store.list()).toEqual(["outage-test"]);
    const loaded = await store.load("outage-test");
    expect(loaded.events).toHaveLength(6);
  });

  it("errors helpfully for missing sessions", async () => {
    const store = new ReliabilityStore(dir);
    await store.save(outageSession());
    await expect(store.load("nope")).rejects.toThrow(/No recording named "nope".*outage-test/s);
  });

  it("rejects path-traversal session names", async () => {
    const store = new ReliabilityStore(dir);
    await expect(store.load("../etc/passwd")).rejects.toThrow(/Invalid session name/);
  });
});

describe("summarizeSession", () => {
  it("derives retries, failovers, breaker transitions, and latency", () => {
    const summary = summarizeSession(outageSession());

    expect(summary.requests).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.totalRetries).toBe(2);
    expect(summary.failovers).toEqual([
      { from: "openai", to: "anthropic", endpoint: "/v1/chat", offsetMs: 950 },
    ]);
    expect(summary.breakerTransitions).toEqual([
      { provider: "openai", from: "CLOSED", to: "OPEN", offsetMs: 900 },
    ]);
    expect(summary.latency).toEqual({ avgMs: 335, maxMs: 550 });
    expect(summary.providers).toEqual({
      openai: { requests: 2, failed: 1 },
      anthropic: { requests: 1, failed: 0 },
    });
  });
});

describe("replaySession", () => {
  it("re-fires events in order without waiting at speed Infinity", async () => {
    const seen: string[] = [];
    const summary = await replaySession(outageSession(), {
      onEvent: (e) => seen.push(`${e.type}:${e.provider}`),
    });
    expect(seen).toEqual([
      "request:openai",
      "response:openai",
      "request:openai",
      "error:openai",
      "request:anthropic",
      "response:anthropic",
    ]);
    expect(summary.failovers).toHaveLength(1);
  });

  it("re-emits the timeline through observability adapters", async () => {
    const calls: string[] = [];
    await replaySession(outageSession(), {
      emitTo: [
        {
          logRequest: (ctx) => calls.push(`req:${ctx.provider}`),
          logResponse: (ctx) => calls.push(`res:${ctx.statusCode}`),
          logError: (ctx) => calls.push(`err:${ctx.error.category}:${ctx.error.message}`),
          logWarning: () => {},
          recordMetric: () => {},
        },
      ],
    });
    expect(calls).toEqual([
      "req:openai",
      "res:200",
      "req:openai",
      "err:provider:HTTP 503",
      "req:anthropic",
      "res:200",
    ]);
  });

  it("renders a readable timeline with summary", () => {
    const out = renderTimeline(outageSession());
    expect(out).toContain('Session "outage-test"');
    expect(out).toContain("✗ provider: HTTP 503");
    expect(out).toContain("[breaker OPEN]");
    expect(out).toContain("failovers: 1 (openai→anthropic @0.950s)");
    expect(out).toContain("breaker:   openai CLOSED→OPEN @0.900s");
    expect(out).toContain("2 retries");
  });
});

describe("Meridian record/replay integration", () => {
  const originalFetch = globalThis.fetch;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "meridian-replay-int-"));
    let failuresLeft = 1;
    (globalThis as any).fetch = async (url: string | Request | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/flaky") && failuresLeft-- > 0) {
        const body = { message: "upstream down" };
        return {
          ok: false,
          status: 503,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as Response;
      }
      const body = { ok: true };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
  });

  afterEach(async () => {
    (globalThis as any).fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it("records real pipeline traffic, persists it, and replays it", async () => {
    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      defaults: { retry: { maxRetries: 1, baseDelay: 1, maxDelay: 2 } },
      providers: { github: { auth: { token: "t" } } },
    });

    const name = meridian.startRecording("ci-incident");
    expect(name).toBe("ci-incident");
    expect(meridian.recordingStatus()).toEqual({ active: true, sessionName: "ci-incident" });
    await meridian.provider("github")!.get("/ok");
    await meridian.provider("github")!.get("/flaky"); // 503 once, then retried to 200
    const session = await meridian.stopRecording({ dir });
    expect(meridian.recordingStatus()).toEqual({ active: false, sessionName: null });

    expect(session.events.filter((e) => e.type === "request")).toHaveLength(2);
    const flaky = session.events.find((e) => e.type === "response" && e.endpoint === "/flaky");
    expect(flaky?.retries).toBe(1);

    // Replay from disk by name.
    const summary = await meridian.replaySession("ci-incident", { dir });
    expect(summary.requests).toBe(2);
    expect(summary.totalRetries).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("supports unsaved sessions", async () => {
    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      providers: { mock: { auth: { apiKey: "k" }, adapter: new MockAdapter("mock") } },
    });
    meridian.startRecording();
    await meridian.provider("mock")!.get("/ok");
    const session = await meridian.stopRecording({ save: false });
    expect(session.name).toMatch(/^session-/);
    const summary = await meridian.replaySession(session);
    expect(summary.succeeded).toBe(1);
  });
});
