import { describe, expect, it, vi } from "vitest";
import type { NormalizedResponse } from "../../core/types.js";
import { MeridianError } from "../../core/types.js";
import type { ProviderClient } from "../../index.js";
import { PaymentRouter } from "./payment-router.js";

const ok = (data: unknown = { ok: true }): NormalizedResponse<unknown> => ({
  data,
  meta: {
    provider: "p",
    requestId: "r",
    rateLimit: { limit: 1, remaining: 1, reset: new Date() },
    warnings: [],
    schemaVersion: "1.0",
  },
});

const client = (overrides: Partial<ProviderClient> = {}): ProviderClient =>
  ({
    get: async () => ok() as never,
    post: async () => ok() as never,
    put: async () => ok() as never,
    patch: async () => ok() as never,
    delete: async () => ok() as never,
    paginate: async function* () {},
    stream: async function* () {},
    batch: async () => [],
    ...overrides,
  }) as ProviderClient;

describe("PaymentRouter failover safety", () => {
  it("does NOT replay a failed POST charge on a second gateway", async () => {
    const a = client({
      post: vi.fn(async () => {
        throw new MeridianError("connection reset", "network", "a", true);
      }) as never,
    });
    const b = client();
    const bPost = vi.spyOn(b, "post");
    const router = new PaymentRouter([a, b]);

    await expect(router.post("/charges", { body: { amount: 5000 } })).rejects.toBeInstanceOf(
      MeridianError,
    );
    // The charge must never reach gateway B — that would double-charge.
    expect(bPost).not.toHaveBeenCalled();
  });

  it("does NOT replay a failed PATCH on a second gateway", async () => {
    const a = client({
      patch: vi.fn(async () => {
        throw new MeridianError("502", "provider", "a", true);
      }) as never,
    });
    const b = client();
    const bPatch = vi.spyOn(b, "patch");
    const router = new PaymentRouter([a, b]);
    await expect(router.patch("/x")).rejects.toBeInstanceOf(MeridianError);
    expect(bPatch).not.toHaveBeenCalled();
  });

  it("still fails over safe/idempotent reads (GET)", async () => {
    const a = client({
      get: async () => {
        throw new MeridianError("network", "network", "a", true);
      },
    });
    const b = client({ get: async () => ok({ id: "from-b" }) as never });
    const router = new PaymentRouter([a, b]);
    const res = await router.get<{ id: string }>("/status");
    expect(res.data.id).toBe("from-b");
  });
});
