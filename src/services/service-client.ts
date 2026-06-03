import type { StreamChunk } from "../core/streaming.js";
import type {
  BatchRequest,
  MeridianErrorCategory,
  NormalizedResponse,
  RequestOptions,
} from "../core/types.js";
import { MeridianError } from "../core/types.js";
import type { ServiceConfig } from "../core/types.js";
import type { ProviderClient } from "../index.js";

type RoutableMethod = "get" | "post" | "put" | "patch" | "delete";

export class ServiceClient {
  private providers: ProviderClient[];
  private providerNames: string[];
  private strategy: NonNullable<ServiceConfig["strategy"]>;
  private failoverOn: Set<MeridianErrorCategory>;
  private roundRobinIndex = 0;
  private latencyMs: number[];
  private costs: Record<string, number>;
  private getStats: (() => Record<string, { successRate: string }>) | undefined;

  constructor(
    providerNames: string[],
    providers: ProviderClient[],
    config: Pick<ServiceConfig, "strategy" | "failoverOn" | "costs">,
    getStats?: () => Record<string, { successRate: string }>,
  ) {
    if (providers.length === 0) {
      throw new Error("ServiceClient requires at least one provider.");
    }
    this.providerNames = providerNames;
    this.providers = providers;
    this.strategy = config.strategy ?? "failover";
    this.failoverOn = new Set(config.failoverOn ?? ["rate_limit", "network", "provider"]);
    this.latencyMs = new Array(providers.length).fill(0);
    this.costs = config.costs ?? {};
    this.getStats = getStats;
  }

  get<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("get", endpoint, options);
  }

  post<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("post", endpoint, options);
  }

  put<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("put", endpoint, options);
  }

  patch<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("patch", endpoint, options);
  }

  delete<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("delete", endpoint, options);
  }

  async *paginate<T = unknown>(
    endpoint: string,
    options?: RequestOptions,
  ): AsyncGenerator<NormalizedResponse<T>> {
    const idx = this.selectIndex();
    yield* this.providers[idx]!.paginate<T>(endpoint, options);
  }

  async *stream<T = unknown>(
    endpoint: string,
    options?: RequestOptions,
  ): AsyncGenerator<StreamChunk<T>> {
    const idx = this.selectIndex();
    yield* this.providers[idx]!.stream<T>(endpoint, options);
  }

  async batch<T = unknown>(
    requests: BatchRequest[],
    concurrencyLimit = 10,
  ): Promise<Array<NormalizedResponse<T> | MeridianError>> {
    const idx = this.selectIndex();
    return this.providers[idx]!.batch<T>(requests, concurrencyLimit);
  }

  private selectIndex(): number {
    if (this.strategy === "round-robin") {
      const idx = this.roundRobinIndex % this.providers.length;
      this.roundRobinIndex++;
      return idx;
    }
    if (this.strategy === "lowest-latency") return this.fastestIndex();
    if (this.strategy === "cheapest") return this.cheapestIndex();
    if (this.strategy === "highest-success-rate") return this.highestSuccessRateIndex();
    return 0;
  }

  private failoverOrder(): number[] {
    if (this.strategy === "lowest-latency") {
      return this.latencyMs
        .map((ms, idx) => ({ idx, ms }))
        .sort((a, b) => a.ms - b.ms)
        .map(({ idx }) => idx);
    }
    if (this.strategy === "cheapest") {
      return this.providerNames
        .map((name, idx) => ({ idx, cost: this.costs[name] ?? Number.POSITIVE_INFINITY }))
        .sort((a, b) => a.cost - b.cost)
        .map(({ idx }) => idx);
    }
    if (this.strategy === "highest-success-rate") {
      const stats = this.getStats?.() ?? {};
      return this.providerNames
        .map((name, idx) => ({
          idx,
          rate: Number.parseFloat(stats[name]?.successRate ?? "100"),
        }))
        .sort((a, b) => b.rate - a.rate)
        .map(({ idx }) => idx);
    }
    return this.providers.map((_, i) => i);
  }

  private fastestIndex(): number {
    let best = 0;
    for (let i = 1; i < this.latencyMs.length; i++) {
      if (this.latencyMs[i]! < this.latencyMs[best]!) best = i;
    }
    return best;
  }

  private cheapestIndex(): number {
    let best = 0;
    let bestCost = this.costs[this.providerNames[0]!] ?? Number.POSITIVE_INFINITY;
    for (let i = 1; i < this.providerNames.length; i++) {
      const cost = this.costs[this.providerNames[i]!] ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    return best;
  }

  private highestSuccessRateIndex(): number {
    const stats = this.getStats?.() ?? {};
    let best = 0;
    let bestRate = Number.parseFloat(stats[this.providerNames[0]!]?.successRate ?? "100");
    for (let i = 1; i < this.providerNames.length; i++) {
      const rate = Number.parseFloat(stats[this.providerNames[i]!]?.successRate ?? "100");
      if (rate > bestRate) {
        bestRate = rate;
        best = i;
      }
    }
    return best;
  }

  private async route<T>(
    method: RoutableMethod,
    endpoint: string,
    options?: RequestOptions,
  ): Promise<NormalizedResponse<T>> {
    if (this.strategy === "round-robin") {
      const idx = this.roundRobinIndex % this.providers.length;
      this.roundRobinIndex++;
      const result = await this.providers[idx]![method]<T>(endpoint, options);
      this.updateLatency(idx, result.meta.trace?.latency);
      return result;
    }

    const order = this.failoverOrder();
    let lastError: MeridianError | null = null;

    for (const idx of order) {
      try {
        const result = await this.providers[idx]![method]<T>(endpoint, options);
        this.updateLatency(idx, result.meta.trace?.latency);
        return result;
      } catch (err) {
        if (err instanceof MeridianError && this.failoverOn.has(err.category)) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw (
      lastError ??
      new MeridianError(
        `All providers failed: ${this.providerNames.join(", ")}`,
        "provider",
        this.providerNames[0] ?? "service",
        false,
      )
    );
  }

  private updateLatency(idx: number, latency: number | undefined): void {
    if (latency === undefined) return;
    const current = this.latencyMs[idx]!;
    this.latencyMs[idx] = current === 0 ? latency : 0.3 * latency + 0.7 * current;
  }
}
