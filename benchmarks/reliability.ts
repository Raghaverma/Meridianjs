/**
 * Meridian Reliability Benchmark
 *
 * Buyers don't care that there are N adapters — they care whether Meridian
 * survives failure. This benchmark *proves* the reliability claims by driving
 * the real pipeline through each failure mode and asserting the outcome:
 *
 *   1. Throughput      — N requests flow through and are tracked by analytics,
 *                        and what the pipeline costs over a bare fetch
 *   2. Failover        — primary outage (OpenAI) is routed around (Anthropic)
 *   3. Retry recovery  — a transient 429 (Stripe) is retried into a success
 *   4. Circuit breaker — repeated failures trip the breaker, protecting upstream
 *   5. Schema drift    — a removed field is detected before it ships
 *
 * Everything runs in-process against deterministic MockAdapters (see
 * ./harness.ts), so results are reproducible and isolated from network
 * variance. Because in-process mocks have ~0 latency, scenarios where *time* is
 * the headline (failover recovery, circuit-breaker fail-fast) model a realistic
 * upstream round-trip via UPSTREAM_RTT_MS; pure-mechanism scenarios (throughput,
 * retry) add no artificial delay. Each check is an assertion — the runner exits
 * non-zero if any claim fails, so this doubles as a CI gate.
 *
 * Run: npx vite-node benchmarks/reliability.ts   (or `npm run benchmark` for the full suite)
 */

import { CircuitState, MeridianError, type SchemaDrift } from "../src/core/types.js";
import { Meridian } from "../src/index.js";
import { NoOpObservability } from "../src/infrastructure/observability/noop.js";
import { InMemorySchemaStorage } from "../src/infrastructure/validation/schema-storage.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { MockNetwork, now, timed } from "./harness.js";

// NoOp suppresses the default Console observability; the giant token bucket
// disables the default 10 req/s rate limiter so timing reflects the pipeline,
// not the throttle. (Analytics is collected regardless of the observability set.)
const SILENT = {
  localUnsafe: true,
  observability: new NoOpObservability(),
  defaults: { rateLimit: { tokensPerSecond: 1e9, maxTokens: 1e9 } },
} as const;
const NO_BREAKER = { failureThreshold: 1_000_000, volumeThreshold: 1_000_000 };
const NO_RETRY = { maxRetries: 0 };
const FAST_RETRY = { maxRetries: 4, baseDelay: 2, maxDelay: 8, jitter: false };
// Stand-in for a real upstream round-trip; in-process mocks are otherwise ~0ms.
const UPSTREAM_RTT_MS = 25;

// The adapter validator requires an adapter's providerName to equal the config
// key it is registered under, so `name` is used as BOTH the provider name and
// the config key. The routing host (baseUrl) is kept unique so many adapters
// can coexist on one shared MockNetwork.
let hostSeq = 0;
function register(net: MockNetwork, name: string): MockAdapter {
  const adapter = new MockAdapter(name);
  net.register(`${name}-${hostSeq++}.mock`, adapter);
  return adapter;
}

/** Adapter that always returns 200. */
function healthy(net: MockNetwork, name: string): MockAdapter {
  return register(net, name).onRequest({}, () => ({ status: 200, body: { ok: true, from: name } }));
}

/** Adapter that always throws a non-retryable provider error (a hard outage). */
function down(net: MockNetwork, name: string): MockAdapter {
  return register(net, name).onRequest({}, () => {
    throw new MeridianError(`${name} is down`, "provider", name, false);
  });
}

/** Adapter that throws `failTimes` retryable errors of `category`, then succeeds. */
function flaky(
  net: MockNetwork,
  name: string,
  failTimes: number,
  category: MeridianError["category"],
): MockAdapter {
  const adapter = register(net, name);
  let seen = 0;
  return adapter.onRequest({}, () => {
    if (seen++ < failTimes) {
      throw new MeridianError(`${name} transient ${category}`, category, name, true);
    }
    return { status: 200, body: { ok: true, attempt: seen } };
  });
}

// ── 1. Throughput + latency overhead ─────────────────────────────────────────

