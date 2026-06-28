/**
 * demo:service-routing
 *
 * Scenario: your app calls service("llm") with strategy "lowest-latency".
 * Meridian doesn't know in advance which provider is faster — it measures
 * real response latency on every call and routes future requests to
 * whichever provider has been fastest, without any code change.
 *
 * Run: npm run demo:service-routing
 */

import { MockNetwork } from "../benchmarks/harness.js";
import { Meridian } from "../src/index.js";
import { NoOpObservability } from "../src/infrastructure/observability/noop.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { banner, color, section, sleep } from "./_shared.js";

const REQUESTS = 6;

async function main() {
  const net = new MockNetwork();
  net.install();

  const openai = net
    .register("openai-demo.mock", new MockAdapter("openai"))
    .onRequest({}, () => ({ status: 200, body: { from: "openai" } }))
    .simulateDelay(80);

  const gemini = net
    .register("gemini-demo.mock", new MockAdapter("gemini"))
    .onRequest({}, () => ({ status: 200, body: { from: "gemini" } }))
    .simulateDelay(8);

  banner("Meridian Service Routing Demo");
  console.log('Scenario: service("llm") with strategy "lowest-latency" — two healthy');
  console.log(
    "providers, but one responds ~10x faster. Meridian measures actual\n" +
      "latency per call and routes future requests to the faster one.\n",
  );
  console.log("Provider status:");
  console.log(`  openai   ${color.green("● ACTIVE")}  (~80ms response time)`);
  console.log(`  gemini   ${color.green("● ACTIVE")}  (~8ms response time)`);

  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: new NoOpObservability(),
    defaults: { rateLimit: { tokensPerSecond: 1e9, maxTokens: 1e9 } },
    providers: {
      openai: {
        auth: {},
        adapter: openai,
        circuitBreaker: { failureThreshold: 1_000_000, volumeThreshold: 1_000_000 },
      },
      gemini: {
        auth: {},
        adapter: gemini,
        circuitBreaker: { failureThreshold: 1_000_000, volumeThreshold: 1_000_000 },
      },
    },
    services: {
      llm: { providers: ["openai", "gemini"], strategy: "lowest-latency" },
    },
  });

  section('Sending 6 requests via service("llm").get("/v1/models")');
  await sleep(150);

  const counts: Record<string, number> = { openai: 0, gemini: 0 };
  for (let i = 1; i <= REQUESTS; i++) {
    const { meta } = await meridian.service("llm")!.get<{ from: string }>("/v1/models");
    counts[meta.provider] = (counts[meta.provider] ?? 0) + 1;
    const latency = meta.trace?.latency?.toFixed(0) ?? "?";
    console.log(`  request ${i}  →  ${color.cyan(meta.provider.padEnd(7))}  ${latency}ms`);
    await sleep(80);
  }

  section("Result");
  console.log(`  openai served : ${counts.openai ?? 0} / ${REQUESTS} requests`);
  console.log(`  gemini served : ${counts.gemini ?? 0} / ${REQUESTS} requests`);
  console.log(
    `\n${color.green("✓")} After a brief warm-up, Meridian converges on ${color.bold("gemini")} — the\n` +
      `  consistently faster provider — with no routing code in your application.\n`,
  );

  net.restore();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
