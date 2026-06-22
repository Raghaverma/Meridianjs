/**
 * demo:failover
 *
 * Scenario: OpenAI is down. Your application calls service("llm") — it never
 * calls "openai" or "anthropic" directly.
 *
 * Two requests, two outcomes, both by design:
 *   - GET  (idempotent) → Meridian fails over to Anthropic automatically.
 *   - POST (a write)    → Meridian refuses to fail over. Replaying a write on
 *     a provider that never saw it could double the side effect (e.g. a
 *     second LLM call billed twice, or worse for a payments provider). The
 *     original error surfaces instead, with full retry/circuit context, so
 *     you decide the safe recovery — see docs/failover/index.md.
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

function outage(provider: string) {
  return () => {
    throw new MeridianError(
      "service unavailable",
      "provider",
      provider,
      false,
      "",
      undefined,
      undefined,
      503,
    );
  };
}

async function main() {
  const net = new MockNetwork();
  net.install();

  const openai = net
    .register("openai-demo.mock", new MockAdapter("openai"))
    .onRequest({}, outage("openai"));

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

  section('GET — service("llm").get("/v1/models") — idempotent, safe to retry elsewhere');
  await sleep(150);

  const start = performance.now();
  const { meta } = await meridian.service("llm")!.get("/v1/models");
  const elapsed = performance.now() - start;

  console.log(`\n  Served by      : ${color.cyan(meta.provider)}`);
  console.log(`  Recovery time  : ${color.bold(`${elapsed.toFixed(0)}ms`)}`);
  console.log(
    `  ${color.green("✓")} Your application got a successful response. It never saw the OpenAI outage.\n`,
  );

  section('POST — service("llm").post("/v1/chat/completions") — a write, NOT failed over');
  await sleep(150);

  try {
    await meridian.service("llm")!.post("/v1/chat/completions", {
      body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
    });
    console.log(
      `\n  ${color.red("✗")} Unexpected: this write should not have succeeded against a down provider.`,
    );
    process.exitCode = 1;
  } catch (err) {
    const e = err as MeridianError;
    console.log(
      `\n  ${color.yellow("⚠")}  Refused to fail over — category: ${e.category}, provider: ${e.provider}`,
    );
    console.log(
      `  ${color.dim("Anthropic never saw this request, so it can't have run it twice.")} ` +
        `${color.dim("Your app decides the retry — see docs/failover/index.md.")}\n`,
    );
  }

  net.restore();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
