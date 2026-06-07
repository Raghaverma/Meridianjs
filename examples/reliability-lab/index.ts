/**
 * Meridian Reliability Lab
 *
 * A fully self-contained demo that simulates a real outage sequence using
 * MockAdapters — no API keys required. Watch how the pipeline responds:
 *
 *   Phase 1 — Normal         OpenAI handles all requests
 *   Phase 2 — Outage         OpenAI goes down, Anthropic takes over instantly
 *   Phase 3 — Circuit open   After 5 failures the breaker opens; calls fail-fast
 *   Phase 4 — Recovery       OpenAI comes back; circuit half-opens, then closes
 *   Phase 5 — 429 + retry    Stripe returns rate-limit; Meridian backs off and retries
 *
 * Run: npx vite-node examples/reliability-lab/index.ts
 */

import { Meridian, MeridianError, NoOpObservability } from "../../src/public.js";
import { CircuitState } from "../../src/core/types.js";
import type { RequestOptions } from "../../src/core/types.js";
import { MockAdapter } from "../../src/testing/mock-adapter.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function log(icon: string, label: string, msg: string, extra?: Record<string, unknown>) {
  const line = `  ${icon} ${label.padEnd(12)} ${msg}`;
  if (extra) {
    const pairs = Object.entries(extra)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("  ");
    console.log(line + "  " + dim(pairs));
  } else {
    console.log(line);
  }
}

function divider(title: string) {
  console.log(`\n${bold(cyan(`── ${title} `))}\n`);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Mock network router ───────────────────────────────────────────────────────
// The Meridian pipeline dispatches through the global fetch(). We install a
// shim that routes by hostname to the right MockAdapter, so each provider gets
// independent, controllable behaviour without touching a real network.

const adapters = new Map<string, MockAdapter>();

function registerAdapter(host: string, adapter: MockAdapter) {
  adapter.baseUrl = `https://${host}`;
  adapters.set(host, adapter);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const urlStr =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(urlStr);
  const adapter = adapters.get(url.host);
  if (!adapter) {
    throw new TypeError(`MockNetwork: no route for "${url.host}"`);
  }
  const method = (init?.method ?? "GET") as RequestOptions["method"] & string;
  const raw = await adapter.resolve(method, url.pathname, { method });
  const body = typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body ?? {});
  return new Response(body, { status: raw.status, headers: raw.headers });
}) as typeof fetch;

// ── Provider adapters ─────────────────────────────────────────────────────────

function makeOpenAI(): MockAdapter {
  const a = new MockAdapter("openai");
  registerAdapter("api.openai.com", a);
  return a;
}

function makeAnthropic(): MockAdapter {
  const a = new MockAdapter("anthropic");
  registerAdapter("api.anthropic.com", a);
  return a;
}

function makeStripe(): MockAdapter {
  const a = new MockAdapter("stripe");
  registerAdapter("api.stripe.com", a);
  return a;
}

