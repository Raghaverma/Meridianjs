import type {
  ErrorContext,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../core/types.js";
import { MeridianError, type MeridianErrorCategory } from "../core/types.js";
import type { ReliabilityEvent, ReliabilitySession } from "./recorder.js";

export interface BreakerTransition {
  provider: string;
  from: string;
  to: string;
  offsetMs: number;
}

export interface FailoverHop {
  from: string;
  to: string;
  endpoint: string;
  offsetMs: number;
}

export interface ReplaySummary {
  name: string;
  events: number;
  /** Total span of the session in milliseconds. */
  windowMs: number;
  requests: number;
  succeeded: number;
  failed: number;
  totalRetries: number;
  breakerTransitions: BreakerTransition[];
  failovers: FailoverHop[];
  latency: { avgMs: number; maxMs: number };
  providers: Record<string, { requests: number; failed: number }>;
}

export interface ReplayOptions {
  /**
   * Time-scale factor. 1 = real time, 10 = 10× faster. Default Infinity
   * (no waiting), which keeps programmatic replays deterministic.
   */
  speed?: number;
  /** Called for every event as it replays. */
  onEvent?: (event: ReliabilityEvent) => void;
  /**
   * Re-emit the timeline through observability adapters — the outage shows up
   * on whatever dashboards those adapters feed (console, OTel, Prometheus).
   */
  emitTo?: ObservabilityAdapter[];
}

/** Derives the reliability story — retries, failovers, breaker flips — from a session. */
export function summarizeSession(session: ReliabilitySession): ReplaySummary {
  const events = session.events;
  const responses = events.filter((e) => e.type === "response");
  const errors = events.filter((e) => e.type === "error");

  const breakerTransitions: BreakerTransition[] = [];
  const lastBreaker = new Map<string, string>();
  for (const e of events) {
    if (!e.circuitBreaker) continue;
    const prev = lastBreaker.get(e.provider);
    if (prev !== undefined && prev !== e.circuitBreaker) {
      breakerTransitions.push({
        provider: e.provider,
        from: prev,
        to: e.circuitBreaker,
        offsetMs: e.offsetMs,
      });
    }
    lastBreaker.set(e.provider, e.circuitBreaker);
  }

  // Failover heuristic: a failed call on one provider immediately followed by
  // an attempt of the same endpoint on a different provider.
  const failovers: FailoverHop[] = [];
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]!;
    if (a.type !== "error") continue;
    for (let j = i + 1; j < events.length; j++) {
      const b = events[j]!;
      if (b.type !== "request") continue;
      if (b.endpoint === a.endpoint && b.provider !== a.provider) {
        failovers.push({
          from: a.provider,
          to: b.provider,
          endpoint: a.endpoint,
          offsetMs: b.offsetMs,
        });
      }
      break; // only inspect the next request after the failure
    }
  }

  const durations = responses
    .map((e) => e.duration)
    .filter((d): d is number => typeof d === "number");
  const avgMs =
    durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const maxMs = durations.length > 0 ? Math.max(...durations) : 0;

  const providers: ReplaySummary["providers"] = {};
  for (const e of [...responses, ...errors]) {
    const p = (providers[e.provider] ??= { requests: 0, failed: 0 });
    p.requests++;
    if (e.type === "error") p.failed++;
  }

  const offsets = events.map((e) => e.offsetMs);
  return {
    name: session.name,
    events: events.length,
    windowMs: offsets.length > 0 ? Math.max(...offsets) - Math.min(...offsets) : 0,
    requests: responses.length + errors.length,
    succeeded: responses.length,
    failed: errors.length,
    totalRetries: responses.reduce((sum, e) => sum + (e.retries ?? 0), 0),
    breakerTransitions,
    failovers,
    latency: { avgMs, maxMs },
    providers,
  };
}

function toRequestContext(e: ReliabilityEvent): RequestContext {
  return {
    provider: e.provider,
    endpoint: e.endpoint,
    method: e.method,
    requestId: e.requestId,
    timestamp: new Date(e.at),
    options: { method: e.method as NonNullable<RequestContext["options"]["method"]> },
  };
}

function toResponseContext(e: ReliabilityEvent): ResponseContext {
  return {
    provider: e.provider,
    endpoint: e.endpoint,
    method: e.method,
    requestId: e.requestId,
    statusCode: e.statusCode ?? 0,
    duration: e.duration ?? 0,
    timestamp: new Date(e.at),
  };
}

