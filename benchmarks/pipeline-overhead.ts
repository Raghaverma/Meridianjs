/**
 * Meridian Pipeline Overhead Benchmark
 *
 * Measures the per-call overhead the Meridian pipeline adds over a raw
 * in-process call, using a MockAdapter to eliminate network variance. Each
 * configuration layers on one feature (policy evaluation, service routing) so
 * the marginal cost of each is visible.
 *
 * Run: npx vite-node benchmarks/pipeline-overhead.ts
 */

import { Meridian } from "../src/index.js";
import { NoOpObservability } from "../src/infrastructure/observability/noop.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { MockNetwork, now } from "./harness.js";

const ITERATIONS = 10_000;

// localUnsafe disables the encrypted-state requirement; NoOp suppresses the
// default Console observability (which would flood the benchmark with logs);
// the giant token bucket disables the default 10 req/s rate limiter so we
// measure pipeline overhead, not the throttle.
const SILENT = {
  localUnsafe: true,
  observability: new NoOpObservability(),
  defaults: { rateLimit: { tokensPerSecond: 1e9, maxTokens: 1e9 } },
} as const;

export interface OverheadSample {
  label: string;
  opsPerSec: number;
  usPerOp: number;
}

async function measure(label: string, fn: () => Promise<void>, n: number): Promise<OverheadSample> {
  const start = now();
  for (let i = 0; i < n; i++) await fn();
  const elapsed = now() - start;
  return {
    label,
    opsPerSec: Math.round((n / elapsed) * 1000),
    usPerOp: Number(((elapsed / n) * 1000).toFixed(1)),
  };
}

export async function runOverhead(): Promise<OverheadSample[]> {
  const net = new MockNetwork();
  net.install();
  try {
    // Each config gets its own fresh adapter registered under a distinct host.
    // Sharing one adapter means the `calls` array accumulates across configs and
    // GC pressure during the warmup of config-1 then fires during the measure of
    // config-2, making the timing non-monotonic.
    const makeAdapter = (host: string) => {
      const a = new MockAdapter("mock");
      net.register(host, a);
      a.onRequest({ method: "GET", endpoint: "/test" }, () => ({
        status: 200,
        body: { id: 1, name: "test" },
      }));
      return a;
    };

    const base = await Meridian.create({
      ...SILENT,
      providers: { mock: { auth: {}, adapter: makeAdapter("base.mock") } },
    });
    const client = base.provider("mock")!;

    const withPolicy = await Meridian.create({
      ...SILENT,
      providers: { mock: { auth: {}, adapter: makeAdapter("policy.mock") } },
      policies: [{ name: "allow-all", evaluate: () => ({ allow: true }) }],
    });
    const policyClient = withPolicy.provider("mock")!;

    const withService = await Meridian.create({
      ...SILENT,
      providers: { mock: { auth: {}, adapter: makeAdapter("svc.mock") } },
      services: { svc: { providers: ["mock"], strategy: "failover" } },
    });
    const svc = withService.service("svc")!;

    const configs: Array<{ label: string; fn: () => Promise<void> }> = [
      {
        label: "provider.get() — no retry, no policy",
        fn: async () => void (await client.get("/test")),
      },
      {
        label: "provider.get() — 1 policy (allow-all)",
        fn: async () => void (await policyClient.get("/test")),
      },
      {
        label: "service.get() — failover, 1 provider",
        fn: async () => void (await svc.get("/test")),
      },
    ];

    // Warm up EVERY path before measuring ANY, so each is equally optimized by
    // V8 — otherwise the first config measured absorbs the tier-up cost and
    // appears (misleadingly) slowest.
    for (let round = 0; round < 4000; round++) {
      for (const c of configs) await c.fn();
    }

    // Measure each config several times round-robin and keep the fastest run.
    // The min is the most stable estimator of true cost — it filters out GC
    // pauses and scheduler noise that would otherwise penalise whichever config
    // happens to be measured while a collection runs.
    const best = new Map<string, OverheadSample>();
    for (let rep = 0; rep < configs.length + 1; rep++) {
      // Rotate the order each rep so no single config is always measured first
      // (the first measurement of a rep tends to absorb a GC pause).
      const order = configs.map((_, i) => configs[(i + rep) % configs.length]!);
      for (const c of order) {
        const s = await measure(c.label, c.fn, ITERATIONS);
        const prev = best.get(c.label);
        if (!prev || s.usPerOp < prev.usPerOp) best.set(c.label, s);
      }
    }
    return configs.map((c) => best.get(c.label)!);
  } finally {
    net.restore();
  }
}

// Self-execute when run directly, but stay silent when imported by the suite
// (index.ts), which sets MERIDIAN_BENCH_SUITE. vite-node doesn't expose the
// entry filename via argv, so an env flag is the only reliable signal.
if (!process.env.MERIDIAN_BENCH_SUITE) {
  runOverhead()
    .then((samples) => {
      console.log(
        `\nMeridian Pipeline Overhead  (${ITERATIONS.toLocaleString()} iterations each)\n`,
      );
      for (const s of samples) {
        console.log(
          `  ${s.label.padEnd(40)} ${s.opsPerSec.toLocaleString().padStart(10)} ops/s   ${s.usPerOp} µs/op`,
        );
      }
      console.log();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
