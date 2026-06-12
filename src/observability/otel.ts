import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../core/types.js";

export interface OTelTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): OTelSpan;
}

export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(exception: Error): void;
  end(): void;
}

export interface OTelMeter {
  createCounter(name: string, options?: { description?: string }): OTelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OTelHistogram;
}

export interface OTelCounter {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface OTelHistogram {
  record(value: number, attributes?: Record<string, string>): void;
}

export interface OpenTelemetryConfig {
  tracer: OTelTracer;
  meter: OTelMeter;

  metricPrefix?: string;
}

const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export class OpenTelemetryObservability implements ObservabilityAdapter {
  private tracer: OTelTracer;
  private meter: OTelMeter;
  private metricPrefix: string;
  private requestCounter: OTelCounter;
  private errorCounter: OTelCounter;
  private durationHistogram: OTelHistogram;
  private activeSpans: Map<string, OTelSpan> = new Map();
  private namedCounters: Map<string, OTelCounter> = new Map();

  constructor(config: OpenTelemetryConfig) {
    this.tracer = config.tracer;
    this.meter = config.meter;
    this.metricPrefix = config.metricPrefix ?? "meridian";

    this.requestCounter = this.meter.createCounter(`${this.metricPrefix}.requests`, {
      description: "Total number of Meridian API requests",
    });

    this.errorCounter = this.meter.createCounter(`${this.metricPrefix}.errors`, {
      description: "Total number of Meridian API errors",
    });

    this.durationHistogram = this.meter.createHistogram(`${this.metricPrefix}.duration`, {
      description: "Request duration in milliseconds",
      unit: "ms",
    });
  }

  logRequest(context: RequestContext): void {
    const span = this.tracer.startSpan(`${context.provider}.${context.method}`, {
      attributes: {
        "meridian.provider": context.provider,
        "http.method": context.method,
        "http.url": context.endpoint,
        "meridian.request_id": context.requestId,
      },
    });

    this.activeSpans.set(context.requestId, span);

    this.requestCounter.add(1, {
      provider: context.provider,
      method: context.method,
    });
  }

  logResponse(context: ResponseContext): void {
    const span = this.activeSpans.get(context.requestId);
    if (span) {
      span.setAttribute("http.status_code", context.statusCode);
      span.setAttribute("meridian.duration_ms", context.duration);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      this.activeSpans.delete(context.requestId);
    }

    this.durationHistogram.record(context.duration, {
      provider: context.provider,
      method: context.method,
      status: String(context.statusCode),
    });
  }

  logError(context: ErrorContext): void {
    const span = this.activeSpans.get(context.requestId);
    if (span) {
      span.setAttribute("meridian.error.category", context.error.category);
      span.setAttribute("meridian.error.retryable", context.error.retryable);
      span.setAttribute("meridian.duration_ms", context.duration);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: context.error.message,
      });

      const error = new Error(context.error.message);
      error.name = `MeridianError.${context.error.category}`;
      span.recordException(error);

      span.end();
      this.activeSpans.delete(context.requestId);
    }

    this.errorCounter.add(1, {
      provider: context.provider,
      category: context.error.category,
    });

    this.durationHistogram.record(context.duration, {
      provider: context.provider,
      method: context.method,
      status: "error",
      category: context.error.category,
    });
  }

  logWarning(message: string, metadata?: Record<string, unknown>): void {
    console.warn(`[Meridian OTel] ${message}`, metadata);
  }

  recordMetric(metric: Metric): void {
    // Each named metric gets its own counter; funneling them all into the
    // requests counter would corrupt the request count.
    let counter = this.namedCounters.get(metric.name);
    if (!counter) {
      const name = `${this.metricPrefix}.${metric.name.replace(/[^a-zA-Z0-9_.]/g, "_")}`;
      counter = this.meter.createCounter(name);
      this.namedCounters.set(metric.name, counter);
    }
    counter.add(metric.value, metric.tags);
  }
}
