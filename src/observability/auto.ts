import {
  type OpenTelemetryConfig,
  OpenTelemetryObservability,
  type OTelMeter,
  type OTelTracer,
} from "./otel.js";

export interface OpenTelemetryAutoOptions {
  /** Instrumentation scope name for the tracer/meter. Default "meridianjs". */
  name?: string;
  /** Prefix for emitted metric names. Default "meridian". */
  metricPrefix?: string;
}

/**
 * The structural subset of `@opentelemetry/api` auto-instrumentation needs.
 * Kept structural so tests (and exotic setups) can inject a compatible object.
 */
export interface OTelApiLike {
  trace: { getTracer(name: string): unknown };
  metrics: { getMeter(name: string): unknown };
}

/**
 * Binds Meridian's OpenTelemetry observability adapter to the globally
 * registered OTel SDK via `@opentelemetry/api` (an optional peer dependency,
 * loaded lazily so the SDK core stays dependency-free).
 *
 * Spans, metrics, and errors flow to whatever exporter the host application
 * configured — Datadog, Grafana, Honeycomb, New Relic, or any OTLP endpoint.
 * See docs/OPENTELEMETRY.md for exporter recipes.
 */
export async function createOpenTelemetryObservability(
  options: OpenTelemetryAutoOptions = {},
  api?: OTelApiLike,
): Promise<OpenTelemetryObservability> {
  let otel = api;
  if (!otel) {
    try {
      otel = (await import("@opentelemetry/api")) as unknown as OTelApiLike;
    } catch {
      throw new Error(
        'telemetry: { provider: "opentelemetry" } requires the optional peer dependency ' +
          "'@opentelemetry/api'. Install it with: npm install @opentelemetry/api — and register " +
          "an OTel SDK with an exporter (see docs/OPENTELEMETRY.md).",
      );
    }
  }

  const name = options.name ?? "meridianjs";
  const config: OpenTelemetryConfig = {
    tracer: otel.trace.getTracer(name) as OTelTracer,
    meter: otel.metrics.getMeter(name) as OTelMeter,
  };
  if (options.metricPrefix !== undefined) {
    config.metricPrefix = options.metricPrefix;
  }
  return new OpenTelemetryObservability(config);
}
