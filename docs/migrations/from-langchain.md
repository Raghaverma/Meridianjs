# Migrating from LangChain to Meridian

LangChain and Meridian solve different problems — LangChain orchestrates LLM applications (prompts, chains, agents, memory, RAG); Meridian is the reliability layer for the API calls underneath. So "migrating" usually means one of two things:

- **You're using LangChain only as a thin LLM client** (chat models + `withFallbacks`, no chains/agents/memory) — you can replace it with Meridian directly. See [Path A](#path-a-replace-langchains-llm-client-with-meridian).
- **You're using LangChain for real orchestration** (chains, agents, RAG) and just want the underlying provider calls to be more resilient — keep LangChain, and route its model calls through Meridian. See [Path B](#path-b-keep-langchain-swap-the-transport).

Most teams want Path B. Read [Meridian vs. LangChain](../comparisons/langchain.md) first if you haven't decided which applies to you.

## Path A: Replace LangChain's LLM client with Meridian

If your LangChain usage looks like this — a chat model plus a manual fallback chain, with no prompt templates, agents, or memory — Meridian replaces it directly:

```typescript
// Before
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

const primary = new ChatOpenAI({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY });
const fallback = new ChatAnthropic({ model: "claude-opus-4-5", apiKey: process.env.ANTHROPIC_API_KEY });

const model = primary.withFallbacks({ fallbacks: [fallback] });
const result = await model.invoke("Summarize this contract.");
console.log(result.content);
```

```typescript
// After
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai: { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
  },
  services: {
    llm: { providers: ["openai", "anthropic"], strategy: "failover" },
  },
});

const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
});
console.log(data.choices[0].message.content);
```

The differences from `withFallbacks`:

| | LangChain `withFallbacks` | Meridian `service("llm")` |
|---|---|---|
| Trigger for fallback | Any error from the primary model | Configurable (`failoverOn: ["rate_limit", "network", "provider"]`) |
| Already-known-bad provider | Retried until it errors again | Circuit breaker skips it instantly (`meta.trace.circuitBreaker`) |
| Error shape | Each integration's native error | One `MeridianError` with `category`/`retryable`/`retryAfter` |
| Cost/rate-limit tracking | Per-integration callbacks | `meta.rateLimit`, `meridian.cost()`, `meridian.analytics()` across all providers |
| Non-LLM providers | Not applicable | Same pattern for `service("payments")`, `provider("twilio")`, etc. |

If your code also used `PromptTemplate`, `RunnableSequence`, output parsers, or memory, those are LangChain-specific conveniences with no Meridian equivalent — Meridian doesn't do prompt orchestration. Re-implement that logic directly (string templates / your own parsing), or use Path B and keep LangChain for that part.

## Path B: Keep LangChain, swap the transport

If you have real chains, agents, or RAG pipelines, don't rip those out. Instead, give LangChain a custom chat model whose `_generate` delegates to `meridian.service("llm")`. Your prompts, chains, and agents are unaffected — but every model call now gets Meridian's circuit breakers, retries, normalized errors, rate-limit tracking, and policy enforcement.

```typescript
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai: { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
  },
  services: {
    llm: { providers: ["openai", "anthropic"], strategy: "failover" },
  },
});

class MeridianChatModel extends BaseChatModel {
  constructor(private model: string) {
    super({});
  }

  _llmType() {
    return "meridian";
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
      body: {
        model: this.model,
        messages: messages.map((m) => ({ role: m._getType() === "human" ? "user" : "assistant", content: m.content })),
      },
    });

    const content = data.choices[0].message.content;
    return {
      generations: [{ text: content, message: new AIMessage(content) }],
      llmOutput: { provider: meta.trace.provider, latency: meta.trace.latency },
    };
  }
}

// Drop this into any existing chain in place of ChatOpenAI / ChatAnthropic
const model = new MeridianChatModel("gpt-4o");
```

> LangChain.js's `BaseChatModel` interface evolves between versions — check your installed `@langchain/core` version's docs for the exact `_generate` signature (especially streaming via `_streamResponseChunks`, which can be implemented the same way using `meridian.service("llm")!.stream(...)`).

With this in place:

- `meta.trace.circuitBreaker` tells you when OpenAI was skipped in favor of Anthropic — visible in `llmOutput` for LangSmith/your own tracing.
- `meridian.schema.check()` can validate that OpenAI's response shape hasn't drifted before it reaches your chain's output parser.
- `policies: [blockPII(["openai", "anthropic"])]` enforces PII redaction on every chain step that hits an LLM, not just the ones you remember to wrap.

## What stays in LangChain

- Prompt templates, output parsers, chains, agents, memory, RAG/vector store integrations — none of this is in scope for Meridian, and Path B doesn't touch it.
- LangSmith tracing — Meridian's `meta.trace` is complementary (provider-level: which adapter, retries, circuit breaker state), not a replacement for chain-level tracing.

## Checklist

- [ ] Decide: Path A (replace LangChain's LLM client entirely) or Path B (keep LangChain, swap transport)
- [ ] Configure `providers` + `services.llm` in Meridian for the models you currently call via LangChain integrations
- [ ] Path A: replace `model.invoke(...)` / `withFallbacks` with `meridian.service("llm").post(...)`
- [ ] Path B: implement a `MeridianChatModel extends BaseChatModel` and substitute it for `ChatOpenAI`/`ChatAnthropic` in existing chains
- [ ] Optional: add `policies: [blockPII([...])]` and `meridian.schema.check()` for guardrails LangChain doesn't provide
