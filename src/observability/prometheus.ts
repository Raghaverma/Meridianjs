

import type {
  ObservabilityAdapter,
  RequestContext,
  ResponseContext,
  ErrorContext,
  Metric,
} from "../core/types.js";

export interface PrometheusConfig {
  
  prefix?: string;
  
  includeHelp?: boolean;
  
  defaultLabels?: Record<string, string>;
}

interface MetricValue {
  labels: Record<string, string>;
  value: number;
}

interface MetricDefinition {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram" | "summary";
  values: Map<string, MetricValue>;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramMetric {
  name: string;
  help: string;
  type: "histogram";
  buckets: number[];
  data: Map<string, { buckets: HistogramBucket[]; sum: number; count: number }>;
}

export class PrometheusObservability implements ObservabilityAdapter {
  private config: Required<PrometheusConfig>;
  private counters: Map<string, MetricDefinition> = new Map();
  private histograms: Map<string, HistogramMetric> = new Map();

  
  private static readonly DEFAULT_DURATION_BUCKETS = [
    5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
  ];

  constructor(config: PrometheusConfig = {}) {
    this.config = {
      prefix: config.prefix ?? "meridian",
      includeHelp: config.includeHelp ?? true,
      defaultLabels: config.defaultLabels ?? {},
    };

    
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    
    this.counters.set("requests_total", {
      name: `${this.config.prefix}_requests_total`,
      help: "Total number of Meridian API requests",
      type: "counter",
      values: new Map(),
    });

    
    this.counters.set("errors_total", {
      name: `${this.config.prefix}_errors_total`,
      help: "Total number of Meridian API errors",
      type: "counter",
      values: new Map(),
    });

    
    this.histograms.set("request_duration_ms", {
      name: `${this.config.prefix}_request_duration_ms`,
      help: "Request duration in milliseconds",
      type: "histogram",
      buckets: PrometheusObservability.DEFAULT_DURATION_BUCKETS,
      data: new Map(),
    });
  }

  logRequest(context: RequestContext): void {
    
    this.incrementCounter("requests_total", {
      provider: context.provider,
      method: context.method,
      endpoint: this.normalizeEndpoint(context.endpoint),
    });
  }

  logResponse(context: ResponseContext): void {
    
    this.recordHistogram("request_duration_ms", context.duration, {
      provider: context.provider,
      method: context.method,
      status: String(context.statusCode),
    });
  }

  logError(context: ErrorContext): void {
    
    this.incrementCounter("errors_total", {
      provider: context.provider,
      category: context.error.category,
      retryable: String(context.error.retryable),
    });

    
    this.recordHistogram("request_duration_ms", context.duration, {
      provider: context.provider,
      method: context.method,
      status: "error",
      category: context.error.category,
    });
  }

  logWarning(_message: string, _metadata?: Record<string, unknown>): void {
    
    
  }

  recordMetric(metric: Metric): void {
    
    const metricKey = metric.name.replace(/\./g, "_");

    if (!this.counters.has(metricKey)) {
      this.counters.set(metricKey, {
        name: `${this.config.prefix}_${metricKey}`,
        help: `Custom metric: ${metric.name}`,
        type: "counter",
        values: new Map(),
      });
    }

    this.incrementCounter(metricKey, metric.tags, metric.value);
  }

  
  getMetrics(): string {
    const lines: string[] = [];

    
    for (const metric of this.counters.values()) {
      if (this.config.includeHelp) {
        lines.push(`# HELP ${metric.name} ${metric.help}`);
        lines.push(`# TYPE ${metric.name} ${metric.type}`);
      }

      for (const [_labelKey, data] of metric.values) {
        const labels = this.formatLabels(data.labels);
        lines.push(`${metric.name}${labels} ${data.value}`);
      }
    }

    
    for (const histogram of this.histograms.values()) {
      if (this.config.includeHelp) {
        lines.push(`# HELP ${histogram.name} ${histogram.help}`);
        lines.push(`# TYPE ${histogram.name} histogram`);
      }

      for (const [labelKey, data] of histogram.data) {
        const baseLabels = this.parseLabelKey(labelKey);

        
        for (const bucket of data.buckets) {
          const bucketLabels = { ...baseLabels, le: String(bucket.le) };
          lines.push(
            `${histogram.name}_bucket${this.formatLabels(bucketLabels)} ${bucket.count}`
          );
        }

        
        const infLabels = { ...baseLabels, le: "+Inf" };
        lines.push(
          `${histogram.name}_bucket${this.formatLabels(infLabels)} ${data.count}`
        );

        
        lines.push(
          `${histogram.name}_sum${this.formatLabels(baseLabels)} ${data.sum}`
        );
        lines.push(
          `${histogram.name}_count${this.formatLabels(baseLabels)} ${data.count}`
        );
      }
    }

    return lines.join("\n") + "\n";
  }

  
  reset(): void {
    for (const metric of this.counters.values()) {
      metric.values.clear();
    }
    for (const histogram of this.histograms.values()) {
      histogram.data.clear();
    }
  }

  private incrementCounter(
    metricKey: string,
    labels: Record<string, string>,
    value: number = 1
  ): void {
    const metric = this.counters.get(metricKey);
    if (!metric) return;

    const allLabels = { ...this.config.defaultLabels, ...labels };
    const labelKey = this.createLabelKey(allLabels);

    const existing = metric.values.get(labelKey);
    if (existing) {
      existing.value += value;
    } else {
      metric.values.set(labelKey, { labels: allLabels, value });
    }
  }

  private recordHistogram(
    metricKey: string,
    value: number,
    labels: Record<string, string>
  ): void {
    const histogram = this.histograms.get(metricKey);
    if (!histogram) return;

    const allLabels = { ...this.config.defaultLabels, ...labels };
    const labelKey = this.createLabelKey(allLabels);

    let data = histogram.data.get(labelKey);
    if (!data) {
      
      data = {
        buckets: histogram.buckets.map((le) => ({ le, count: 0 })),
        sum: 0,
        count: 0,
      };
      histogram.data.set(labelKey, data);
    }

    
    for (const bucket of data.buckets) {
      if (value <= bucket.le) {
        bucket.count++;
      }
    }

    
    data.sum += value;
    data.count++;
  }

  private createLabelKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }

  private parseLabelKey(labelKey: string): Record<string, string> {
    const labels: Record<string, string> = {};
    const pairs = labelKey.match(/(\w+)="([^"]+)"/g) ?? [];
    for (const pair of pairs) {
      const match = pair.match(/(\w+)="([^"]+)"/);
      if (match) {
        labels[match[1]!] = match[2]!;
      }
    }
    return labels;
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";

    const formatted = entries
      .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
      .join(",");

    return `{${formatted}}`;
  }

  private escapeLabel(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  private normalizeEndpoint(endpoint: string): string {
    // Normalize endpoint to reduce cardinality
    // Replace path parameters with placeholders
    return endpoint
      .replace(/\/\d+/g, "/:id")
      .replace(/\/[a-f0-9-]{36}/gi, "/:uuid");
  }
}
