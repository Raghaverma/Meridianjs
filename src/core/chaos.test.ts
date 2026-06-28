import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { Meridian } from "../index.js";
import { MeridianError } from "./types.js";

/**
 * Chaos testing: inject the failure modes a real upstream actually produces
 * (5xx, 429, timeouts, connection resets, slow responses, corrupted JSON,
 * truncated bodies) at random into the request pipeline, and assert the
 * invariant that must hold no matter what — every request either succeeds or
 * rejects with a MeridianError. A raw, unwrapped error escaping means some
 * failure mode bypasses the SDK's error-normalization contract.
 */

type Fault =
  | { kind: "success" }
  | { kind: "http500" }
  | { kind: "http429" }
  | { kind: "timeout" }
  | { kind: "connectionReset" }
  | { kind: "corruptedJson" }
  | { kind: "truncatedBody" };

const faultArb: fc.Arbitrary<Fault> = fc
  .constantFrom<Fault["kind"]>(
    "success",
    "http500",
    "http429",
    "timeout",
    "connectionReset",
    "corruptedJson",
    "truncatedBody",
  )
  .map((kind) => ({ kind }));

function installChaosFetch(faultQueue: Fault[]): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const fault = faultQueue[i++ % faultQueue.length] ?? { kind: "success" };
    switch (fault.kind) {
      case "success":
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response;
      case "http500":
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: "internal error" }),
          text: async () => JSON.stringify({ message: "internal error" }),
        } as Response;
      case "http429":
        return {
          ok: false,
          status: 429,
          headers: new Headers({ "content-type": "application/json", "retry-after": "1" }),
          json: async () => ({ message: "rate limited" }),
          text: async () => JSON.stringify({ message: "rate limited" }),
        } as Response;
      case "timeout": {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      case "connectionReset": {
        const err = new Error("socket hang up");
        (err as NodeJS.ErrnoException).code = "ECONNRESET";
        throw err;
      }
      case "corruptedJson":
        // Declares JSON but the body is not parseable JSON — exercises the
        // pipeline's json()-throws -> text()-fallback path.
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => {
            throw new SyntaxError("Unexpected token in JSON");
          },
          text: async () => "{not: valid, json",
        } as Response;
      case "truncatedBody":
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
          text: async () => '{"partial": "dat',
        } as Response;
    }
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("chaos: random upstream failure injection never escapes as a raw error", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("every request resolves or rejects with a MeridianError, for any sequence of injected faults", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(faultArb, { minLength: 1, maxLength: 8 }), async (faults) => {
        restore?.();
        restore = installChaosFetch(faults);

        const meridian = await Meridian.create({
          localUnsafe: true,
          observability: [],
          defaults: { retry: { maxRetries: 1, baseDelay: 1, maxDelay: 5, jitter: false } },
          providers: { github: { auth: { token: "t" } } },
        });

        try {
          await meridian.provider("github")!.get("/chaos");
        } catch (error) {
          expect(error).toBeInstanceOf(MeridianError);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("repeated failures open the circuit breaker instead of hammering the dead upstream forever", async () => {
    restore = installChaosFetch([{ kind: "http500" }]);

    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      defaults: {
        retry: { maxRetries: 0, baseDelay: 1, maxDelay: 5, jitter: false },
        circuitBreaker: {
          failureThreshold: 3,
          timeout: 60_000,
          successThreshold: 1,
          volumeThreshold: 3,
        },
      },
      providers: { github: { auth: { token: "t" } } },
    });

    for (let i = 0; i < 3; i++) {
      await meridian
        .provider("github")!
        .get("/chaos")
        .catch(() => {});
    }

    const status = meridian.getCircuitStatus("github");
    expect(status?.state).toBe("OPEN");

    // Once OPEN, the breaker must fail fast — no network call, still a MeridianError.
    const error = await meridian
      .provider("github")!
      .get("/chaos")
      .catch((e) => e);
    expect(error).toBeInstanceOf(MeridianError);
  });

  it("a connection reset on every attempt still produces a MeridianError, not a raw Node error", async () => {
    restore = installChaosFetch([{ kind: "connectionReset" }]);

    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      defaults: { retry: { maxRetries: 0, baseDelay: 1, maxDelay: 5, jitter: false } },
      providers: { github: { auth: { token: "t" } } },
    });

    const error = await meridian
      .provider("github")!
      .get("/chaos")
      .catch((e) => e);
    expect(error).toBeInstanceOf(MeridianError);
  });

  it("corrupted JSON in a 200 response doesn't crash the pipeline", async () => {
    restore = installChaosFetch([{ kind: "corruptedJson" }]);

    const meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      providers: { github: { auth: { token: "t" } } },
    });

    // Falls back to the raw text body rather than throwing — JSON-shaped
    // content-type with an unparseable body is a malformed response, not a
    // transport failure.
    const res = await meridian.provider("github")!.get("/chaos");
    expect(res).toBeDefined();
  });
});
