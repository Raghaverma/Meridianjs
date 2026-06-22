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
| LLM provider failover | Partial — manual fallback chains (`with_fallbacks`), one provider per call | ✅ `meridianjs/ai` middleware (`wrapLanguageModel`) — real failover, no request translation since the AI SDK already normalizes providers |
| Circuit breakers | ❌ | ✅ Automatic, per-provider |
| Retry with backoff | Partial (per-integration, inconsistent) | ✅ Uniform exponential backoff, idempotency-safe |
| Schema drift detection | ❌ | ✅ `meridian.schema.check()` |
| Rate limit normalization | ❌ | ✅ `meta.rateLimit` |
| Cost tracking | Partial (per-integration callbacks) | ✅ `meridian.cost()` across all providers |
| Tracing / observability | LangSmith (LLM-specific, hosted) | Provider-agnostic `meta.trace`, OTel/Prometheus, works for LLM *and* non-LLM calls |
| Non-LLM providers (payments, KYC, communications, logistics, etc.) | ❌ | ✅ 46 adapters total |
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

**With Meridian's `meridianjs/ai` middleware underneath**, the same failover gets a circuit breaker (so a known-down provider is skipped instantly instead of retried), normalized errors, and observability — and unlike `service("llm")`, it actually fails over a completion call safely, because providers only bill for output returned (see [docs/ai-sdk.md](../ai-sdk.md)):

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
});

const { text, response } = await generateText({ model, prompt: "Summarize this contract." });

// response.modelId — OpenAI's circuit opened after repeated failures, so this
// request skipped straight to Anthropic instead of waiting on a timeout.
```

## Use them together

A common pattern: keep LangChain for prompt orchestration and agent logic, and pass it a model wrapped with `meridianjs/ai` instead of a raw `ChatOpenAI`/`ChatAnthropic` instance (LangChain's `@langchain/community` model wrappers can take an AI SDK model where supported), so that:

- A degraded provider is detected and routed around automatically (circuit breaker), not just retried until your app's timeout.
- Every LLM call gets the same observability interface (`ObservabilityAdapter`) as the rest of your stack — payments, comms, KYC — even though the AI calls themselves go through a different code path (`meridianjs/ai`, not `service()`).
- For everything that *isn't* an LLM call — payments, comms, KYC — `meridian.service()` still applies the same reliability mechanics, with the idempotent-methods-only failover rule documented in [docs/failover/index.md](../failover/index.md).

## The short version

LangChain answers "how do I build with LLMs." Meridian answers "how do I make every external API call — LLM or otherwise — survive a bad day." Neither replaces the other.
