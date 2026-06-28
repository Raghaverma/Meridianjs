import { describe } from "vitest";
import { runProviderContract } from "../testing/contract.js";
import { ALL_ADAPTER_CLASSES } from "./all-adapters.js";

/**
 * Universal provider contract suite.
 *
 * Every built-in adapter registered in `ALL_ADAPTER_CLASSES` is run through
 * the identical contract battery defined in `runProviderContract`. This is the
 * quality guarantee for the SDK: a provider is only "supported" if it upholds
 * the same retry / error / rate-limit / pagination semantics as every other.
 *
 * Run all:           npm run test:contracts
 * Run one provider:  npm run test:contracts -- -t stripe
 */
describe("Provider Contracts (all registered adapters)", () => {
  // Optional single-provider focus, e.g. `npm run test:contracts stripe`.
  const only = process.env.PROVIDER?.trim();

  let entries = Object.entries(ALL_ADAPTER_CLASSES).sort(([a], [b]) => a.localeCompare(b));

  if (only) {
    entries = entries.filter(([name]) => name === only);
    if (entries.length === 0) {
      const known = Object.keys(ALL_ADAPTER_CLASSES).sort().join(", ");
      throw new Error(`Unknown provider "${only}". Registered providers: ${known}`);
    }
  }

  for (const [name, AdapterClass] of entries) {
    runProviderContract(name, new AdapterClass());
  }
});
