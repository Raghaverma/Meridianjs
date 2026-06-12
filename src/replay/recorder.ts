import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../core/types.js";

export type ReliabilityEventType = "request" | "response" | "error";

/**
 * One entry in a reliability session timeline. Captures pipeline *behavior*
 * (outcomes, retries, breaker state, latency) — not request/response bodies,
 * so sessions are safe to commit and share.
 */
export interface ReliabilityEvent {
  type: ReliabilityEventType;
  /** Wall-clock time of the event (ISO 8601). */
  at: string;
  /** Milliseconds since the session started. */
  offsetMs: number;
  provider: string;
  endpoint: string;
  method: string;
  requestId: string;
  statusCode?: number;
  /** Total duration of the pipeline execution, ms. */
  duration?: number;
  /** Retries the pipeline performed before this outcome. */
  retries?: number;
  /** Circuit breaker state observed at the time of the event. */
  circuitBreaker?: string;
  rateLimitRemaining?: number;
  errorCategory?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export interface ReliabilitySession {
  version: 1;
  name: string;
  startedAt: string;
  endedAt?: string;
  events: ReliabilityEvent[];
}

/**
 * Records the reliability timeline of every request flowing through the
 * pipeline while a session is active. Always present in the observability
 * chain (like DebugRecorder), inert until `start()`.
 */
export class ReliabilityRecorder implements ObservabilityAdapter {
  private session: ReliabilitySession | null = null;
  private startedAtMs = 0;

  /**
   * @param breakerState resolves the current circuit-breaker state for a
   * provider, so error events (which carry no trace) still record it.
   */
  constructor(private breakerState?: (provider: string) => string | undefined) {}

  get recording(): boolean {
    return this.session !== null;
  }

  get sessionName(): string | null {
    return this.session?.name ?? null;
  }

  start(name: string): void {
    if (this.session) {
      throw new Error(
        `A recording session ("${this.session.name}") is already active. Stop it before starting another.`,
      );
    }
    this.startedAtMs = Date.now();
    this.session = {
      version: 1,
      name,
      startedAt: new Date(this.startedAtMs).toISOString(),
      events: [],
    };
  }

  stop(): ReliabilitySession {
    if (!this.session) {
      throw new Error("No recording session is active.");
    }
    const session = this.session;
    session.endedAt = new Date().toISOString();
    this.session = null;
    return session;
  }

  private push(event: ReliabilityEvent): void {
    this.session?.events.push(event);
  }

  private base(
    type: ReliabilityEventType,
    ctx: { provider: string; endpoint: string; method: string; requestId: string },
  ): ReliabilityEvent {
    const now = Date.now();
    return {
      type,
      at: new Date(now).toISOString(),
      offsetMs: now - this.startedAtMs,
      provider: ctx.provider,
      endpoint: ctx.endpoint,
      method: ctx.method,
      requestId: ctx.requestId,
    };
  }

  logRequest(ctx: RequestContext): void {
    if (!this.session) return;
    this.push(this.base("request", ctx));
  }

  logResponse(ctx: ResponseContext): void {
    if (!this.session) return;
    const event = this.base("response", ctx);
    event.statusCode = ctx.statusCode;
    event.duration = ctx.duration;
    if (ctx.trace) {
      event.retries = ctx.trace.retries;
      event.circuitBreaker = String(ctx.trace.circuitBreaker);
      event.rateLimitRemaining = ctx.trace.rateLimitRemaining;
    }
    this.push(event);
  }

  logError(ctx: ErrorContext): void {
    if (!this.session) return;
    const event = this.base("error", ctx);
    event.duration = ctx.duration;
    event.errorCategory = ctx.error.category;
    event.errorMessage = ctx.error.message;
    event.retryable = ctx.error.retryable;
    const breaker = this.breakerState?.(ctx.provider);
    if (breaker !== undefined) event.circuitBreaker = breaker;
    this.push(event);
  }

  logWarning(): void {}

  recordMetric(_metric: Metric): void {}
}
