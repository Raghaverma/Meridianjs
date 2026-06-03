import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOpenAPI } from "./openapi.js";
import { generateAdapter, generateIndex, generatePagination, generateTest } from "./templates.js";
import type { GeneratorContext } from "./templates.js";

export interface GeneratorOptions {
  provider: string;
  openapi?: string;
  baseUrl?: string;
  auth?: "apiKey" | "bearer" | "basic" | "oauth2";
  output?: string;
}

export async function generate(opts: GeneratorOptions): Promise<void> {
  const { provider } = opts;
  const outputDir = opts.output ?? join("src", "providers", provider);

  let ctx: GeneratorContext = {
    provider,
    baseUrl: opts.baseUrl ?? `https://api.${provider}.com`,
    authType: opts.auth ?? "apiKey",
    authKeyName: "apiKey",
    endpoints: [],
  };

  if (opts.openapi) {
    const raw = await readFile(opts.openapi, "utf-8");
    const spec = parseOpenAPI(JSON.parse(raw));
    ctx = {
      provider,
      baseUrl: opts.baseUrl ?? spec.baseUrl,
      authType: opts.auth ?? spec.authType,
      authKeyName: spec.authKeyName,
      endpoints: spec.endpoints,
    };
  }

  await mkdir(outputDir, { recursive: true });

  await Promise.all([
    writeFile(join(outputDir, "adapter.ts"), generateAdapter(ctx), "utf-8"),
    writeFile(join(outputDir, "adapter.test.ts"), generateTest(ctx), "utf-8"),
    writeFile(join(outputDir, "pagination.ts"), generatePagination(ctx), "utf-8"),
    writeFile(join(outputDir, "index.ts"), generateIndex(ctx), "utf-8"),
  ]);

  const lines = [
    `✓  Generated adapter for "${provider}" → ${outputDir}/`,
    "   adapter.ts       core adapter (auth, error mapping, rate-limit headers)",
    "   adapter.test.ts  8 tests that pass immediately",
    "   pagination.ts    pagination strategy stub",
    "   index.ts         barrel export",
    "",
    "Next steps:",
    `  1. Add "${provider}" to BUILTIN_ADAPTER_CLASSES in src/index.ts`,
    "  2. Fill in the TODO comments in adapter.ts and pagination.ts",
    `  3. npm test -- --reporter=verbose src/providers/${provider}/adapter.test.ts`,
  ];

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}
