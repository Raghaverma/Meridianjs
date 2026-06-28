import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../../core/types.js";

export interface ConsoleObservabilityConfig {
  pretty?: boolean;
}

export class ConsoleObservability implements ObservabilityAdapter {
  private config: ConsoleObservabilityConfig;

  constructor(config: ConsoleObservabilityConfig = {}) {
    this.config = config;
  }

  logRequest(context: RequestContext): void {
    const log = {
      level: "info",
      type: "request",
      provider: context.provider,
      endpoint: context.endpoint,
      method: context.method,
      requestId: context.requestId,
      timestamp: context.timestamp.toISOString(),
    };

    this.output(log);
  }

  logResponse(context: ResponseContext): void {
    const log = {
      level: "info",
      type: "response",
      provider: context.provider,
      endpoint: context.endpoint,
      method: context.method,
      requestId: context.requestId,
      statusCode: context.statusCode,
      duration: context.duration,
      timestamp: context.timestamp.toISOString(),
    };

    this.output(log);
  }

  logError(context: ErrorContext): void {
    const log = {
      level: "error",
      type: "error",
      provider: context.provider,
      endpoint: context.endpoint,
      method: context.method,
      requestId: context.requestId,
      error: {
        category: context.error.category,
        message: context.error.message,
        retryable: context.error.retryable,
        retryAfter: context.error.retryAfter?.toISOString(),
      },
      duration: context.duration,
      timestamp: context.timestamp.toISOString(),
    };

    this.output(log);
  }

  logWarning(message: string, metadata?: Record<string, unknown>): void {
    const log = {
      level: "warn",
      type: "warning",
      message,
      metadata,
      timestamp: new Date().toISOString(),
    };

    this.output(log);
  }

  recordMetric(metric: Metric): void {
    const log = {
      level: "info",
      type: "metric",
      name: metric.name,
      value: metric.value,
      tags: metric.tags,
      timestamp: metric.timestamp.toISOString(),
    };

    this.output(log);
  }

  private output(data: unknown): void {
    if (this.config.pretty) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify(data));
    }
  }
}
