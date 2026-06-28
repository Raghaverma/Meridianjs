/**
 * Startup benchmark — cold-process measurements for `npm run benchmark:startup`.
 *
 * Library import and CLI dispatch are measured in fresh `node` subprocesses
 * (not in-process timing), since module caching would otherwise hide the
 * real cold-start cost a consumer pays exactly once per process.
 *
 * Targets from the engineering roadmap: CLI startup <100ms, library import <50ms.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { consoleTable, markdownTable, now } from "./harness.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

async function timeSubprocess(command: string, args: string[]): Promise<number> {
  const start = now();
  await run(command, args, { cwd: ROOT });
  return now() - start;
}

async function median(samples: () => Promise<number>, n: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(await samples());
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

interface Result {
  label: string;
  ms: number;
  targetMs: number;
}

export async function runStartup(): Promise<Result[]> {
  const ITER = 11;

  const libraryImport = await median(
    () => timeSubprocess("node", ["--input-type=module", "-e", 'await import("./dist/public.js")']),
    ITER,
  );

  const cliHelp = await median(() => timeSubprocess("node", ["dist/cli/main.js", "--help"]), ITER);

  const bareNode = await median(
    () => timeSubprocess("node", ["--input-type=module", "-e", "0"]),
    ITER,
  );

  return [
    { label: "bare `node -e 0` (process floor)", ms: bareNode, targetMs: Number.NaN },
    { label: "library import (dist/public.js)", ms: libraryImport, targetMs: 50 },
    { label: "CLI startup (--help)", ms: cliHelp, targetMs: 100 },
  ];
}

async function main() {
  console.log("\nMeridian Startup Benchmark — cold subprocess, median of 11 runs\n");
  const results = await runStartup();

  const floor = results[0]!.ms;
  const rows = results.map((r) => [
    r.label,
    `${r.ms.toFixed(1)} ms`,
    Number.isNaN(r.targetMs) ? "—" : `${r.targetMs} ms`,
    Number.isNaN(r.targetMs) ? "—" : r.ms - floor <= r.targetMs ? "✓ pass" : "✗ over",
  ]);
  const columns = [
    { header: "Measurement" },
    { header: "Median", align: "right" as const },
    { header: "Target", align: "right" as const },
    { header: "Status" },
  ];

  console.log(consoleTable(columns, rows));
  console.log(
    `\nNote: target is on TOP of the process floor (~${results[0]!.ms.toFixed(1)}ms node startup), not absolute.\n`,
  );

  if (process.env.MERIDIAN_BENCH_WRITE_MD) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(ROOT, "benchmarks", "STARTUP.md"),
      `# Startup Benchmark\n\n${markdownTable(columns, rows)}\n`,
    );
  }
}

main();
