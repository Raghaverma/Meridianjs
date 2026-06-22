# Migrating from LangChain to Meridian

LangChain and Meridian solve different problems — LangChain orchestrates LLM applications (prompts, chains, agents, memory, RAG); Meridian is the reliability layer for the API calls underneath. So "migrating" usually means one of two things:

- **You're using LangChain only as a thin LLM client** (chat models + `withFallbacks`, no chains/agents/memory) — you can replace it with Meridian directly. See [Path A](#path-a-replace-langchains-llm-client-with-meridian).
- **You're using LangChain for real orchestration** (chains, agents, RAG) and just want the underlying provider calls to be more resilient — keep LangChain, and route its model calls through Meridian. See [Path B](#path-b-keep-langchain-swap-the-transport).

Most teams want Path B. Read [Meridian vs. LangChain](../comparisons/langchain.md) first if you haven't decided which applies to you.

## Path A: Replace LangChain's LLM client with Meridian

If your LangChain usage looks like this — a chat model plus a manual fallback chain, with no prompt templates, agents, or memory — `meridianjs/ai` replaces it directly. It wraps the [Vercel AI SDK](https://ai-sdk.dev) rather than Meridian's general `service()` abstraction, because OpenAI and Anthropic don't share a request/response shape and a chat completion is a `POST` — `service()` never auto-fails-over a write (see [docs/failover/index.md](../failover/index.md)). The AI SDK's normalization is what makes failover both possible and safe here.

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
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
});

const { text, response } = await generateText({ model, prompt: "Summarize this contract." });
console.log(text);
```

The differences from `withFallbacks`:

| | LangChain `withFallbacks` | `meridianjs/ai` |
|---|---|---|
| Trigger for fallback | Any error from the primary model | Configurable (`failoverOn: ["rate_limit", "network", "provider"]`) |
| Already-known-bad provider | Retried until it errors again | Circuit breaker skips it instantly |
| Error shape | Each integration's native error | One `MeridianError` with `category`/`retryable` |
| Cost/usage tracking | Per-integration callbacks | `result.usage` per call; aggregate via an `AnalyticsCollector` passed as `observability` |
| Non-LLM providers | Not applicable | Meridian's `provider()`/`service()` (a different API — see [docs/failover/index.md](../failover/index.md)) |

If your code also used `PromptTemplate`, `RunnableSequence`, output parsers, or memory, those are LangChain-specific conveniences with no Meridian equivalent — Meridian doesn't do prompt orchestration. Re-implement that logic directly (string templates / your own parsing), or use Path B and keep LangChain for that part.

## Path B: Keep LangChain, swap the transport

If you have real chains, agents, or RAG pipelines, don't rip those out. Instead, give LangChain a custom chat model whose `_generate` delegates to a `meridianjs/ai`-wrapped model. Your prompts, chains, and agents are unaffected — but every model call now gets a circuit breaker, retries, and normalized errors.

```typescript
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { type ChatResult } from "@langchain/core/outputs";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

class MeridianChatModel extends BaseChatModel {
  private model = wrapLanguageModel({
    model: openai("gpt-4o"),
    middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
  });

  _llmType() {
    return "meridian";
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const { text, response } = await generateText({
      model: this.model,
      messages: messages.map((m) => ({
        role: m._getType() === "human" ? ("user" as const) : ("assistant" as const),
        content: String(m.content),
      })),
    });

    return {
      generations: [{ text, message: new AIMessage(text) }],
      llmOutput: { modelId: response.modelId },
    };
  }
}

// Drop this into any existing chain in place of ChatOpenAI / ChatAnthropic
const model = new MeridianChatModel();
```

> LangChain.js's `BaseChatModel` interface evolves between versions — check your installed `@langchain/core` version's docs for the exact `_generate` signature (especially streaming via `_streamResponseChunks`, which can be implemented the same way using `streamText({ model: this.model, ... })`).

With this in place:

- `llmOutput.modelId` tells you when OpenAI was skipped in favor of Anthropic — visible for LangSmith/your own tracing.
- Pass `observability: [analytics]` to `meridianReliability()` (an `AnalyticsCollector` from `meridianjs`) to get aggregate stats across every chain step that hits an LLM.

## What stays in LangChain

- Prompt templates, output parsers, chains, agents, memory, RAG/vector store integrations — none of this is in scope for Meridian, and Path B doesn't touch it.
- LangSmith tracing — Meridian's `meta.trace` is complementary (provider-level: which adapter, retries, circuit breaker state), not a replacement for chain-level tracing.

## Checklist

- [ ] Decide: Path A (replace LangChain's LLM client entirely) or Path B (keep LangChain, swap transport)
- [ ] `npm install ai @ai-sdk/openai @ai-sdk/anthropic` (and any other providers you use) alongside `meridianjs`
- [ ] Path A: replace `model.invoke(...)` / `withFallbacks` with `wrapLanguageModel({ model, middleware: meridianReliability({ fallbacks }) })` + `generateText`
- [ ] Path B: implement a `MeridianChatModel extends BaseChatModel` whose `_generate` delegates to that wrapped model, and substitute it for `ChatOpenAI`/`ChatAnthropic` in existing chains
- [ ] Optional: pass an `AnalyticsCollector` as `observability` to `meridianReliability()` for aggregate stats LangChain doesn't provide out of the box