async function measureThroughput(net: MockNetwork) {
  const requests = 10_000;
  const adapter = healthy(net, "throughput");
  const host = adapter.baseUrl!;
  const meridian = await Meridian.create({
    ...SILENT,
    providers: { throughput: { auth: {}, adapter, circuitBreaker: NO_BREAKER } },
  });
  const client = meridian.provider("throughput")!;

  // Raw baseline: a bare fetch + JSON parse — the work a vendor SDK does.
  const rawCall = async () => {
    const r = await fetch(`${host}/x`);
    await r.json();
  };
  for (let i = 0; i < 500; i++) {
    await rawCall();
    await client.get("/x");
  }

  let t = now();
  for (let i = 0; i < requests; i++) await rawCall();
  const rawMs = (now() - t) / requests;

  const before = meridian.analytics().throughput?.requests ?? 0;
  t = now();
  for (let i = 0; i < requests; i++) await client.get("/x");
  const elapsedMs = now() - t;
  const tracked = (meridian.analytics().throughput?.requests ?? 0) - before;
  const meridianMs = elapsedMs / requests;

  return {
    requests,
    tracked,
    elapsedMs,
    iterations: requests,
    rawMs,
    meridianMs,
    addedMs: meridianMs - rawMs,
  };
}

// ── 2. Failover (OpenAI outage → Anthropic) ─────────────────────────────────

async function measureFailover(net: MockNetwork) {
  const openai = down(net, "openai");
  const anthropic = healthy(net, "anthropic");

  const meridian = await Meridian.create({
    ...SILENT,
    providers: {
      openai: { auth: {}, adapter: openai, retry: NO_RETRY, circuitBreaker: NO_BREAKER },
      anthropic: { auth: {}, adapter: anthropic, retry: NO_RETRY, circuitBreaker: NO_BREAKER },
    },
    services: { chat: { providers: ["openai", "anthropic"], strategy: "failover" } },
  });
  const svc = meridian.service("chat")!;
  for (let i = 0; i < 200; i++) await svc.get("/v1/chat"); // warm up (no delay yet)

  // Routing overhead: how much Meridian adds to route around the dead primary.
  const N = 2_000;
  let recovered = 0;
  const t = now();
  for (let i = 0; i < N; i++) {
    const res = await svc.get<{ from: string }>("/v1/chat");
    if (res.data.from === "anthropic") recovered++;
  }
  const routingOverheadMs = (now() - t) / N;

  // Recovery time as a user experiences it: the fallback is a real network call,
  // so model its round-trip. (The dead primary fails fast — connection refused.)
  anthropic.simulateDelay(UPSTREAM_RTT_MS);
  const recovery = await timed(() => svc.get<{ from: string }>("/v1/chat"));

  // Raw baseline: the dead primary alone, no failover — a direct vendor call.
  const rawMeridian = await Meridian.create({
    ...SILENT,
    providers: { openai: { auth: {}, adapter: openai, circuitBreaker: NO_BREAKER } },
  });
  const raw = await timed(() => rawMeridian.provider("openai")!.get("/v1/chat"));

  return {
    iterations: N,
    routingOverheadMs,
    recoveryMs: recovery.ms,
    recoveredAll: recovered === N && recovery.ok && recovery.value?.data.from === "anthropic",
    rawRecovers: raw.ok,
  };
}

// ── 3. Retry recovery (Stripe 429) ──────────────────────────────────────────

async function measureRetry(net: MockNetwork) {
  // A single Stripe 429 then 200: the raw SDK gives up, Meridian retries.
  const buildStripe = async (retry: object) => {
    const adapter = flaky(net, "stripe", 1, "rate_limit");
    const m = await Meridian.create({
      ...SILENT,
      providers: { stripe: { auth: {}, adapter, retry, circuitBreaker: NO_BREAKER } },
    });
    return m.provider("stripe")!;
  };
  const raw = await timed(() => buildStripe(NO_RETRY).then((c) => c.get("/v1/charges")));
  const reliable = await timed(() => buildStripe(FAST_RETRY).then((c) => c.get("/v1/charges")));

  return {
    maxRetries: FAST_RETRY.maxRetries,
    rawSucceeded: raw.ok,
    reliableSucceeded: reliable.ok,
  };
}

// ── 4. Circuit breaker ──────────────────────────────────────────────────────

async function measureCircuitBreaker(net: MockNetwork) {
  const threshold = 5;
  const adapter = down(net, "flapping").simulateDelay(UPSTREAM_RTT_MS); // each call costs a round-trip

  const meridian = await Meridian.create({
    ...SILENT,
    providers: {
      flapping: {
        auth: {},
        adapter,
        retry: NO_RETRY,
        circuitBreaker: {
          failureThreshold: threshold,
          volumeThreshold: threshold,
          successThreshold: 2,
          timeout: 30_000,
          rollingWindowMs: 60_000,
          errorThresholdPercentage: 50,
        },
      },
    },
  });
  const client = meridian.provider("flapping")!;

  const tStart = now();
  let failuresToOpen = 0;
  for (let i = 1; i <= 50; i++) {
    await timed(() => client.get("/x"));
    failuresToOpen = i;
    if (meridian.getCircuitStatus("flapping")?.state === CircuitState.OPEN) break;
  }
  const msToOpen = now() - tStart;

  // Once OPEN the breaker fails fast — no (delayed) upstream call.
  const blocked = await timed(() => client.get("/x"));
  const isOpen = meridian.getCircuitStatus("flapping")?.state === CircuitState.OPEN;

  return {
    threshold,
    failuresToOpen,
    msToOpen,
    isOpen,
    blockedFailedFast: !blocked.ok,
    failFastMs: blocked.ms,
    upstreamRttMs: UPSTREAM_RTT_MS,
  };
}

