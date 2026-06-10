/**
 * demo:circuit-breaker
 *
 * Scenario: a payments provider starts failing every request (a degraded
 * upstream, ~25ms RTT). Without a circuit breaker, every request eats that
 * 25ms before failing. Meridian's circuit breaker opens after a threshold of
 * failures and fails fast — no wasted round-trip — until the provider
 * recovers.
 *
 * Run: npm run demo:circuit-breaker
 */

import { MockNetwork } from "../benchmarks/harness.js";
import { CircuitState, MeridianError } from "../src/core/types.js";
import { Meridian } from "../src/index.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { banner, color, NarrativeObservability, section, sleep } from "./_shared.js";

const UPSTREAM_RTT_MS = 25;
const THRESHOLD = 5;

async function main() {
  const net = new MockNetwork();
  net.install();

  const razorpay = net
    .register("razorpay-demo.mock", new MockAdapter("razorpay"))
    .onRequest({}, () => {
      throw new MeridianError(
        "upstream returned 500",
        "provider",
        "razorpay",
        false,
        "",
        undefined,
        undefined,
        500,
      );
    })
    .simulateDelay(UPSTREAM_RTT_MS);

  banner("Meridian Circuit Breaker Demo");
  console.log(`Provider status:`);
  console.log(
    `  razorpay   ${color.red("● DEGRADED")}  (every request returns 500, ~${UPSTREAM_RTT_MS}ms RTT)`,
  );
  console.log(
    `\nCircuit breaker config: opens after ${THRESHOLD} failures (volumeThreshold ${THRESHOLD})`,
  );

  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: new NarrativeObservability(),
    providers: {
      razorpay: {
        auth: {},
        adapter: razorpay,
        retry: { maxRetries: 0 },
        circuitBreaker: {
          failureThreshold: THRESHOLD,
          volumeThreshold: THRESHOLD,
          successThreshold: 2,
          timeout: 30_000,
          rollingWindowMs: 60_000,
          errorThresholdPercentage: 50,
        },
      },
    },
  });

  const client = meridian.provider("razorpay")!;

  section('Sending requests through provider("razorpay")');
  await sleep(150);

  for (let i = 1; i <= THRESHOLD; i++) {
    await client.post("/v1/payments", { body: { amount: 2000 } }).catch(() => {});
    const status = meridian.getCircuitStatus("razorpay");
    if (status?.state === CircuitState.OPEN) {
      console.log(
        `\n  ${color.yellow("⚠")} Circuit breaker ${color.bold("OPEN")} — razorpay marked unhealthy after ${i} failures`,
      );
      break;
    }
  }

  section("Sending one more request — circuit is OPEN");
  const blocked = await timed(() => client.post("/v1/payments", { body: { amount: 2000 } }));

  const status = meridian.getCircuitStatus("razorpay")!;
  section("Result");
  console.log(`  Circuit state      : ${color.bold(status.state)}`);
  console.log(`  Failures to open   : ${THRESHOLD}`);
  console.log(`  Upstream RTT       : ${UPSTREAM_RTT_MS}ms (simulated)`);
  console.log(
    `  Fail-fast latency  : ${color.bold(`${blocked.ms.toFixed(2)}ms`)} (no network call)`,
  );
  console.log(
    `\n${color.green("✓")} Once OPEN, Meridian stops calling the dead provider — saving ~${UPSTREAM_RTT_MS}ms per request until it recovers.\n`,
  );

  net.restore();
}

async function timed(fn: () => Promise<unknown>): Promise<{ ms: number }> {
  const start = performance.now();
  await fn().catch(() => {});
  return { ms: performance.now() - start };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