function toErrorContext(e: ReliabilityEvent): ErrorContext {
  return {
    provider: e.provider,
    endpoint: e.endpoint,
    method: e.method,
    requestId: e.requestId,
    error: new MeridianError(
      e.errorMessage ?? "replayed error",
      (e.errorCategory as MeridianErrorCategory | undefined) ?? "provider",
      e.provider,
      e.retryable ?? false,
      e.requestId,
    ),
    duration: e.duration ?? 0,
    timestamp: new Date(e.at),
  };
}

/**
 * Replays a recorded session: events fire in order (time-scaled by `speed`)
 * into `onEvent` and any `emitTo` observability adapters, then the derived
 * summary is returned. Nothing is sent to real providers.
 */
export async function replaySession(
  session: ReliabilitySession,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const speed = options.speed ?? Number.POSITIVE_INFINITY;
  let previousOffset: number | null = null;

  for (const event of session.events) {
    if (previousOffset !== null && Number.isFinite(speed) && speed > 0) {
      const waitMs = (event.offsetMs - previousOffset) / speed;
      if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));
    }
    previousOffset = event.offsetMs;

    options.onEvent?.(event);
    for (const obs of options.emitTo ?? []) {
      try {
        if (event.type === "request") obs.logRequest(toRequestContext(event));
        else if (event.type === "response") obs.logResponse(toResponseContext(event));
        else obs.logError(toErrorContext(event));
      } catch {
        // Observability adapters must never break a replay.
      }
    }
  }

  return summarizeSession(session);
}

function formatOffset(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

/** Renders a human-readable timeline + summary, used by `meridian replay <name>`. */
export function renderTimeline(session: ReliabilitySession): string {
  const lines: string[] = [];
  const summary = summarizeSession(session);

  lines.push(
    `Session "${session.name}" — ${summary.events} events over ${formatOffset(summary.windowMs)} (recorded ${session.startedAt})`,
    "",
  );

  for (const e of session.events) {
    const stamp = formatOffset(e.offsetMs).padStart(9);
    const provider = e.provider.padEnd(12);
    const call = `${e.method} ${e.endpoint}`;
    if (e.type === "request") {
      lines.push(`${stamp}  ${provider} ${call} …`);
    } else if (e.type === "response") {
      const retries = e.retries ? `, ${e.retries} ${e.retries === 1 ? "retry" : "retries"}` : "";
      const breaker =
        e.circuitBreaker && e.circuitBreaker !== "CLOSED" ? `  [breaker ${e.circuitBreaker}]` : "";
      lines.push(
        `${stamp}  ${provider} ${call} → ${e.statusCode} (${e.duration ?? "?"}ms${retries})${breaker}`,
      );
    } else {
      const retryable = e.retryable ? "retryable" : "fatal";
      const breaker =
        e.circuitBreaker && e.circuitBreaker !== "CLOSED" ? `  [breaker ${e.circuitBreaker}]` : "";
      lines.push(
        `${stamp}  ${provider} ${call} ✗ ${e.errorCategory}: ${e.errorMessage} (${retryable})${breaker}`,
      );
    }
  }

  lines.push(
    "",
    "Summary",
    `  requests:  ${summary.requests} (${summary.succeeded} ok / ${summary.failed} failed)`,
    `  retries:   ${summary.totalRetries}`,
  );
  if (summary.failovers.length > 0) {
    const hops = summary.failovers.map((f) => `${f.from}→${f.to} @${formatOffset(f.offsetMs)}`);
    lines.push(`  failovers: ${summary.failovers.length} (${hops.join(", ")})`);
  } else {
    lines.push("  failovers: none");
  }
  if (summary.breakerTransitions.length > 0) {
    const flips = summary.breakerTransitions.map(
      (t) => `${t.provider} ${t.from}→${t.to} @${formatOffset(t.offsetMs)}`,
    );
    lines.push(`  breaker:   ${flips.join(", ")}`);
  } else {
    lines.push("  breaker:   no transitions");
  }
  lines.push(`  latency:   avg ${summary.latency.avgMs}ms · max ${summary.latency.maxMs}ms`);

  return lines.join("\n");
}