// ── 5. Schema drift ─────────────────────────────────────────────────────────

async function measureSchemaDrift(net: MockNetwork) {
  // A live provider keeps create() happy; drift detection itself is independent.
  const meridian = await Meridian.create({
    ...SILENT,
    schemaValidation: { enabled: true, storage: new InMemorySchemaStorage() },
    providers: {
      billing: { auth: {}, adapter: healthy(net, "billing"), circuitBreaker: NO_BREAKER },
    },
  });

  const provider = "stripe";
  const endpoint = "/v1/customers/cus_123";

  // Baseline captured from a known-good response.
  await meridian.schema.snapshot(provider, endpoint, {
    id: "cus_123",
    customer_name: "Acme",
    amount: 4200,
  });

  // Next deploy: upstream dropped `customer_name`.
  let alerted: SchemaDrift[] = [];
  const drifts = await meridian.schema.alert(
    provider,
    endpoint,
    { id: "cus_123", amount: 4200 },
    (d) => {
      alerted = d;
    },
  );

  const removed = drifts.find((d) => d.type === "FIELD_REMOVED" && d.field === "customer_name");
  return {
    detected: drifts.length > 0 && alerted.length > 0,
    field: removed?.field,
    severity: removed?.severity,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface ReliabilityResults {
  throughput: Awaited<ReturnType<typeof measureThroughput>>;
  failover: Awaited<ReturnType<typeof measureFailover>>;
  retry: Awaited<ReturnType<typeof measureRetry>>;
  circuitBreaker: Awaited<ReturnType<typeof measureCircuitBreaker>>;
  schemaDrift: Awaited<ReturnType<typeof measureSchemaDrift>>;
}

export async function runReliability(): Promise<ReliabilityResults> {
  const net = new MockNetwork();
  net.install();
  try {
    const throughput = await measureThroughput(net);
    const failover = await measureFailover(net);
    const retry = await measureRetry(net);
    const circuitBreaker = await measureCircuitBreaker(net);
    const schemaDrift = await measureSchemaDrift(net);
    return { throughput, failover, retry, circuitBreaker, schemaDrift };
  } finally {
    net.restore();
  }
}

export interface Check {
  ok: boolean;
  text: string;
}

/** Turn measured results into the pass/fail claims shown to buyers. */
export function checklist(r: ReliabilityResults): Check[] {
  return [
    {
      ok: r.throughput.tracked === r.throughput.requests,
      text: `${r.throughput.requests.toLocaleString()} requests tracked in ${(r.throughput.elapsedMs / 1000).toFixed(3)}s`,
    },
    {
      ok: r.failover.recoveredAll && !r.failover.rawRecovers,
      text: `OpenAI outage recovered via failover in ${r.failover.recoveryMs.toFixed(0)}ms`,
    },
    {
      ok: r.retry.reliableSucceeded && !r.retry.rawSucceeded,
      text: "Stripe 429 automatically retried",
    },
    {
      ok:
        r.circuitBreaker.isOpen &&
        r.circuitBreaker.failuresToOpen === r.circuitBreaker.threshold &&
        r.circuitBreaker.blockedFailedFast,
      text: `Circuit breaker opened after ${r.circuitBreaker.failuresToOpen} failures`,
    },
    {
      ok: r.schemaDrift.detected && r.schemaDrift.severity === "ERROR",
      text: "Schema drift detected before deployment",
    },
  ];
}

// Self-execute when run directly, but stay silent when imported by the suite
// (index.ts), which sets MERIDIAN_BENCH_SUITE. vite-node doesn't expose the
// entry filename via argv, so an env flag is the only reliable signal.
if (!process.env.MERIDIAN_BENCH_SUITE) {
  runReliability()
    .then((r) => {
      const checks = checklist(r);
      console.log("\nReliability Benchmarks\n");
      for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.text}`);
      console.log(
        `\n  (in-process against deterministic mocks; upstream RTT modeled at ${UPSTREAM_RTT_MS}ms)\n`,
      );
      if (checks.some((c) => !c.ok)) process.exit(1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
