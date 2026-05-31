import type { RetryConfig } from "../core/types.js";
import { IdempotencyLevel } from "../core/types.js";
import type { IdempotencyResolver } from "./idempotency.js";

export class RetryStrategy {
  private config: Required<RetryConfig>;

  constructor(config: Partial<RetryConfig> = {}, _idempotencyResolver: IdempotencyResolver) {
    this.config = {
      maxRetries: config.maxRetries ?? 0,
      baseDelay: config.baseDelay ?? 1000,
      maxDelay: config.maxDelay ?? 30000,
      jitter: config.jitter ?? true,
    };
  }

  async execute<T>(
    fn: () => Promise<T>,
    idempotencyLevel: IdempotencyLevel,
    hasIdempotencyKey: boolean,
    attempt = 0,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= this.config.maxRetries) {
        throw error;
      }

      if (!this.isExplicitlyRetryable(error)) {
        throw error;
      }

      if (!this.isIdempotencyProven(idempotencyLevel, hasIdempotencyKey)) {
        throw error;
      }

      const delay = this.calculateDelay(attempt);

      await this.sleep(delay);

      return this.execute(fn, idempotencyLevel, hasIdempotencyKey, attempt + 1);
    }
  }

  private isExplicitlyRetryable(error: unknown): boolean {
    if (error && typeof error === "object" && "retryable" in error) {
      return (error as { retryable: boolean }).retryable === true;
    }

    return false;
  }

  private isIdempotencyProven(
    idempotencyLevel: IdempotencyLevel,
    hasIdempotencyKey: boolean,
  ): boolean {
    switch (idempotencyLevel) {
      case IdempotencyLevel.SAFE:
      case IdempotencyLevel.IDEMPOTENT:
        return true;
      case IdempotencyLevel.CONDITIONAL:
        return hasIdempotencyKey;
      case IdempotencyLevel.UNSAFE:
        return false;
      default:
        return false;
    }
  }

  private calculateDelay(attempt: number): number {
    let delay = this.config.baseDelay * Math.pow(2, attempt);

    if (this.config.jitter) {
      const jitter = Math.random() * 1000;
      delay += jitter;
    }

    return Math.min(delay, this.config.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
