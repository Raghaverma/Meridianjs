import { describe, expect, it, vi } from "vitest";
import type { NormalizedResponse } from "../core/types.js";
import { CircuitState, MeridianError } from "../core/types.js";
import type { ProviderClient } from "../index.js";
import { ServiceClient } from "./service-client.js";

const makeResponse = (data: unknown = {}, latencyMs = 50): NormalizedResponse<unknown> => ({
  data,
  meta: {
    provider: "test",
    requestId: "req-1",
    rateLimit: { limit: 100, remaining: 99, reset: new Date() },
    warnings: [],
    schemaVersion: "1.0",
    trace: {
      retries: 0,
      latency: latencyMs,
      circuitBreaker: CircuitState.CLOSED,
      rateLimitRemaining: 99,
    },
  },
});

const makeClient = (
  impl: (method: string, endpoint: string) => Promise<NormalizedResponse<unknown>>,
): ProviderClient => ({
  get: (e) => impl("get", e) as Promise<NormalizedResponse<never>>,
  post: (e) => impl("post", e) as Promise<NormalizedResponse<never>>,
  put: (e) => impl("put", e) as Promise<NormalizedResponse<never>>,
  patch: (e) => impl("patch", e) as Promise<NormalizedResponse<never>>,
  delete: (e) => impl("delete", e) as Promise<NormalizedResponse<never>>,
  paginate: async function* () {},
  stream: async function* () {},
  batch: async () => [],
});

const failClient = (category: MeridianError["category"] = "provider"): ProviderClient =>
  makeClient(async () => {
    throw new MeridianError("fail", category, "test", true);
  });

const successClient = (data = {}, latency = 50): ProviderClient =>
  makeClient(async () => makeResponse(data, latency));

