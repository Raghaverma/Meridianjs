#!/usr/bin/env node
// Emits the canonical provider list as a single-line JSON array, derived from
// the BUILTIN_ADAPTER_CLASSES registry in src/index.ts.
//
// CI uses this to build the contract-test matrix dynamically, so the matrix can
// never drift from the registry — add an adapter to the registry and it is
// automatically contract-tested on every PR, nightly run, and release.
//
//   node scripts/list-providers.mjs            # ["github","stripe",...]
//   node scripts/list-providers.mjs --pretty   # one provider per line
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "index.ts"), "utf8");

const block = src.match(/BUILTIN_ADAPTER_CLASSES[^{]*\{([\s\S]*?)\}/);
if (!block) {
  console.error("Could not locate BUILTIN_ADAPTER_CLASSES in src/index.ts");
  process.exit(1);
}

const providers = [...block[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]);
if (providers.length === 0) {
  console.error("Parsed BUILTIN_ADAPTER_CLASSES but found no providers");
  process.exit(1);
}

if (process.argv.includes("--pretty")) {
  console.log(providers.join("\n"));
} else {
  process.stdout.write(JSON.stringify(providers));
}
