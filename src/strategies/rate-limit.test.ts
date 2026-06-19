import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  describe("invariants", () => {
    it("tokens should never go negative", async () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 0.01,
        maxTokens: 5,
        queueSize: 1,
      });

      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      expect((limiter as any).tokens).toBeCloseTo(0, 4);

      const pending = limiter.acquire();

      await expect(limiter.acquire()).rejects.toThrow("Rate limit queue is full");

      limiter.reset();
      await expect(pending).rejects.toThrow("Rate limiter was reset");
    });

    it("elapsed time should be clamped to >= 0 after handle429", async () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 10,
        adaptiveBackoff: true,
      });

      limiter.handle429(5);

      const initialTokens = (limiter as any).tokens;
      await limiter.acquire();

      expect((limiter as any).tokens).toBe(initialTokens - 1);
    });

    it("tokens should not exceed maxTokens after refill", async () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 1000,
        maxTokens: 10,
      });

      await limiter.acquire();
      await limiter.acquire();

      await new Promise((resolve) => setTimeout(resolve, 50));

      await limiter.acquire();

      expect((limiter as any).tokens).toBeLessThanOrEqual(10);
    });

    it("reset should clear queue and restore tokens", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 10,
      });

      limiter.reset();

      expect((limiter as any).tokens).toBe(10);
      expect((limiter as any).queue.length).toBe(0);
    });

    it("queue should respect queueSize limit", async () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 0.01,
        maxTokens: 1,
        queueSize: 2,
      });

      await limiter.acquire();

      const pending1 = limiter.acquire();
      const pending2 = limiter.acquire();

      await expect(limiter.acquire()).rejects.toThrow("Rate limit queue is full");

      limiter.reset();
      await expect(pending1).rejects.toThrow("Rate limiter was reset");
      await expect(pending2).rejects.toThrow("Rate limiter was reset");
    });

    it("handle429 should pause token refill for specified duration", async () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 100,
        maxTokens: 10,
        adaptiveBackoff: true,
      });

      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      const tokensAfterAcquire = (limiter as any).tokens;

      limiter.handle429(1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      await limiter.acquire();

      expect((limiter as any).tokens).toBeLessThan(tokensAfterAcquire);
    });
  });

  describe("adaptive backoff", () => {
    it("should reduce rate when utilization > 80%", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 100,
        adaptiveBackoff: true,
      });

      const initialRate = (limiter as any).config.tokensPerSecond;

      limiter.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: 15,
        reset: new Date(Date.now() + 3600000),
      });

      expect((limiter as any).config.tokensPerSecond).toBeLessThan(initialRate);
    });

    it("recovers toward the configured baseline once quota is healthy again", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 100,
        maxTokens: 100,
        adaptiveBackoff: true,
      });
      const rate = () => (limiter as any).config.tokensPerSecond;

      // One brush with the limit drops the rate.
      limiter.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: 2,
        reset: new Date(Date.now() + 60_000),
      });
      expect(rate()).toBeLessThan(100);

      // Window resets: full quota, no pressure. The rate must climb back, not
      // stay permanently throttled (regression: it used to ratchet down only).
      limiter.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: 100,
        reset: new Date(Date.now() + 60_000),
      });
      expect(rate()).toBe(100);
    });

    it("does not throttle on normal sub-80% utilization", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 100,
        adaptiveBackoff: true,
      });
      // 20% utilization (remaining 80/100). Previously the reset-window branch
      // used tokens-consumed and collapsed the rate even here.
      limiter.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: 80,
        reset: new Date(Date.now() + 60_000),
      });
      expect((limiter as any).config.tokensPerSecond).toBe(10);
    });

    it("ignores a non-positive limit instead of dividing by it", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 100,
        adaptiveBackoff: true,
      });
      limiter.updateFromHeaders(new Headers(), {
        limit: 0,
        remaining: 0,
        reset: new Date(Date.now() + 60_000),
      });
      expect((limiter as any).config.tokensPerSecond).toBe(10);
    });

    it("should not adjust rate when adaptiveBackoff is disabled", () => {
      const limiter = new RateLimiter({
        tokensPerSecond: 10,
        maxTokens: 100,
        adaptiveBackoff: false,
      });

      const initialRate = (limiter as any).config.tokensPerSecond;

      limiter.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: 5,
        reset: new Date(Date.now() + 3600000),
      });

      expect((limiter as any).config.tokensPerSecond).toBe(initialRate);
    });
  });
});
