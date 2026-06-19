import type { RateLimitConfig, RateLimitInfo } from "../core/types.js";

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private config: Required<RateLimitConfig>;
  /**
   * The user-configured baseline rate. `config.tokensPerSecond` is the *current*
   * adaptive rate and may be lowered under pressure; this is the ceiling it
   * recovers back to once the provider's quota is healthy again. Without a
   * separate baseline the adaptive logic could only ratchet down, permanently
   * throttling the client after a single brush with the limit.
   */
  private readonly baseTokensPerSecond: number;
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private processingQueue = false;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      tokensPerSecond: config.tokensPerSecond ?? 10,
      maxTokens: config.maxTokens ?? 100,
      adaptiveBackoff: config.adaptiveBackoff ?? true,
      queueSize: config.queueSize ?? 50,
    };
    this.baseTokensPerSecond = this.config.tokensPerSecond;
    this.tokens = this.config.maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    if (this.config.queueSize && this.queue.length >= this.config.queueSize) {
      throw new Error("Rate limit queue is full");
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.processQueue();
    });
  }

  private refill(): void {
    const now = Date.now();

    const elapsed = Math.max(0, (now - this.lastRefill) / 1000);
    const tokensToAdd = elapsed * this.config.tokensPerSecond;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.config.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.queue.length === 0) {
      return;
    }

    this.processingQueue = true;

    while (this.queue.length > 0) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens--;
        const item = this.queue.shift();
        if (item) {
          item.resolve();
        }
      } else {
        const waitTime = (1 / this.config.tokensPerSecond) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.processingQueue = false;
  }

  updateFromHeaders(_headers: Headers, rateLimitInfo: RateLimitInfo): void {
    if (!this.config.adaptiveBackoff) {
      return;
    }

    const remaining = rateLimitInfo.remaining;
    const limit = rateLimitInfo.limit;
    const reset = rateLimitInfo.reset.getTime();

    // A non-positive or non-finite limit tells us nothing — leave the rate alone
    // rather than dividing by it.
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const utilization = (limit - remaining) / limit;

    if (utilization > 0.8) {
      // Close to the cap: back off. Throttle relative to the configured baseline
      // (not the current rate) so repeated near-limit responses can't ratchet the
      // rate toward zero. Floor the backoff at 1 req/s for normal baselines, but
      // never above the baseline itself — a sub-1/s configured rate must not be
      // pushed *up* by a "throttle".
      let newRate = Math.max(Math.min(1, this.baseTokensPerSecond), this.baseTokensPerSecond * 0.5);

      // If pacing the *remaining* quota across the reset window is slower still,
      // use that — this is what stops us from burning the last few tokens early.
      // (Previously this used `limit - remaining`, i.e. tokens already consumed,
      // which throttled hardest exactly when the most quota was left and never
      // recovered.)
      const now = Date.now();
      const timeUntilReset = reset - now;
      if (timeUntilReset > 0 && remaining >= 0) {
        const pace = remaining / (timeUntilReset / 1000);
        if (pace > 0 && pace < newRate) {
          newRate = pace;
        }
      }

      this.config.tokensPerSecond = newRate;
    } else {
      // Healthy headroom (including after the quota window resets): recover toward
      // the user-configured baseline instead of staying stuck at a degraded rate.
      this.config.tokensPerSecond = this.baseTokensPerSecond;
    }
  }

  handle429(retryAfter: number): void {
    if (this.config.adaptiveBackoff) {
      // Drain existing tokens so in-flight callers that haven't yet acquired
      // a token are queued, not bypassed. Pushing lastRefill alone pauses
      // future *refills* but leaves any accumulated tokens in the bucket —
      // requests keep going through until the bucket empties organically.
      this.tokens = 0;
      this.lastRefill = Date.now() + retryAfter * 1000;
    }
  }

  reset(): void {
    this.tokens = this.config.maxTokens;
    this.config.tokensPerSecond = this.baseTokensPerSecond;
    this.lastRefill = Date.now();
    for (const item of this.queue) {
      item.reject(new Error("Rate limiter was reset"));
    }
    this.queue = [];
  }
}
