import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  RequestOptions,
  RequestTrace,
  ResponseContext,
} from "../../core/types.js";

export interface RequestRecording {
  requestId: string;
  provider: string;
  endpoint: string;
  method: string;
  statusCode?: number;
  duration?: number;
  trace?: RequestTrace;
  error?: string;
  timestamp: Date;
  /** Original request options, present when debug was enabled before the request. */
  options?: RequestOptions;
}

export class DebugRecorder implements ObservabilityAdapter {
  private _enabled = false;
  private log: RequestRecording[] = [];
  private pending = new Map<string, RequestRecording>();
  private rawData = new Map<string, RequestOptions>();
  private readonly maxEntries: number;

  /**
   * `maxEntries` bounds the recording log with FIFO eviction (oldest first).
   * Without a cap, leaving `debug.enable()` on for a long-running process —
   * the documented use case is "enable, reproduce, inspect locally," but
   * nothing stops someone from leaving it on in production — grows the log
   * forever. Mirrors AnalyticsCollector's 1000-entry latency cap.
   */
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  enable(): void {
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
  }

  recordRaw(requestId: string, options: RequestOptions): void {
    if (!this._enabled) return;
    this.rawData.set(requestId, options);
  }

  logRequest(ctx: RequestContext): void {
    if (!this._enabled) return;
    this.pending.set(ctx.requestId, {
      requestId: ctx.requestId,
      provider: ctx.provider,
      endpoint: ctx.endpoint,
      method: ctx.method,
      timestamp: ctx.timestamp,
    });
  }

  logResponse(ctx: ResponseContext): void {
    if (!this._enabled) return;
    const rec = this.pending.get(ctx.requestId);
    if (rec) {
      rec.statusCode = ctx.statusCode;
      rec.duration = ctx.duration;
      if (ctx.trace !== undefined) rec.trace = ctx.trace;
      const rawOpts = this.rawData.get(ctx.requestId);
      if (rawOpts !== undefined) {
        rec.options = rawOpts;
        this.rawData.delete(ctx.requestId);
      }
      this.pushRecording(rec);
      this.pending.delete(ctx.requestId);
    }
  }

  logError(ctx: ErrorContext): void {
    if (!this._enabled) return;
    const rec = this.pending.get(ctx.requestId);
    if (rec) {
      rec.duration = ctx.duration;
      rec.error = ctx.error.message;
      const rawOpts = this.rawData.get(ctx.requestId);
      if (rawOpts !== undefined) {
        rec.options = rawOpts;
        this.rawData.delete(ctx.requestId);
      }
      this.pushRecording(rec);
      this.pending.delete(ctx.requestId);
    }
  }

  logWarning(): void {}

  recordMetric(_metric: Metric): void {}

  recordings(): RequestRecording[] {
    return [...this.log];
  }

  clear(): void {
    this.log = [];
    this.pending.clear();
    this.rawData.clear();
  }

  private pushRecording(rec: RequestRecording): void {
    this.log.push(rec);
    if (this.log.length > this.maxEntries) {
      this.log.shift();
    }
  }
}
