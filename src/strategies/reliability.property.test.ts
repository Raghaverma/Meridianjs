import { describe, expect, it, vi } from "vitest";
import { IdempotencyLevel } from "../core/types.js";
import { ProviderCircuitBreaker } from "./circuit-breaker.js";
import type { IdempotencyResolver } from "./idempotency.js";
import { RateLimiter } from "./rate-limit.js";
import { RetryStrategy } from "./retry.js";

/**
 * Property-based ("invariant") tests for the reliability primitives — the moat.
 *
 * Each test generates hundreds of randomized scenarios with a *seeded* PRNG, so
 * runs are deterministic and reproducible (no flaky randomness in CI) while still
 * exploring a wide input space. We assert invariants that must hold for ALL
 * inputs, not hand-picked examples.
 */

// mulberry32 — tiny deterministic PRNG.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 300;
const rate = (rl: RateLimiter) =>
  (rl as unknown as { config: { tokensPerSecond: number } }).config.tokensPerSecond;
const tokens = (rl: RateLimiter) => (rl as unknown as { tokens: number }).tokens;

describe("property: RateLimiter", () => {
  it("keeps 0 < rate <= baseline for any header sequence, and recovers when healthy", () => {
    const rng = makeRng(1);
    for (let run = 0; run < RUNS; run++) {
      const base = 0.1 + rng() * 200; // deliberately includes sub-1/s baselines
      const rl = new RateLimiter({
        tokensPerSecond: base,
        maxTokens: 1 + rng() * 100,
        adaptiveBackoff: true,
      });
      let lastUtil = 0;
      const steps = 1 + Math.floor(rng() * 8);
      for (let s = 0; s < steps; s++) {
        const limit = 1 + Math.floor(rng() * 1000);
        const remaining = Math.floor(rng() * (limit + 1)); // [0, limit]
        lastUtil = (limit - remaining) / limit;
        const skew = (rng() < 0.5 ? 1 : -1) * rng() * 120_000;
        rl.updateFromHeaders(new Headers(), {
          limit,
          remaining,
          reset: new Date(Date.now() + skew),
        });

        // INVARIANT: rate is always positive and never exceeds the configured baseline.
        expect(rate(rl)).toBeGreaterThan(0);
        expect(rate(rl)).toBeLessThanOrEqual(base + 1e-9);
      }
      // INVARIANT: with healthy headroom on the last reading, the rate is fully restored.
      if (lastUtil <= 0.8) expect(rate(rl)).toBeCloseTo(base, 9);
    }
  });

  it("never mutates the rate when adaptiveBackoff is disabled", () => {
    const rng = makeRng(2);
    for (let run = 0; run < RUNS; run++) {
      const base = 0.1 + rng() * 100;
      const rl = new RateLimiter({ tokensPerSecond: base, adaptiveBackoff: false });
      rl.updateFromHeaders(new Headers(), {
        limit: 100,
        remaining: Math.floor(rng() * 100),
        reset: new Date(),
      });
      expect(rate(rl)).toBe(base);
    }
  });

  it("keeps tokens within [0, maxTokens] across random refills and acquires", async () => {
    vi.useFakeTimers();
    try {
      const rng = makeRng(3);
      for (let run = 0; run < 60; run++) {
        const maxTokens = 1 + Math.floor(rng() * 50);
        const rl = new RateLimiter({
          tokensPerSecond: 0.5 + rng() * 50,
          maxTokens,
          adaptiveBackoff: false,
        });
        for (let s = 0; s < 40; s++) {
          if (rng() < 0.5) {
            vi.advanceTimersByTime(Math.floor(rng() * 2000));
          } else if (tokens(rl) >= 1) {
            await rl.acquire();
          }
          expect(tokens(rl)).toBeGreaterThanOrEqual(-1e-9);
          expect(tokens(rl)).toBeLessThanOrEqual(maxTokens + 1e-9);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("property: ProviderCircuitBreaker", () => {
  it("never executes the wrapped fn while OPEN before its timeout", async () => {
    vi.useFakeTimers();
    try {
      const rng = makeRng(10);
      for (let run = 0; run < 80; run++) {
        const cb = new ProviderCircuitBreaker("p", {
          failureThreshold: 1 + Math.floor(rng() * 6),
          successThreshold: 1 + Math.floor(rng() * 3),
          timeout: 1000 + Math.floor(rng() * 60_000),
          volumeThreshold: 1 + Math.floor(rng() * 10),
          rollingWindowMs: 1000 + Math.floor(rng() * 60_000),
          errorThresholdPercentage: 1 + Math.floor(rng() * 100),
        });
        let violations = 0;
        for (let s = 0; s < 60; s++) {
          const before = cb.getStatus();
          const blocked =
            before.state === "OPEN" &&
            before.nextAttempt !== null &&
            Date.now() < before.nextAttempt.getTime();
          let called = false;
          const succeed = rng() < 0.4;
          try {
            await cb.execute(async () => {
              called = true;
              if (!succeed) throw new Error("boom");
              return 1;
            });
          } catch {
            /* expected */
          }
          // INVARIANT: an OPEN breaker inside its cooldown must not hit the provider.
          if (blocked && called) violations++;
          if (rng() < 0.3) vi.advanceTimersByTime(Math.floor(rng() * 70_000));
          // INVARIANT: state is always a valid enum member.
          expect(["CLOSED", "OPEN", "HALF_OPEN"]).toContain(cb.getStatus().state);
        }
        expect(violations).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes from HALF_OPEN after exactly successThreshold consecutive successes", async () => {
    vi.useFakeTimers();
    try {
      const rng = makeRng(11);
      for (let run = 0; run < 50; run++) {
        const failureThreshold = 1 + Math.floor(rng() * 3);
        const successThreshold = 1 + Math.floor(rng() * 3);
        const timeout = 1000;
        const cb = new ProviderCircuitBreaker("p", {
          failureThreshold,
          successThreshold,
          timeout,
          volumeThreshold: 1,
        });
        for (let i = 0; i < failureThreshold; i++) {
          try {
            await cb.execute(async () => {
              throw new Error("x");
            });
          } catch {
            /* expected */
          }
        }
        if (cb.getStatus().state === "OPEN") {
          vi.advanceTimersByTime(timeout + 1);
          for (let i = 0; i < successThreshold; i++) {
            await cb.execute(async () => 1);
          }
          expect(cb.getStatus().state).toBe("CLOSED");
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("property: RetryStrategy", () => {
  const noopResolver = {} as unknown as IdempotencyResolver;
  const levels = [
    IdempotencyLevel.SAFE,
    IdempotencyLevel.IDEMPOTENT,
    IdempotencyLevel.CONDITIONAL,
    IdempotencyLevel.UNSAFE,
  ];

  it("bounds attempts to maxRetries+1 and only retries when retryable AND idempotency-proven", async () => {
    const rng = makeRng(20);
    for (let run = 0; run < RUNS; run++) {
      const maxRetries = Math.floor(rng() * 6);
      const retry = new RetryStrategy(
        { maxRetries, baseDelay: 0, maxDelay: 0, jitter: false },
        noopResolver,
      );
      const retryable = rng() < 0.5;
      const level = levels[Math.floor(rng() * levels.length)]!;
      const hasKey = rng() < 0.5;
      let calls = 0;
      const fn = async () => {
        calls++;
        throw { retryable, message: "e" };
      };
      try {
        await retry.execute(
          fn,
          level,
          hasKey,
          0,
          (e) => (e as { retryable?: boolean })?.retryable === true,
        );
      } catch {
        /* expected */
      }

      const idemAllows =
        level === IdempotencyLevel.SAFE ||
        level === IdempotencyLevel.IDEMPOTENT ||
        (level === IdempotencyLevel.CONDITIONAL && hasKey);
      const willRetry = retryable && idemAllows;
      // INVARIANT: a non-retryable error or an unproven idempotency level is tried once.
      expect(calls).toBe(willRetry ? maxRetries + 1 : 1);
    }
  });

  it("stops at the first success and returns it", async () => {
    const rng = makeRng(21);
    for (let run = 0; run < RUNS; run++) {
      const maxRetries = Math.floor(rng() * 6);
      const succeedAt = Math.floor(rng() * (maxRetries + 2)); // 0..maxRetries+1
      const retry = new RetryStrategy(
        { maxRetries, baseDelay: 0, maxDelay: 0, jitter: false },
        noopResolver,
      );
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls <= succeedAt) throw { retryable: true };
        return "ok";
      };
      let result: string | undefined;
      let threw = false;
      try {
        result = await retry.execute(fn, IdempotencyLevel.SAFE, false, 0, () => true);
      } catch {
        threw = true;
      }
      if (succeedAt <= maxRetries) {
        expect(threw).toBe(false);
        expect(result).toBe("ok");
        expect(calls).toBe(succeedAt + 1);
      } else {
        expect(threw).toBe(true);
        expect(calls).toBe(maxRetries + 1);
      }
    }
  });
});
