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
      this.log.push(rec);
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
      this.log.push(rec);
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
}
