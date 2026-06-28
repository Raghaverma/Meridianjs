import { describe, expect, it } from "vitest";
import { ALL_ADAPTER_CLASSES } from "../../providers/all-adapters.js";
import { buildMeridianConfig, PROVIDER_CATEGORIES, SUPPORTED_PROVIDERS } from "./shared.js";

describe("Boundary Proxy provider parity", () => {
  it("exposes every built-in adapter via SUPPORTED_PROVIDERS", () => {
    // Guards the gap where adapters existed in the SDK but were unreachable from
    // the proxy (billdesk, ccavenue, datadog, googlemaps, hunter, s3, sentry).
    const registered = Object.keys(ALL_ADAPTER_CLASSES).sort();
    const exposed = [...SUPPORTED_PROVIDERS].sort();
    const missing = registered.filter((p) => !exposed.includes(p));
    expect(missing).toEqual([]);
  });

  it("provides an initializable config for every exposed provider", () => {
    const cfg = buildMeridianConfig({});
    const providers = cfg.providers ?? {};
    for (const name of SUPPORTED_PROVIDERS) {
      expect(providers[name], `missing buildMeridianConfig entry for "${name}"`).toBeDefined();
      expect(providers[name]?.auth).toBeDefined();
    }
  });

  it("lists every exposed provider under exactly one category", () => {
    const categorized = Object.values(PROVIDER_CATEGORIES).flat();
    for (const name of SUPPORTED_PROVIDERS) {
      expect(categorized.filter((p) => p === name).length, `category for "${name}"`).toBe(1);
    }
  });
});
