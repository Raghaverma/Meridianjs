#!/usr/bin/env node
// Runs the universal provider contract suite against every registered adapter,
// or a single provider when one is named.
//
//   npm run test:contracts            # all registered adapters
//   npm run test:contracts stripe     # just stripe
//
// Implemented as plain ESM so it needs no extra dev dependency (no ts-node/tsx).
import { spawnSync } from "node:child_process";

const provider = process.argv[2]?.trim();

if (provider) {
  console.log(`Running provider contract for: ${provider}\n`);
} else {
  console.log("Running provider contract for all registered adapters...\n");
}

const result = spawnSync("node_modules/.bin/vitest", ["run", "src/providers/contract.test.ts"], {
  env: { ...process.env, PROVIDER: provider ?? "" },
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
