import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Meridian } from "../../index.js";
import { MockAdapter } from "../../testing/mock-adapter.js";
import { createOpenTelemetryObservability, type OTelApiLike } from "./auto.js";

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
}

interface RecordedMetric {
  instrument: string;
  value: number;
  attributes?: Record<string, string> | undefined;
}

function fakeApi() {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  const instruments: string[] = [];

  const api: OTelApiLike = {
    trace: {
      getTracer: (name: string) => {
        instruments.push(`tracer:${name}`);
        return {
          startSpan(spanName: string, options?: { attributes?: Record<string, unknown> }) {
            const span: RecordedSpan = {
              name: spanName,
              attributes: { ...options?.attributes },
              exceptions: [],
              ended: false,
            };
            spans.push(span);
            return {
              setAttribute(key: string, value: unknown) {
                span.attributes[key] = value;
                return this;
              },
              setStatus(status: { code: number; message?: string }) {
                span.status = status;
                return this;
              },
              recordException(err: Error) {
                span.exceptions.push(err);
              },
              end() {
                span.ended = true;
              },
            };
          },
        };
      },
    },
    metrics: {
      getMeter: (name: string) => {
        instruments.push(`meter:${name}`);
        const instrument = (kind: string) => (instrumentName: string) => ({
          add(value: number, attributes?: Record<string, string>) {
            metrics.push({ instrument: `${kind}:${instrumentName}`, value, attributes });
          },
          record(value: number, attributes?: Record<string, string>) {
            metrics.push({ instrument: `${kind}:${instrumentName}`, value, attributes });
          },
        });
        return {
          createCounter: instrument("counter"),
          createHistogram: instrument("histogram"),
        };
      },
    },
  };

  return { api, spans, metrics, instruments };
}

describe("createOpenTelemetryObservability", () => {
  it("binds tracer and meter under the default scope name", async () => {
    const { api, instruments } = fakeApi();
    await createOpenTelemetryObservability({}, api);
    expect(instruments).toEqual(["tracer:meridianjs", "meter:meridianjs"]);
  });

  it("honors a custom scope name and metric prefix", async () => {
    const { api, instruments, metrics } = fakeApi();
    const obs = await createOpenTelemetryObservability(
      { name: "my-app", metricPrefix: "acme" },
      api,
    );
    obs.logResponse({
      provider: "github",
      endpoint: "/x",
      method: "GET",
      requestId: "r1",
      statusCode: 200,
      duration: 5,
      timestamp: new Date(),
    });
    expect(instruments).toEqual(["tracer:my-app", "meter:my-app"]);
    expect(metrics.some((m) => m.instrument === "histogram:acme.duration")).toBe(true);
  });

  it("loads the real @opentelemetry/api package when none is injected", async () => {
    // @opentelemetry/api ships a no-op global implementation, so binding
    // without a registered SDK must still produce a working adapter.
    const obs = await createOpenTelemetryObservability();
    expect(() =>
      obs.logRequest({
        provider: "github",
        endpoint: "/x",
        method: "GET",
        requestId: "r1",
        timestamp: new Date(),
        options: {},
      }),
    ).not.toThrow();
  });
});

describe("Meridian telemetry config", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as any).fetch = async (url: string | Request | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/boom")) {
        const body = { message: "kaput" };
        return {
          ok: false,
          status: 500,
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

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("emits a span and metrics for every request through the pipeline", async () => {
    const { api, spans, metrics } = fakeApi();
    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      telemetry: { provider: "opentelemetry", api },
      providers: { mock: { auth: { apiKey: "k" }, adapter: new MockAdapter("mock") } },
    });

    await meridian.provider("mock")!.get("/ok");

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("mock.GET");
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.attributes["meridian.provider"]).toBe("mock");
    expect(spans[0]!.attributes["http.status_code"]).toBe(200);

    const counters = metrics.filter((m) => m.instrument === "counter:meridian.requests");
    expect(counters).toHaveLength(1);
    const histograms = metrics.filter((m) => m.instrument === "histogram:meridian.duration");
    expect(histograms).toHaveLength(1);
  });

  it("records errors on the span when the provider fails", async () => {
    const { api, spans } = fakeApi();
    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      telemetry: { provider: "opentelemetry", api },
      defaults: { retry: { maxRetries: 0 } },
      providers: { mock: { auth: { apiKey: "k" }, adapter: new MockAdapter("mock") } },
    });

    await expect(meridian.provider("mock")!.get("/boom")).rejects.toThrow();

    expect(spans).toHaveLength(1);
    expect(spans[0]!.status?.code).toBe(2); // ERROR
    expect(spans[0]!.exceptions).toHaveLength(1);
    expect(spans[0]!.attributes["meridian.error.category"]).toBe("provider");
  });

  it("instrumentOpenTelemetry() is idempotent on a running client", async () => {
    const { api, spans } = fakeApi();
    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      providers: { mock: { auth: { apiKey: "k" }, adapter: new MockAdapter("mock") } },
    });

    await meridian.instrumentOpenTelemetry({}, api);
    await meridian.instrumentOpenTelemetry({}, api); // second call: no double-instrumentation

    await meridian.provider("mock")!.get("/ok");
    expect(spans).toHaveLength(1);
  });
});