describe("ServiceClient", () => {
  describe("failover strategy", () => {
    it("returns first provider on success", async () => {
      const svc = new ServiceClient(
        ["a", "b"],
        [successClient({ id: 1 }), successClient({ id: 2 })],
        { strategy: "failover" },
      );
      const r = await svc.get("/test");
      expect((r.data as { id: number }).id).toBe(1);
    });

    it("falls through to second on retryable error", async () => {
      const svc = new ServiceClient(["a", "b"], [failClient("network"), successClient({ id: 2 })], {
        strategy: "failover",
      });
      const r = await svc.get("/test");
      expect((r.data as { id: number }).id).toBe(2);
    });

    it("throws if all providers fail", async () => {
      const svc = new ServiceClient(["a", "b"], [failClient("network"), failClient("provider")], {
        strategy: "failover",
      });
      await expect(svc.get("/test")).rejects.toBeInstanceOf(MeridianError);
    });

    it("does not failover on non-retryable error categories", async () => {
      const svc = new ServiceClient(["a", "b"], [failClient("auth"), successClient({ id: 2 })], {
        strategy: "failover",
        failoverOn: ["network", "provider"],
      });
      await expect(svc.get("/test")).rejects.toBeInstanceOf(MeridianError);
    });

    it("respects custom failoverOn categories", async () => {
      const svc = new ServiceClient(["a", "b"], [failClient("auth"), successClient({ id: 2 })], {
        strategy: "failover",
        failoverOn: ["auth"],
      });
      const r = await svc.get("/test");
      expect((r.data as { id: number }).id).toBe(2);
    });

    it("does NOT fail over a non-idempotent POST to another provider", async () => {
      // A POST that fails after possibly executing must not be silently replayed
      // on a second provider (double side effect). The error propagates instead.
      const b = successClient({ id: 2 });
      const bPost = vi.spyOn(b, "post");
      const svc = new ServiceClient(["a", "b"], [failClient("network"), b], {
        strategy: "failover",
      });
      await expect(svc.post("/charge")).rejects.toBeInstanceOf(MeridianError);
      expect(bPost).not.toHaveBeenCalled();
    });

    it("still fails over idempotent GET/PUT/DELETE", async () => {
      const svc = new ServiceClient(["a", "b"], [failClient("network"), successClient({ id: 2 })], {
        strategy: "failover",
      });
      expect(((await svc.get("/x")).data as { id: number }).id).toBe(2);
      expect(((await svc.put("/x")).data as { id: number }).id).toBe(2);
      expect(((await svc.delete("/x")).data as { id: number }).id).toBe(2);
    });
  });

  describe("round-robin strategy", () => {
    it("rotates across providers evenly", async () => {
      const calls: number[] = [];
      const clients = [0, 1, 2].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse({ i });
        }),
      );
      const svc = new ServiceClient(["a", "b", "c"], clients, { strategy: "round-robin" });
      await svc.get("/test");
      await svc.get("/test");
      await svc.get("/test");
      expect(calls).toEqual([0, 1, 2]);
    });

    it("wraps around after all providers used", async () => {
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["a", "b"], clients, { strategy: "round-robin" });
      await svc.get("/test");
      await svc.get("/test");
      await svc.get("/test");
      expect(calls).toEqual([0, 1, 0]);
    });
  });

  describe("lowest-latency strategy", () => {
    it("routes to fastest provider after calibration", async () => {
      const calls: number[] = [];
      const clients = [
        makeClient(async () => {
          calls.push(0);
          return makeResponse({}, 300);
        }),
        makeClient(async () => {
          calls.push(1);
          return makeResponse({}, 50);
        }),
      ];
      const svc = new ServiceClient(["slow", "fast"], clients, { strategy: "lowest-latency" });
      // First two calls calibrate (latency 0 → picks index 0 first)
      await svc.get("/test");
      await svc.get("/test");
      // After calibration, fast provider (index 1, latency 50ms) should win
      await svc.get("/test");
      expect(calls[2]).toBe(1);
    });
  });

  describe("cheapest strategy", () => {
    it("routes to the cheapest provider", async () => {
      const calls: number[] = [];
      const clients = [
        makeClient(async () => {
          calls.push(0);
          return makeResponse();
        }),
        makeClient(async () => {
          calls.push(1);
          return makeResponse();
        }),
        makeClient(async () => {
          calls.push(2);
          return makeResponse();
        }),
      ];
      const svc = new ServiceClient(["openai", "anthropic", "gemini"], clients, {
        strategy: "cheapest",
        costs: { openai: 0.03, anthropic: 0.01, gemini: 0.02 },
      });
      await svc.get("/test");
      expect(calls[0]).toBe(1); // anthropic is cheapest
    });

    it("fails over in cost order", async () => {
      const calls: number[] = [];
      const clients = [
        makeClient(async () => {
          calls.push(0);
          throw new MeridianError("fail", "network", "openai", true);
        }),
        makeClient(async () => {
          calls.push(1);
          throw new MeridianError("fail", "network", "anthropic", true);
        }),
        makeClient(async () => {
          calls.push(2);
          return makeResponse({ winner: "gemini" });
        }),
      ];
      const svc = new ServiceClient(["openai", "anthropic", "gemini"], clients, {
        strategy: "cheapest",
        costs: { openai: 0.03, anthropic: 0.01, gemini: 0.02 },
      });
      const r = await svc.get("/test");
      expect((r.data as { winner: string }).winner).toBe("gemini");
      // Called in order: anthropic (0.01) → gemini (0.02) → openai (0.03)
      expect(calls).toEqual([1, 2]);
    });
  });

  describe("highest-success-rate strategy", () => {
    it("routes to highest success-rate provider", async () => {
      const calls: number[] = [];
      const clients = [
        makeClient(async () => {
          calls.push(0);
          return makeResponse();
        }),
        makeClient(async () => {
          calls.push(1);
          return makeResponse();
        }),
      ];
      const getStats = vi.fn().mockReturnValue({
        a: { successRate: "95.0%" },
        b: { successRate: "99.9%" },
      });
      const svc = new ServiceClient(
        ["a", "b"],
        clients,
        { strategy: "highest-success-rate" },
        getStats,
      );
      await svc.get("/test");
      expect(calls[0]).toBe(1); // b has higher success rate
    });
  });

  describe("constructor", () => {
    it("throws when no providers given", () => {
      expect(() => new ServiceClient([], [], { strategy: "failover" })).toThrow();
    });
  });

  describe("HTTP methods", () => {
    it.each(["post", "put", "patch", "delete"] as const)("%s routes correctly", async (method) => {
      const called = vi.fn().mockResolvedValue(makeResponse());
      const client = makeClient(called);
      const svc = new ServiceClient(["a"], [client], { strategy: "failover" });
      await svc[method]("/endpoint");
      expect(called).toHaveBeenCalledWith(method, "/endpoint");
    });
  });

  describe("weighted strategy", () => {
    it("routes all traffic to single provider when others have zero weight", async () => {
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["a", "b"], clients, {
        strategy: "weighted",
        weights: { a: 1, b: 0 },
      });
      for (let i = 0; i < 10; i++) await svc.get("/test");
      expect(calls.every((c) => c === 0)).toBe(true);
    });

    it("distributes traffic across providers with equal weights", async () => {
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["a", "b"], clients, {
        strategy: "weighted",
        weights: { a: 50, b: 50 },
      });
      for (let i = 0; i < 100; i++) await svc.get("/test");
      const countA = calls.filter((c) => c === 0).length;
      const countB = calls.filter((c) => c === 1).length;
      expect(countA).toBeGreaterThan(20);
      expect(countB).toBeGreaterThan(20);
    });

    it("fails over from weighted primary to secondary on error", async () => {
      const svc = new ServiceClient(
        ["heavy", "light"],
        [failClient("network"), successClient({ ok: true })],
        { strategy: "weighted", weights: { heavy: 100, light: 1 } },
      );
      const r = await svc.get("/test");
      expect((r.data as { ok: boolean }).ok).toBe(true);
    });
  });

  describe("geo strategy", () => {
    it("routes to region-preferred provider when MERIDIAN_REGION is set", async () => {
      const originalEnv = process.env.MERIDIAN_REGION;
      process.env.MERIDIAN_REGION = "ap-south-1";
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["stripe", "razorpay"], clients, {
        strategy: "geo",
        regions: { "ap-south-1": ["razorpay"], "us-east-1": ["stripe"] },
      });
      await svc.get("/test");
      expect(calls[0]).toBe(1); // razorpay is at index 1
      process.env.MERIDIAN_REGION = originalEnv;
    });

    it("falls back to index 0 when no region configured", async () => {
      Reflect.deleteProperty(process.env, "MERIDIAN_REGION");
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["a", "b"], clients, {
        strategy: "geo",
        regions: {},
      });
      await svc.get("/test");
      expect(calls[0]).toBe(0);
    });

    it("uses defaultRegion when MERIDIAN_REGION env not set", async () => {
      Reflect.deleteProperty(process.env, "MERIDIAN_REGION");
      const calls: number[] = [];
      const clients = [0, 1].map((i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );
      const svc = new ServiceClient(["stripe", "razorpay"], clients, {
        strategy: "geo",
        regions: { "ap-south-1": ["razorpay"] },
        defaultRegion: "ap-south-1",
      });
      await svc.get("/test");
      expect(calls[0]).toBe(1); // razorpay
    });

    it("fails over to non-region provider when region primary fails", async () => {
      process.env.MERIDIAN_REGION = "ap-south-1";
      const svc = new ServiceClient(
        ["razorpay", "stripe"],
        [failClient("network"), successClient({ fallback: true })],
        {
          strategy: "geo",
          regions: { "ap-south-1": ["razorpay"] },
        },
      );
      const r = await svc.get("/test");
      expect((r.data as { fallback: boolean }).fallback).toBe(true);
      Reflect.deleteProperty(process.env, "MERIDIAN_REGION");
    });
  });

  describe("adaptive strategy", () => {
    const trackingClients = (n: number, calls: number[]) =>
      Array.from({ length: n }, (_, i) =>
        makeClient(async () => {
          calls.push(i);
          return makeResponse();
        }),
      );

    it("routes to the provider with the best success rate", async () => {
      const calls: number[] = [];
      const svc = new ServiceClient(
        ["a", "b"],
        trackingClients(2, calls),
        { strategy: "adaptive" },
        () => ({
          a: { successRate: "80.0%" },
          b: { successRate: "99.5%" },
        }),
      );
      await svc.get("/test");
      expect(calls[0]).toBe(1); // b: higher success rate
    });

    it("ranks an OPEN-breaker provider last even with a perfect success rate", async () => {
      const calls: number[] = [];
      const svc = new ServiceClient(
        ["a", "b"],
        trackingClients(2, calls),
        { strategy: "adaptive" },
        () => ({
          a: { successRate: "100.0%" },
          b: { successRate: "97.0%" },
        }),
        () => ({ a: "OPEN", b: "CLOSED" }),
      );
      await svc.get("/test");
      // a scores 0.5·1.0 + 0.3·1 + 0.2·0 = 0.80; b scores 0.5·0.97 + 0.3 + 0.2 = 0.985
      expect(calls[0]).toBe(1);
    });

    it("is deterministic: explores unobserved providers once, then settles to config order", async () => {
      const calls: number[] = [];
      const svc = new ServiceClient(["a", "b", "c"], trackingClients(3, calls), {
        strategy: "adaptive",
      });
      await svc.get("/1"); // all unobserved → config order → a
      await svc.get("/2"); // b and c unobserved → explore b
      await svc.get("/3"); // c unobserved → explore c
      await svc.get("/4"); // all observed, equal latency → config order → a
      expect(calls).toEqual([0, 1, 2, 0]);
    });

    it("honors custom scoring weights", async () => {
      const calls: number[] = [];
      // Breaker weight zeroed out: the OPEN breaker on the higher-success
      // provider no longer matters.
      const svc = new ServiceClient(
        ["a", "b"],
        trackingClients(2, calls),
        { strategy: "adaptive", adaptiveWeights: { successRate: 1, latency: 0, breaker: 0 } },
        () => ({
          a: { successRate: "100.0%" },
          b: { successRate: "97.0%" },
        }),
        () => ({ a: "OPEN", b: "CLOSED" }),
      );
      await svc.get("/test");
      expect(calls[0]).toBe(0);
    });

    it("fails over through the score-ranked order", async () => {
      const order: string[] = [];
      const failing = makeClient(async () => {
        order.push("best-but-failing");
        throw new MeridianError("fail", "provider", "test", true);
      });
      const backup = makeClient(async () => {
        order.push("backup");
        return makeResponse({ ok: true });
      });
      const svc = new ServiceClient(
        ["backup", "best"],
        [backup, failing],
        { strategy: "adaptive" },
        () => ({
          backup: { successRate: "90.0%" },
          best: { successRate: "99.9%" },
        }),
      );
      const r = await svc.get("/test");
      expect(order).toEqual(["best-but-failing", "backup"]);
      expect((r.data as { ok: boolean }).ok).toBe(true);
    });

    it("prefers lower observed latency when success rates match", async () => {
      const calls: number[] = [];
      const clients = [
        makeClient(async () => {
          calls.push(0);
          return makeResponse({}, 500); // slow
        }),
        makeClient(async () => {
          calls.push(1);
          return makeResponse({}, 10); // fast
        }),
      ];
      const svc = new ServiceClient(["slow", "fast"], clients, { strategy: "adaptive" });
      // Warm both latency EWMAs: first request hits "slow" (config order),
      // fails over nowhere; round-robin the warmup by calling twice.
      await svc.get("/warm");
      // "slow" now has latency 500 recorded; "fast" has none (scores 1) → next pick is "fast".
      await svc.get("/test");
      expect(calls).toEqual([0, 1]);
      // With both observed, "fast" stays preferred.
      await svc.get("/again");
      expect(calls).toEqual([0, 1, 1]);
    });
  });
});
