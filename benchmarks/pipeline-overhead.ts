/**
 * Meridian Pipeline Overhead Benchmark
 *
 * Measures the overhead introduced by the Meridian pipeline relative to a
 * raw in-process call, using a MockAdapter to eliminate network variance.
 *
 * Run: vite-node benchmarks/pipeline-overhead.ts
 */

import { Meridian } from "../src/index.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";

const ITERATIONS = 10_000;

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

async function bench(label: string, fn: () => Promise<void>, n: number): Promise<void> {
  // Warm up
  for (let i = 0; i < Math.min(n / 10, 100); i++) await fn();

  const start = hrMs();
  for (let i = 0; i < n; i++) await fn();
  const elapsed = hrMs() - start;

  const opsPerSec = Math.round((n / elapsed) * 1000);
  const usPerOp = ((elapsed / n) * 1000).toFixed(1);
  console.log(
    `  ${label.padEnd(40)} ${opsPerSec.toLocaleString().padStart(10)} ops/s   ${usPerOp} µs/op`,
  );
}

async function main() {
  console.log(
    `\nMeridian Pipeline Overhead Benchmark  (${ITERATIONS.toLocaleString()} iterations each)\n`,
  );

  const adapter = new MockAdapter();
  adapter.mockGet("/test", 200, { id: 1, name: "test" });

  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: { mock: { auth: {}, adapter } },
  });

  const client = meridian.provider("mock")!;

  console.log("Baseline:");
  await bench(
    "raw MockAdapter.parseResponse()",
    async () => {
      adapter.parseResponse({ status: 200, headers: new Headers(), body: { id: 1 } });
    },
    ITERATIONS,
  );

  console.log("\nMeridian pipeline (all features active):");
  await bench(
    "provider.get()  — no retry, no policy",
    async () => {
      await client.get("/test");
    },
    ITERATIONS,
  );

  // Add a policy
  const meridianWithPolicy = await Meridian.create({
    localUnsafe: true,
    providers: { mock: { auth: {}, adapter } },
    policies: [{ name: "allow-all", evaluate: () => ({ allow: true }) }],
  });
  const clientWithPolicy = meridianWithPolicy.provider("mock")!;

  await bench(
    "provider.get()  — 1 policy (allow-all)",
    async () => {
      await clientWithPolicy.get("/test");
    },
    ITERATIONS,
  );

  // Service client
  const meridianService = await Meridian.create({
    localUnsafe: true,
    providers: { mock: { auth: {}, adapter } },
    services: { svc: { providers: ["mock"], strategy: "failover" } },
  });
  const svc = meridianService.service("svc")!;

  await bench(
    "service.get()   — failover, 1 provider",
    async () => {
      await svc.get("/test");
    },
    ITERATIONS,
  );

  console.log("\nAnalytics collection overhead (always-on):");
  let count = 0;
  const startAnalytics = hrMs();
  for (let i = 0; i < ITERATIONS; i++) {
    await client.get("/test");
    count++;
  }
  const analyticsElapsed = hrMs() - startAnalytics;
  const stats = meridian.analytics().mock;
  console.log(
    `  ${ITERATIONS.toLocaleString()} requests tracked in ${analyticsElapsed.toFixed(0)}ms`,
  );
  console.log(
    `  Analytics collector has ${count} samples, avg latency ${stats?.avgLatency ?? 0}ms`,
  );

  console.log("\nDone.\n");
}

main().catch(console.error);
