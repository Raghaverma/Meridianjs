import type { NormalizedResponse, RequestOptions } from "../core/types.js";
import { MeridianError } from "../core/types.js";
import type { ProviderClient } from "../index.js";

export interface PaymentRouterOptions {
  /**
   * Routing strategy.
   * - "failover": try providers in order, move to next on retryable error
   * - "round-robin": distribute requests evenly across providers
   */
  strategy?: "failover" | "round-robin";
  /** Which error categories trigger failover. Defaults to rate_limit, network, provider. */
  failoverOn?: Array<MeridianError["category"]>;
}

export class PaymentRouter {
  private providers: ProviderClient[];
  private strategy: "failover" | "round-robin";
  private failoverOn: Set<string>;
  private roundRobinIndex = 0;

  constructor(providers: ProviderClient[], options: PaymentRouterOptions = {}) {
    if (providers.length === 0) throw new Error("PaymentRouter requires at least one provider.");
    this.providers = providers;
    this.strategy = options.strategy ?? "failover";
    this.failoverOn = new Set(options.failoverOn ?? ["rate_limit", "network", "provider"]);
  }

  async get<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("get", endpoint, options);
  }

  async post<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("post", endpoint, options);
  }

  async put<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("put", endpoint, options);
  }

  async patch<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("patch", endpoint, options);
  }

  async delete<T = unknown>(endpoint: string, options?: RequestOptions): Promise<NormalizedResponse<T>> {
    return this.route("delete", endpoint, options);
  }

  private async route<T>(
    method: "get" | "post" | "put" | "patch" | "delete",
    endpoint: string,
    options?: RequestOptions
  ): Promise<NormalizedResponse<T>> {
    if (this.strategy === "round-robin") {
      const provider = this.providers[this.roundRobinIndex % this.providers.length]!;
      this.roundRobinIndex++;
      return provider[method]<T>(endpoint, options);
    }

    // Failover strategy
    let lastError: MeridianError | null = null;
    for (const provider of this.providers) {
      try {
        return await provider[method]<T>(endpoint, options);
      } catch (err) {
        if (err instanceof MeridianError && this.failoverOn.has(err.category)) {
          lastError = err;
          continue; // try next provider
        }
        throw err; // non-retryable — propagate immediately
      }
    }

    throw lastError ?? new MeridianError(
      "All payment providers failed.",
      "provider",
      "payment-router",
      false
    );
  }
}
