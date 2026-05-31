import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../core/types.js";

export class NoOpObservability implements ObservabilityAdapter {
  logRequest(_context: RequestContext): void {}

  logResponse(_context: ResponseContext): void {}

  logError(_context: ErrorContext): void {}

  logWarning(_message: string, _metadata?: Record<string, unknown>): void {}

  recordMetric(_metric: Metric): void {}
}
