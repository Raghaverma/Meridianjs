import type { RateLimitConfig, RateLimitInfo } from "../core/types.js";

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private config: Required<RateLimitConfig>;
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

    const utilization = (limit - remaining) / limit;
    if (utilization > 0.8) {
      this.config.tokensPerSecond = Math.max(1, this.config.tokensPerSecond * 0.5);
    }

    const now = Date.now();
    const timeUntilReset = reset - now;
    if (timeUntilReset > 0 && remaining < limit) {
      const tokensNeeded = limit - remaining;
      const newRate = tokensNeeded / (timeUntilReset / 1000);
      if (newRate > 0 && newRate < this.config.tokensPerSecond) {
        this.config.tokensPerSecond = newRate;
      }
    }
  }

  handle429(retryAfter: number): void {
    if (this.config.adaptiveBackoff) {
      this.lastRefill = Date.now() + retryAfter * 1000;
    }
  }

  reset(): void {
    this.tokens = this.config.maxTokens;
    this.lastRefill = Date.now();
    for (const item of this.queue) {
      item.reject(new Error("Rate limiter was reset"));
    }
    this.queue = [];
  }
}
