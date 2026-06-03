#!/usr/bin/env node

/**
 * Meridian Generator CLI
 *
 * Usage:
 *   npx meridian generate --provider <name> [options]
 *
 * Options:
 *   --provider <name>     Provider name, e.g. "myapi"  (required)
 *   --openapi  <path>     Path to an OpenAPI 3.x JSON spec
 *   --base-url <url>      Base URL override
 *   --auth     <type>     Auth type: apiKey | bearer | basic | oauth2
 *   --output   <dir>      Output directory (default: src/providers/<name>)
 *
 * Examples:
 *   npx meridian generate --provider acme --base-url https://api.acme.com
 *   npx meridian generate --provider acme --openapi ./acme-openapi.json
 */

import { generate } from "./index.js";
import type { GeneratorOptions } from "./index.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--") && i + 1 < argv.length) {
      const key = arg.slice(2);
      out[key] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

const args = process.argv.slice(2);

if (args[0] !== "generate" && args[0] !== "gen") {
  process.stderr.write(
    "Usage: meridian generate --provider <name> [--openapi <path>] [--base-url <url>] [--auth <type>]\n",
  );
  process.exit(1);
}

const flags = parseArgs(args.slice(1));

if (!flags.provider) {
  process.stderr.write("Error: --provider is required\n");
  process.stderr.write(
    "Example: meridian generate --provider myapi --base-url https://api.myapi.com\n",
  );
  process.exit(1);
}

const opts: GeneratorOptions = { provider: flags.provider };
if (flags.openapi !== undefined) opts.openapi = flags.openapi;
if (flags["base-url"] !== undefined) opts.baseUrl = flags["base-url"];
if (flags.auth !== undefined) opts.auth = flags.auth as "apiKey" | "bearer" | "basic" | "oauth2";
if (flags.output !== undefined) opts.output = flags.output;

generate(opts).catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
