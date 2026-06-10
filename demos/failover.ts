/**
 * demo:failover
 *
 * Scenario: OpenAI is down. Your application calls service("llm") — it never
 * calls "openai" or "anthropic" directly. Meridian detects the failure and
 * routes the request to Anthropic instead, in the same call.
 *
 * Run: npm run demo:failover
 */

import { MockNetwork } from "../benchmarks/harness.js";
import { MeridianError } from "../src/core/types.js";
import { Meridian } from "../src/index.js";
import { MockAdapter } from "../src/testing/mock-adapter.js";
import { banner, color, NarrativeObservability, section, sleep } from "./_shared.js";

const NO_RETRY = { maxRetries: 0 };
const NO_BREAKER = { failureThreshold: 1_000_000, volumeThreshold: 1_000_000 };

async function main() {
  const net = new MockNetwork();
  net.install();

  const openai = net.register("openai-demo.mock", new MockAdapter("openai")).onRequest({}, () => {
    throw new MeridianError(
      "service unavailable",
      "provider",
      "openai",
      false,
      "",
      undefined,
      undefined,
      503,
    );
  });

  const anthropic = net
    .register("anthropic-demo.mock", new MockAdapter("anthropic"))
    .onRequest({}, () => ({
      status: 200,
      body: { id: "msg_1", model: "claude-opus-4-5", from: "anthropic" },
    }))
    .simulateDelay(27);

  banner("Meridian Failover Demo");
  console.log(
    'Your application calls service("llm"). It never touches "openai" or "anthropic" directly.\n',
  );
  console.log("Provider status:");
  console.log(`  openai      ${color.red("● DOWN")}    (503 — simulated outage)`);
  console.log(`  anthropic   ${color.green("● ACTIVE")}`);

  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: new NarrativeObservability(),
    providers: {
      openai: { auth: {}, adapter: openai, retry: NO_RETRY, circuitBreaker: NO_BREAKER },
      anthropic: { auth: {}, adapter: anthropic, retry: NO_RETRY, circuitBreaker: NO_BREAKER },
    },
    services: {
      llm: { providers: ["openai", "anthropic"], strategy: "failover" },
    },
  });

  section('service("llm").post("/v1/chat/completions")');
  await sleep(150);

  const start = performance.now();
  const { meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
    body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
  });
  const elapsed = performance.now() - start;

  section("Result");
  console.log(`  Served by      : ${color.cyan(meta.provider)}`);
  console.log(`  Recovery time  : ${color.bold(`${elapsed.toFixed(0)}ms`)}`);
  console.log(`  Retries        : ${meta.trace?.retries ?? 0}`);
  console.log(`  Circuit state  : ${meta.trace?.circuitBreaker}`);
  console.log(
    `\n${color.green("✓")} Your application got a successful response. It never saw the OpenAI outage.\n`,
  );

  net.restore();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