// ── Main demo ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${bold("Meridian Reliability Lab")}`);
  console.log(
    dim("  Self-contained outage simulation — no API keys needed\n"),
  );

  const openai = makeOpenAI();
  const anthropic = makeAnthropic();
  const stripe = makeStripe();

  // ── Build Meridian instance ──────────────────────────────────────────────
  const meridian = await Meridian.create({
    localUnsafe: true,
    observability: new NoOpObservability(),
    defaults: {
      rateLimit: { tokensPerSecond: 1e9, maxTokens: 1e9 },
    },
    providers: {
      openai: {
        auth: { apiKey: "sk-mock" },
        adapter: openai,
        retry: { maxRetries: 0 },           // failover handles provider errors
        circuitBreaker: {
          failureThreshold: 5,
          volumeThreshold: 5,
          successThreshold: 2,
          timeout: 200,                       // 200 ms cooldown for the demo
          rollingWindowMs: 60_000,
          errorThresholdPercentage: 50,
        },
      },
      anthropic: {
        auth: { apiKey: "sk-ant-mock" },
        adapter: anthropic,
        retry: { maxRetries: 0 },
        circuitBreaker: {
          failureThreshold: 5,
          volumeThreshold: 5,
          successThreshold: 2,
          timeout: 200,
          rollingWindowMs: 60_000,
          errorThresholdPercentage: 50,
        },
      },
      stripe: {
        auth: { apiKey: "sk-stripe-mock" },
        adapter: stripe,
        retry: { maxRetries: 3, baseDelay: 20, maxDelay: 100, jitter: false },
        circuitBreaker: { failureThreshold: 100, volumeThreshold: 100 },
      },
    },
    services: {
      llm: {
        providers: ["openai", "anthropic"],
        strategy: "failover",
        failoverOn: ["provider", "network", "rate_limit"],
      },
    },
  });

  const llm = meridian.service("llm")!;

  // ────────────────────────────────────────────────────────────────────────────
  divider("Phase 1 — Normal operation");
  // ────────────────────────────────────────────────────────────────────────────

  openai.onRequest({}, () => ({
    status: 200,
    body: { id: "chatcmpl-1", choices: [{ message: { content: "Hello from OpenAI" } }] },
  }));
  anthropic.onRequest({}, () => ({
    status: 200,
    body: { id: "msg-1", content: [{ text: "Hello from Anthropic" }] },
  }));

  for (let i = 1; i <= 3; i++) {
    const { meta } = await llm.get("/v1/chat/completions");
    log(
      green("✓"),
      "request",
      `call #${i} succeeded`,
      { provider: meta.provider, latency: `${meta.trace?.latency}ms`, cb: meta.trace?.circuitBreaker },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  divider("Phase 2 — OpenAI outage → automatic failover");
  // ────────────────────────────────────────────────────────────────────────────

  openai.reset();
  openai.onRequest({}, () => {
    throw new MeridianError("Service unavailable", "provider", "openai", false);
  });

  for (let i = 1; i <= 4; i++) {
    const { meta } = await llm.get("/v1/chat/completions");
    const isFailover = meta.provider === "anthropic";
    log(
      isFailover ? yellow("⇢") : green("✓"),
      "request",
      isFailover
        ? `call #${i} failed over to anthropic`
        : `call #${i} succeeded via ${meta.provider}`,
      { provider: meta.provider, latency: `${meta.trace?.latency}ms` },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  divider("Phase 3 — Circuit breaker opens (direct provider call)");
  // ────────────────────────────────────────────────────────────────────────────
  // Hit OpenAI directly (not the service) to accumulate failures and trip the
  // circuit breaker, then show the fail-fast behaviour.

  const openaiClient = meridian.provider("openai")!;

  log(dim("·"), "setup", "sending 5 direct requests to openai to trip the circuit breaker…");
  for (let i = 1; i <= 5; i++) {
    try {
      await openaiClient.get("/v1/chat/completions");
    } catch {
      // expected
    }
  }

  const status = meridian.getCircuitStatus("openai");
  log(
    status?.state === CircuitState.OPEN ? red("⊘") : yellow("△"),
    "circuit",
    `openai circuit is now ${status?.state}`,
    { failures: status?.failures, nextAttempt: status?.nextAttempt?.toISOString() },
  );

  const t0 = Date.now();
  try {
    await openaiClient.get("/v1/chat/completions");
  } catch (err) {
    const ms = Date.now() - t0;
    log(
      red("✗"),
      "fail-fast",
      `blocked in ${ms}ms — no network call made`,
      { error: (err as Error).message.slice(0, 60) },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  divider("Phase 4 — OpenAI recovers → circuit closes");
  // ────────────────────────────────────────────────────────────────────────────

  log(dim("·"), "setup", `waiting for circuit timeout (200 ms)…`);
  await sleep(220);

  openai.reset();
  openai.onRequest({}, () => ({
    status: 200,
    body: { id: "chatcmpl-recovery", choices: [{ message: { content: "Back online!" } }] },
  }));

  for (let i = 1; i <= 4; i++) {
    try {
      const { meta } = await openaiClient.get("/v1/chat/completions");
      const s = meridian.getCircuitStatus("openai")?.state;
      log(
        green("✓"),
        "recovery",
        `probe #${i} succeeded — circuit is now ${s}`,
        { provider: meta.provider },
      );
    } catch (err) {
      log(red("✗"), "recovery", `probe #${i} failed: ${(err as Error).message.slice(0, 60)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  divider("Phase 5 — Stripe 429 → retry with backoff");
  // ────────────────────────────────────────────────────────────────────────────

  let stripeAttempts = 0;
  stripe.onRequest({}, () => {
    stripeAttempts++;
    if (stripeAttempts < 3) {
      // First 2 attempts: rate limited
      throw new MeridianError("Rate limited", "rate_limit", "stripe", true);
    }
    return { status: 200, body: { id: "ch_mock", amount: 2000, currency: "usd" } };
  });

  log(dim("·"), "setup", "sending a charge request — stripe will rate-limit twice then succeed");

  const t1 = Date.now();
  try {
    const { meta } = await meridian.provider("stripe")!.post("/v1/charges");
    log(
      green("✓"),
      "stripe",
      `charge succeeded after ${meta.trace?.retries} retries (${Date.now() - t1}ms total)`,
      { attempts: stripeAttempts, provider: meta.provider },
    );
  } catch (err) {
    log(red("✗"), "stripe", `failed: ${(err as Error).message}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  divider("Analytics summary");
  // ────────────────────────────────────────────────────────────────────────────

  const analytics = meridian.analytics();
  for (const [name, stats] of Object.entries(analytics)) {
    log(
      dim("·"),
      name,
      `${stats.requests} reqs  ${stats.successRate} success  ${stats.avgLatency}ms avg`,
    );
  }

  const health = meridian.health();
  console.log();
  for (const [name, h] of Object.entries(health)) {
    const icon = h.status === "healthy" ? green("●") : red("●");
    log(icon, name, `${h.status}  circuit=${h.circuitBreaker}  successRate=${h.successRate}`);
  }

  console.log(`\n${dim("Done. No real network calls were made.")}\n`);
  globalThis.fetch = realFetch;
}

main().catch((err) => {
  console.error(red("Fatal:"), err);
  globalThis.fetch = realFetch;
  process.exit(1);
});
