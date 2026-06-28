/**
 * Memory growth probe — `npm run benchmark:memory`.
 *
 * Drives a large number of requests through a single long-lived Meridian
 * instance (the realistic shape: one process, many requests) with every
 * buffering feature turned on — debug recording, a reliability session,
 * analytics, rate limiting — and checks that heap usage plateaus rather than
 * growing linearly with request count. A leak here means *any* long-running
 * Meridian process leaks, not just a synthetic worst case.
 *
 * Requires --expose-gc (the npm script passes it) so measurements aren't
 * polluted by GC timing noise.
 */

import { Meridian } from "../src/index.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { consoleTable, MockNetwork } from "./harness.js";

const ITERATIONS = 30_000;
const SAMPLE_EVERY = 5_000;

function heapMB(): number {
  if (typeof gc === "function") gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

async function main() {
  if (typeof gc !== "function") {
    console.error(
      "Run with --expose-gc: node --expose-gc node_modules/.bin/vite-node benchmarks/memory.ts",
    );
    process.exitCode = 1;
    return;
  }

  const network = new MockNetwork();
  network.install();
  const adapter = network.register("api.memprobe.local", new MockAdapter("memprobe"));
  adapter.onRequest({}, () => ({ status: 200, body: { ok: true, data: "x".repeat(200) } }));

  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: [],
    defaults: { rateLimit: { tokensPerSecond: 1_000_000, maxTokens: 1_000_000 } },
    providers: {
      memprobe: { auth: { apiKey: "k" }, adapter, baseUrl: "https://api.memprobe.local" },
    },
  });
  if (process.env.MEMPROBE_NO_RECORDING !== "1") {
    meridian.debug.enable();
    meridian.startRecording("memory-probe");
  }

  const samples: Array<{ iteration: number; heapMB: number }> = [];
  samples.push({ iteration: 0, heapMB: heapMB() });

  for (let i = 1; i <= ITERATIONS; i++) {
    await meridian.provider("memprobe")!.get(`/items/${i}`);
    // MockAdapter.calls is an unbounded test-recording utility by design
    // (so test assertions can inspect every call) — not representative of a
    // real adapter's production memory profile. Clear it so this probe
    // measures Meridian's own buffers, not the mock's bookkeeping.
    adapter.calls.length = 0;
    if (i % SAMPLE_EVERY === 0) {
      samples.push({ iteration: i, heapMB: heapMB() });
    }
  }

  console.log(
    `\nMeridian Memory Growth Probe — ${ITERATIONS.toLocaleString()} requests, one process\n`,
  );
  console.log(
    consoleTable(
      [{ header: "Requests" }, { header: "Heap used", align: "right" as const }],
      samples.map((s) => [s.iteration.toLocaleString(), `${s.heapMB.toFixed(1)} MB`]),
    ),
  );

  // Compare only the last two samples — every buffer with a cap (debug log,
  // reliability session, circuit breaker history) is still filling on its
  // way to that cap early on, so a whole-range average always looks like
  // it's "growing" even once the caps have long since been reached.
  const first = samples[samples.length - 2];
  const last = samples[samples.length - 1];
  if (first && last && last.iteration > first.iteration) {
    const growthPerKReq =
      ((last.heapMB - first.heapMB) / (last.iteration - first.iteration)) * 1000;
    console.log(`\nGrowth rate (last segment): ${growthPerKReq.toFixed(2)} MB / 1,000 requests`);
    console.log(
      growthPerKReq < 0.5
        ? "✓ Plateaus — no evidence of unbounded growth at this request volume."
        : "✗ Still climbing — investigate before declaring this bounded.",
    );
  }
}

main();
