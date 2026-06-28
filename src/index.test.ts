import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { MeridianError, SDK_VERSION } from "./core/types.js";
import { Meridian } from "./index.js";
import { MockAdapter } from "./testing/mock-adapter.js";

describe("Meridian - Built-in Adapter Auto-Registration", () => {
  it("should auto-register GitHub adapter without explicit adapter parameter", async () => {
    const meridian = await Meridian.create({
      github: {
        auth: { token: "test-token" },
      },
      localUnsafe: true,
    });

    expect(meridian).toBeDefined();

    expect((meridian as any).github).toBeDefined();
  });

  it("should work with nested providers config", async () => {
    const meridian = await Meridian.create({
      providers: {
        github: {
          auth: { token: "test-token" },
        },
      },
      localUnsafe: true,
    });

    expect(meridian).toBeDefined();
    expect((meridian as any).github).toBeDefined();
  });
});

describe("Meridian - providers() caching", () => {
  it("includes a provider registered after start(), not a stale cached list", async () => {
    const meridian = await Meridian.create({
      github: { auth: { token: "t" } },
      localUnsafe: true,
    });

    // Warm the cache before registering the new provider.
    expect(meridian.providers().map((p) => p.name)).toEqual(["github"]);

    await meridian.registerProvider("extra", new MockAdapter("extra"), { auth: {} });

    const names = meridian.providers().map((p) => p.name);
    expect(names).toContain("extra");
    expect(names).toContain("github");
  });

  it("findProviders() reflects newly registered providers, not a stale cache", async () => {
    const meridian = await Meridian.create({ localUnsafe: true });
    const adapter = new MockAdapter("custom");
    adapter.capabilities = () => ["webhooks"];
    await meridian.registerProvider("custom", adapter, { auth: {} });

    expect(meridian.findProviders({ capability: "webhooks" }).map((p) => p.name)).toEqual([
      "custom",
    ]);
  });
});

describe("Meridian - stream() error wrapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps a fetch()-level failure (e.g. CRLF-poisoned header rejected by Headers) as a MeridianError, not a raw error", async () => {
    // Node's Headers/fetch implementation throws synchronously on an invalid
    // header value (CRLF injection, etc.) before any network I/O happens.
    // The streaming path builds its own fetch() call outside the pipeline,
    // so this regression-guards that failure surfacing as a MeridianError
    // like every other failure path, instead of an unwrapped TypeError.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Headers.append: invalid header value")),
    );

    const adapter = new MockAdapter("crlf-test");
    const meridian = await Meridian.create({ localUnsafe: true });
    await meridian.registerProvider("crlf-test", adapter, { auth: {} });

    const client = meridian.provider("crlf-test");
    const iterator = client!.stream("/v1/chat")[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(MeridianError);
  });

  it("passes a caller-supplied AbortSignal through to fetch(), so stream() is cancelable", async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }),
    );

    const adapter = new MockAdapter("abort-test");
    const meridian = await Meridian.create({ localUnsafe: true });
    await meridian.registerProvider("abort-test", adapter, { auth: {} });

    const controller = new AbortController();
    const client = meridian.provider("abort-test");
    const iterator = client!
      .stream("/v1/chat", { signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(MeridianError);
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("Meridian - Version Consistency", () => {
  it("should expose SDK_VERSION that matches package.json.version", () => {
    expect(SDK_VERSION).toBe(packageJson.version);
  });
});
