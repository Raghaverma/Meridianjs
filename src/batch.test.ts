/**
 * Tests for ProviderClient.batch() — concurrent fan-out, partial failure handling,
 * ordering guarantees, and concurrency-limit enforcement.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Meridian, MeridianError, type ProviderClient } from "./public.js";

describe("ProviderClient.batch", () => {
  let inFlight = 0;
  let maxInFlight = 0;

  beforeEach(() => {
    inFlight = 0;
    maxInFlight = 0;

    const mockFetch = async (url: string | Request | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);

      // Slow endpoints resolve after a short delay so concurrency is observable.
      const delayMatch = urlStr.match(/\/slow\/(\d+)/);
      if (delayMatch) {
        await new Promise((resolve) => setTimeout(resolve, Number(delayMatch[1])));
      }

      inFlight--;

      if (urlStr.includes("/error/")) {
        const idMatch = urlStr.match(/\/error\/(\w+)/);
        return {
          ok: false,
          status: 404,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ message: `not found: ${idMatch?.[1] ?? "unknown"}` }),
          text: async () => JSON.stringify({ message: "not found" }),
        } as Response;
      }

      const idMatch = urlStr.match(/\/(?:item|slow)\/(\w+)/);
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          "content-type": "application/json",
        }),
        json: async () => ({ id: idMatch?.[1] ?? "unknown" }),
        text: async () => JSON.stringify({ id: idMatch?.[1] ?? "unknown" }),
      } as Response;
    };

    (globalThis as any).fetch = mockFetch;
  });

  async function makeClient(): Promise<ProviderClient> {
    const meridian = await Meridian.create({
      github: {
        auth: { token: "test-token" },
        rateLimit: { tokensPerSecond: 1000, maxTokens: 1000, adaptiveBackoff: false },
      },
      localUnsafe: true,
    });

    return meridian.provider("github") as ProviderClient;
  }

  it("executes all requests and returns results in request order", async () => {
    const client = await makeClient();

    const results = await client.batch([
      { method: "GET", endpoint: "/item/a" },
      { method: "GET", endpoint: "/item/b" },
      { method: "GET", endpoint: "/item/c" },
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => !(r instanceof MeridianError))).toBe(true);

    const ids = results.map((r) => (r as { data: { id: string } }).data.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns NormalizedResponse with the standard shape for successes", async () => {
    const client = await makeClient();

    const [result] = await client.batch([{ method: "GET", endpoint: "/item/a" }]);

    expect(result).not.toBeInstanceOf(MeridianError);
    const response = result as { data: unknown; meta: Record<string, unknown> };
    expect(response).toHaveProperty("data");
    expect(response).toHaveProperty("meta");
    expect(response.meta).toHaveProperty("provider", "github");
    expect(response.meta).toHaveProperty("requestId");
    expect(response.meta).toHaveProperty("rateLimit");
  });

  it("captures per-request failures as MeridianError without throwing or aborting the batch", async () => {
    const client = await makeClient();

    const results = await client.batch([
      { method: "GET", endpoint: "/item/a" },
      { method: "GET", endpoint: "/error/b" },
      { method: "GET", endpoint: "/item/c" },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).not.toBeInstanceOf(MeridianError);
    expect(results[1]).toBeInstanceOf(MeridianError);
    expect(results[2]).not.toBeInstanceOf(MeridianError);

    const error = results[1] as MeridianError;
    expect(error).toBeInstanceOf(MeridianError);
    expect(error.provider).toBe("github");
    expect(error.code).toBe("NOT_FOUND");
    expect(typeof error.retryable).toBe("boolean");
  });

  it("supports an all-failing batch without rejecting the outer promise", async () => {
    const client = await makeClient();

    const results = await client.batch([
      { method: "GET", endpoint: "/error/a" },
      { method: "GET", endpoint: "/error/b" },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r instanceof MeridianError)).toBe(true);
  });

  it("resolves an empty batch to an empty array", async () => {
    const client = await makeClient();

    const results = await client.batch([]);

    expect(results).toEqual([]);
  });

  it("respects the concurrency limit, never running more than N requests at once", async () => {
    const client = await makeClient();

    const requests = Array.from({ length: 6 }, (_, _i) => ({
      method: "GET",
      endpoint: "/slow/30",
    }));

    const results = await client.batch(requests, 2);

    expect(results).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("defaults to a concurrency limit of 10 when none is provided", async () => {
    const client = await makeClient();

    const requests = Array.from({ length: 25 }, () => ({
      method: "GET",
      endpoint: "/slow/10",
    }));

    const results = await client.batch(requests);

    expect(results).toHaveLength(25);
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });

  it("allows higher throughput with a larger concurrency limit than the default", async () => {
    const client = await makeClient();

    const requests = Array.from({ length: 12 }, () => ({
      method: "GET",
      endpoint: "/slow/20",
    }));

    const results = await client.batch(requests, 12);

    expect(results).toHaveLength(12);
    expect(maxInFlight).toBeGreaterThan(2);
  });

  it("stops starting new requests once the caller's signal is aborted, without losing any result slot", async () => {
    const client = await makeClient();
    const controller = new AbortController();

    const requests = Array.from({ length: 10 }, (_, i) => ({
      method: "GET" as const,
      endpoint: `/slow/${i === 0 ? 20 : 5}`,
    }));

    // Abort right after the batch starts — concurrencyLimit 1 means only the
    // first request has begun, so everything from index 1 onward must come
    // back as a cancellation MeridianError instead of hitting the network.
    setTimeout(() => controller.abort(), 1);

    const results = await client.batch(requests, 1, controller.signal);

    expect(results).toHaveLength(10);
    const cancelled = results.filter(
      (r) => r instanceof MeridianError && r.message.includes("cancelled"),
    );
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("runs the whole batch normally when the signal is never aborted", async () => {
    const client = await makeClient();
    const controller = new AbortController();

    const results = await client.batch(
      [
        { method: "GET", endpoint: "/item/a" },
        { method: "GET", endpoint: "/item/b" },
      ],
      10,
      controller.signal,
    );

    expect(results.every((r) => !(r instanceof MeridianError))).toBe(true);
  });
});
