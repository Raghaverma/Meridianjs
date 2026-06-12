import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Meridian } from "../index.js";

/**
 * Regression coverage for retrying *real* HTTP failures.
 *
 * executeHttpRequest throws raw `{status, headers, body}` objects, which carry
 * no `retryable` flag — the pipeline must classify them through the adapter's
 * parseError at the retry decision point. Before that fix, only pre-classified
 * MeridianErrors (timeouts, mocks) ever retried; an actual upstream 429/503
 * failed immediately regardless of retry config.
 */
describe("pipeline retries on raw HTTP failures", () => {
  const originalFetch = globalThis.fetch;
  let requestLog: string[];
  let failuresByPath: Map<string, { status: number; remaining: number }>;

  beforeEach(() => {
    requestLog = [];
    failuresByPath = new Map();
    (globalThis as any).fetch = async (url: string | Request | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const path = new URL(urlStr).pathname;
      requestLog.push(path);

      const failure = failuresByPath.get(path);
      if (failure && failure.remaining > 0) {
        failure.remaining--;
        const body = { message: "upstream unhappy" };
        return {
          ok: false,
          status: failure.status,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as Response;
      }
      const body = { ok: true };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  async function createClient() {
    return Meridian.create({
      localUnsafe: true,
      observability: [],
      defaults: { retry: { maxRetries: 2, baseDelay: 1, maxDelay: 3, jitter: false } },
      providers: { github: { auth: { token: "t" } } },
    });
  }

  it("retries an HTTP 503 into a success", async () => {
    failuresByPath.set("/transient", { status: 503, remaining: 1 });
    const meridian = await createClient();

    const res = await meridian.provider("github")!.get("/transient");

    expect(res.meta.trace?.retries).toBe(1);
    expect(requestLog.filter((p) => p === "/transient")).toHaveLength(2);
  });

  it("retries an HTTP 429 into a success", async () => {
    failuresByPath.set("/limited", { status: 429, remaining: 1 });
    const meridian = await createClient();

    const res = await meridian.provider("github")!.get("/limited");

    expect(res.meta.trace?.retries).toBe(1);
    expect(requestLog.filter((p) => p === "/limited")).toHaveLength(2);
  });

  it("does not retry a non-retryable HTTP 400", async () => {
    failuresByPath.set("/bad", { status: 400, remaining: 99 });
    const meridian = await createClient();

    await expect(meridian.provider("github")!.get("/bad")).rejects.toThrow();
    expect(requestLog.filter((p) => p === "/bad")).toHaveLength(1);
  });

  it("stops after maxRetries when the failure persists", async () => {
    failuresByPath.set("/down", { status: 503, remaining: 99 });
    const meridian = await createClient();

    await expect(meridian.provider("github")!.get("/down")).rejects.toThrow();
    // 1 initial + 2 retries
    expect(requestLog.filter((p) => p === "/down")).toHaveLength(3);
  });
});
