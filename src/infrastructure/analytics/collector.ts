import type {
  ErrorContext,
  Metric,
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
} from "../../core/types.js";

export interface ProviderStats {
  requests: number;
  errors: number;
  errorRate: string;
  successRate: string;
  avgLatency: number;
  p95Latency: number;
}

export interface HealthEntry {
  status: "healthy" | "degraded" | "down";
  successRate: string;
  avgLatency: number;
}

export interface CostEntry {
  requests: number;
  costPerRequest: number;
  estimatedSpend: number;
}

export interface CostReport {
  providers: Record<string, CostEntry>;
  total: {
    requests: number;
    estimatedSpend: number;
  };
  since: string;
  currency: string;
}

interface Bucket {
  requests: number;
  errors: number;
  latencies: number[];
}

export class AnalyticsCollector implements ObservabilityAdapter {
  private buckets = new Map<string, Bucket>();
  private startedAt = new Date().toISOString();

  logRequest(_ctx: RequestContext): void {}

  logResponse(ctx: ResponseContext): void {
    this.record(ctx.provider, true, ctx.duration);
  }

  logError(ctx: ErrorContext): void {
    this.record(ctx.provider, false, ctx.duration);
  }

  logWarning(): void {}

  recordMetric(_metric: Metric): void {}

  private record(provider: string, success: boolean, latency: number): void {
    if (!this.buckets.has(provider)) {
      this.buckets.set(provider, { requests: 0, errors: 0, latencies: [] });
    }
    const b = this.buckets.get(provider)!;
    b.requests++;
    if (!success) b.errors++;
    b.latencies.push(latency);
    if (b.latencies.length > 1000) b.latencies.shift();
  }

  get(): Record<string, ProviderStats> {
    const out: Record<string, ProviderStats> = {};
    for (const [provider, b] of this.buckets) {
      out[provider] = this.computeStats(b);
    }
    return out;
  }

  getHealth(): Record<string, HealthEntry> {
    const out: Record<string, HealthEntry> = {};
    for (const [provider, b] of this.buckets) {
      const stats = this.computeStats(b);
      const successPct = Number.parseFloat(stats.successRate);
      out[provider] = {
        status: successPct >= 99 ? "healthy" : successPct >= 95 ? "degraded" : "down",
        successRate: stats.successRate,
        avgLatency: stats.avgLatency,
      };
    }
    return out;
  }

  private computeStats(b: Bucket): ProviderStats {
    const sorted = [...b.latencies].sort((a, c) => a - c);
    const avg = sorted.length > 0 ? sorted.reduce((a, c) => a + c, 0) / sorted.length : 0;
    const p95 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.95)] ?? 0) : 0;
    const errorRate = b.requests > 0 ? (b.errors / b.requests) * 100 : 0;
    return {
      requests: b.requests,
      errors: b.errors,
      errorRate: `${errorRate.toFixed(1)}%`,
      successRate: `${(100 - errorRate).toFixed(1)}%`,
      avgLatency: Math.round(avg),
      p95Latency: Math.round(p95),
    };
  }

  getCost(costs: Record<string, number>, currency = "USD"): CostReport {
    const providers: Record<string, CostEntry> = {};
    let totalRequests = 0;
    let totalSpend = 0;

    for (const [provider, b] of this.buckets) {
      const costPerRequest = costs[provider] ?? 0;
      const estimatedSpend = b.requests * costPerRequest;
      providers[provider] = { requests: b.requests, costPerRequest, estimatedSpend };
      totalRequests += b.requests;
      totalSpend += estimatedSpend;
    }

    return {
      providers,
      total: { requests: totalRequests, estimatedSpend: totalSpend },
      since: this.startedAt,
      currency,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.startedAt = new Date().toISOString();
  }
}
