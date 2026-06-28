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
});

describe("Meridian - Version Consistency", () => {
  it("should expose SDK_VERSION that matches package.json.version", () => {
    expect(SDK_VERSION).toBe(packageJson.version);
  });
});
