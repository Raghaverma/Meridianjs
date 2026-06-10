# Meridian vs. LangChain

These solve different problems, and the comparison usually comes from the same starting point: "I'm calling LLM providers and want this to be more robust."

LangChain (and similar frameworks like LlamaIndex) is an **application framework** for building LLM-powered software — prompt templates, chains, agents, memory, vector stores, RAG pipelines.

Meridian is a **transport-and-reliability layer** for the API calls underneath — including, but not limited to, LLM calls.

```
LangChain          → "How do I build an agent that uses an LLM?"
Meridian           → "How do I make sure the LLM call doesn't take down my app?"
```

They operate at different altitudes. You can use both together: LangChain for orchestration, Meridian as the resilient transport its model calls go through.

## The comparison

| Concern | LangChain | Meridian |
|---|---|---|
| Prompt templates, chains, agents, memory | ✅ Core focus | ❌ Out of scope |
| RAG / vector store integrations | ✅ | ❌ |
| LLM provider failover | Partial — manual fallback chains (`with_fallbacks`), one provider per call | ✅ Built-in `failover` / `round-robin` / `lowest-latency` / `cheapest` / `weighted` / `geo` strategies |
| Circuit breakers | ❌ | ✅ Automatic, per-provider |
| Retry with backoff | Partial (per-integration, inconsistent) | ✅ Uniform exponential backoff, idempotency-safe |
| Schema drift detection | ❌ | ✅ `meridian.schema.check()` |
| Rate limit normalization | ❌ | ✅ `meta.rateLimit` |
| Cost tracking | Partial (per-integration callbacks) | ✅ `meridian.cost()` across all providers |
| Tracing / observability | LangSmith (LLM-specific, hosted) | Provider-agnostic `meta.trace`, OTel/Prometheus, works for LLM *and* non-LLM calls |
| Non-LLM providers (payments, KYC, communications, logistics, etc.) | ❌ | ✅ 45 adapters total |
| Policy enforcement (PII blocking, redaction, region rules) | ❌ | ✅ Built-in policy engine |

## What this looks like in code

**LangChain's built-in fallback** handles "try another model if this one errors," but it's LLM-specific, doesn't normalize errors across providers beyond what each integration does, and has no concept of circuit breakers, schema drift, or non-LLM services:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

const primary = new ChatOpenAI({ model: "gpt-4o" });
const fallback = new ChatAnthropic({ model: "claude-opus-4-5" });

const model = primary.withFallbacks({ fallbacks: [fallback] });

const result = await model.invoke("Summarize this contract.");
```

**With Meridian underneath**, the same failover gets circuit breakers (so a known-down provider is skipped instantly instead of retried), normalized errors, rate limit tracking, and — critically — the *same* reliability guarantees apply when your app also calls Stripe, Twilio, or your KYC provider:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai: { auth: { apiKey: process.env.OPENAI_KEY! } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_KEY! } },
  },
  services: {
    llm: { providers: ["openai", "anthropic"], strategy: "failover" },
  },
});

const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
});

// meta.trace.circuitBreaker — OpenAI marked OPEN after repeated failures,
// so this request skipped straight to Anthropic instead of waiting on a timeout.
```

## Use them together

A common pattern: keep LangChain for prompt orchestration and agent logic, and route the underlying HTTP calls through Meridian's `service("llm")` so that:

- A degraded provider is detected and routed around automatically (circuit breaker), not just retried until your app's timeout.
- Every LLM call gets the same `meta.trace`, cost tracking, and policy enforcement (e.g. `blockPII`) as the rest of your stack — payments, comms, KYC.
- Schema drift in a provider's response format is caught by `meridian.schema.check()` before it silently breaks a chain step.

## The short version

LangChain answers "how do I build with LLMs." Meridian answers "how do I make every external API call — LLM or otherwise — survive a bad day." Neither replaces the other.
