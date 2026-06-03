import { describe, expect, it, vi } from "vitest";
import { CircuitState } from "../core/types.js";
import type { NormalizedResponse, RequestOptions } from "../core/types.js";
import { MeridianError } from "../core/types.js";
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
});
