import { describe, expect, it } from "vitest";
import { ProviderCircuitBreaker } from "./circuit-breaker.js";

/**
 * Regression coverage for the recentResults memory bound.
 *
 * recentResults is pruned by age (rollingWindowMs) on every push, but had no
 * cap on count — sustained high-throughput traffic completing faster than the
 * rolling window elapses (e.g. thousands of requests/sec against the default
 * 60s window) meant nothing aged out, so the array grew proportionally to
 * throughput × window with no upper bound. Verified via a memory-growth
 * probe (benchmarks/memory.ts) showing real, unbounded heap growth before
 * this fix.
 */
describe("ProviderCircuitBreaker — recentResults memory bound", () => {
  it("caps recentResults at MAX_RECENT_RESULTS even when every result is within the rolling window", async () => {
    const cb = new ProviderCircuitBreaker("test", {
      failureThreshold: 1_000_000, // never actually trip the breaker
      volumeThreshold: 1_000_000,
      rollingWindowMs: 60_000, // default — all pushes below land in-window
    });

    for (let i = 0; i < 5000; i++) {
      await cb.execute(async () => "ok");
    }

    // Internal field — there's no public accessor, and that's the point:
    // this guards memory behavior, not a documented API contract.
    const recentResults = (cb as unknown as { recentResults: unknown[] }).recentResults;
    expect(recentResults.length).toBeLessThanOrEqual(1000);
  });

  it("getStatus() still reflects the most recent failure after the cap trims older entries", async () => {
    const cb = new ProviderCircuitBreaker("test", {
      failureThreshold: 1_000_000,
      volumeThreshold: 1_000_000,
      rollingWindowMs: 60_000,
    });

    for (let i = 0; i < 1500; i++) {
      await cb.execute(async () => "ok").catch(() => {});
    }
    await cb
      .execute(async () => {
        throw new Error("boom");
      })
      .catch(() => {});

    expect(cb.getStatus().lastFailure).not.toBeNull();
  });
});
