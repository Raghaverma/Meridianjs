import { describe, expect, it } from "vitest";
import type { NormalizedResponse } from "../core/types.js";
import { MeridianError } from "../core/types.js";
import type { ProviderClient } from "../index.js";
import { PaymentRouter } from "../routers/payment-router.js";
import { ServiceClient } from "./service-client.js";

/**
 * Property-based safety tests for cross-provider failover — the guarantee that
 * matters most for the fintech wedge: a non-idempotent write (a charge) must
 * NEVER be silently replayed on a second provider, while idempotent reads still
 * fail over correctly. Hundreds of seeded-random topologies are checked.
 */

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Behavior = "ok" | "failover-error" | "fatal-error";

function makeResp(id: string): NormalizedResponse<unknown> {
  return {
    data: { id },
    meta: {
      provider: id,
      requestId: "r",
      rateLimit: { limit: 1, remaining: 1, reset: new Date() },
      warnings: [],
      schemaVersion: "1.0",
    },
  };
}

function makeClient(id: string, behavior: Behavior, calls: string[]): ProviderClient {
  const handler = async () => {
    calls.push(id);
    if (behavior === "ok") return makeResp(id) as never;
    // "network" is in the default failoverOn set; "validation" is not.
    if (behavior === "failover-error") throw new MeridianError("net", "network", id, true);
    throw new MeridianError("bad", "validation", id, false);
  };
  return {
    get: handler,
    post: handler,
    put: handler,
    patch: handler,
    delete: handler,
    paginate: async function* () {},
    stream: async function* () {},
    batch: async () => [],
  } as ProviderClient;
}

const methods = ["get", "post", "put", "patch", "delete"] as const;
const RUNS = 400;

for (const kind of ["ServiceClient", "PaymentRouter"] as const) {
  describe(`property: ${kind} failover safety`, () => {
    it("never replays POST/PATCH; reads fail over in order with no repeats", async () => {
      const rng = makeRng(kind === "ServiceClient" ? 30 : 31);
      for (let run = 0; run < RUNS; run++) {
        const n = 2 + Math.floor(rng() * 4);
        const behaviors: Behavior[] = [];
        for (let i = 0; i < n; i++) {
          const r = rng();
          behaviors.push(r < 0.45 ? "failover-error" : r < 0.6 ? "fatal-error" : "ok");
        }
        const calls: string[] = [];
        const names = behaviors.map((_, i) => `p${i}`);
        const clients = behaviors.map((b, i) => makeClient(names[i]!, b, calls));
        const method = methods[Math.floor(rng() * methods.length)]!;
        const router =
          kind === "ServiceClient"
            ? new ServiceClient(names, clients, { strategy: "failover" })
            : new PaymentRouter(clients, { strategy: "failover" });

        let ok = false;
        try {
          await router[method]("/x");
          ok = true;
        } catch {
          /* expected for some topologies */
        }

        const idempotent = method === "get" || method === "put" || method === "delete";

        if (!idempotent) {
          // INVARIANT: a non-idempotent write only ever touches the primary provider.
          expect(calls).toEqual([names[0]]);
          continue;
        }

        // INVARIANT: each provider invoked at most once.
        expect(new Set(calls).size).toBe(calls.length);
        // INVARIANT: providers tried strictly in failover order (a prefix of names).
        expect(calls).toEqual(names.slice(0, calls.length));
        // INVARIANT: everything before the terminating provider was a failover error.
        for (let i = 0; i < calls.length - 1; i++) {
          expect(behaviors[i]).toBe("failover-error");
        }
        // INVARIANT: it stops for the right reason.
        const last = behaviors[calls.length - 1];
        if (ok) {
          expect(last).toBe("ok");
        } else {
          // Either hit a fatal (non-failover) error, or exhausted every provider.
          expect(last === "fatal-error" || (last === "failover-error" && calls.length === n)).toBe(
            true,
          );
        }
      }
    });
  });
}
