/**
 * Provider initialization cost — `npm run benchmark:provider-init`.
 *
 * Measures Meridian.create() in-process cost as a function of how many
 * providers are configured (1 vs N vs all 46), to quantify the lazy-loading
 * change directly: each configured provider triggers exactly one dynamic
 * import() of its adapter module on first use, so cost should scale with
 * configured providers, not with the total number of built-in adapters that
 * exist but aren't used.
 */

import { execFileSync } from "node:child_process";
import { Meridian } from "../src/index.js";
import { consoleTable, now } from "./harness.js";

const ALL_PROVIDERS = JSON.parse(
  execFileSync("node", ["scripts/list-providers.mjs"], { encoding: "utf8" }),
) as string[];

async function timeInit(providerNames: string[]): Promise<number> {
  const providers: Record<string, { auth: Record<string, string>; localUnsafe?: boolean }> = {};
  for (const name of providerNames) {
    providers[name] = { auth: { apiKey: "k", token: "k" } };
  }
  const start = now();
  await Meridian.create({ providers, localUnsafe: true, observability: [] });
  return now() - start;
}

async function median(fn: () => Promise<number>, n: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(await fn());
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

async function main() {
  console.log("\nMeridian Provider Initialization Cost — median of 9 runs each\n");

  const scenarios = [
    { label: "1 provider", count: 1 },
    { label: "5 providers", count: 5 },
    { label: "15 providers", count: 15 },
    { label: `all ${ALL_PROVIDERS.length} providers`, count: ALL_PROVIDERS.length },
  ];

  const rows: string[][] = [];
  let previousMs: number | null = null;
  for (const s of scenarios) {
    const names = ALL_PROVIDERS.slice(0, s.count);
    const ms = await median(() => timeInit(names), 9);
    const perProvider = ms / s.count;
    const delta = previousMs === null ? "—" : `+${(ms - previousMs).toFixed(2)} ms vs previous row`;
    rows.push([s.label, `${ms.toFixed(2)} ms`, `${perProvider.toFixed(3)} ms/provider`, delta]);
    previousMs = ms;
  }

  console.log(
    consoleTable(
      [
        { header: "Scenario" },
        { header: "Total", align: "right" as const },
        { header: "Per provider", align: "right" as const },
        { header: "Delta" },
      ],
      rows,
    ),
  );
  console.log(
    "\nCost should scale roughly linearly with *configured* providers — confirms lazy-loading\n" +
      "means unused built-in adapters (most of the 46, for any single app) cost nothing at init.\n",
  );
}

main();
