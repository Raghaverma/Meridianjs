import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Meridian } from "../index.js";
import { MeridianError } from "./types.js";

/**
 * Regression coverage for per-request timeout override and caller-driven
 * cancellation via AbortSignal.
 *
 * Before this fix, `RequestOptions.timeout` was a documented field the
 * pipeline never read — only the pipeline-level config default applied, so a
 * caller asking for a tighter (or looser) timeout on one call silently got
 * the default instead. There was also no way to cancel an in-flight request
 * at all: `RequestOptions` had no `signal` field.
 */
describe("pipeline: per-request timeout and AbortSignal", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      // Simulate a slow upstream: only resolves if not aborted first. Real
      // fetch checks signal.aborted synchronously before starting — an
      // "abort" event that already fired in the past doesn't replay for a
      // listener attached afterward, so this mock must mirror that check.
      if (init?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          const body = { ok: true };
          resolve({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => body,
            text: async () => JSON.stringify(body),
          } as Response);
        }, 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  async function createClient(pipelineTimeoutMs = 5000) {
    return Meridian.create({
      localUnsafe: true,
      observability: [],
      defaults: { timeout: pipelineTimeoutMs },
      providers: { github: { auth: { token: "t" } } },
    });
  }

  it("honors a per-request timeout shorter than the pipeline default", async () => {
    const meridian = await createClient(5000);

    const error = await meridian
      .provider("github")!
      .get("/slow", { timeout: 20 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(MeridianError);
    expect((error as MeridianError).message).toMatch(/timeout after 20ms/);
  });

  it("does not time out when the per-request timeout is longer than the response delay", async () => {
    const meridian = await createClient(5000);
    const res = await meridian.provider("github")!.get("/slow", { timeout: 5000 });
    expect(res.data).toEqual({ ok: true });
  });

  it("cancels an in-flight request via a caller-supplied AbortSignal, distinct from a timeout", async () => {
    const meridian = await createClient(5000);
    const controller = new AbortController();

    const promise = meridian.provider("github")!.get("/slow", { signal: controller.signal });
    queueMicrotask(() => controller.abort());

    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(MeridianError);
    expect((error as MeridianError).message).toMatch(/aborted by caller/);
    expect((error as MeridianError).retryable).toBe(false);
  });

  it("treats an already-aborted signal as an immediate cancellation", async () => {
    const meridian = await createClient(5000);
    const controller = new AbortController();
    controller.abort();

    const error = await meridian
      .provider("github")!
      .get("/slow", { signal: controller.signal })
      .catch((e) => e);

    expect(error).toBeInstanceOf(MeridianError);
    expect((error as MeridianError).message).toMatch(/aborted by caller/);
  });
});
