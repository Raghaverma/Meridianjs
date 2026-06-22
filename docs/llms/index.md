# LLMs

Route completions across OpenAI, Anthropic, and Gemini with automatic failover so a single provider outage doesn't take down your product — via Meridian's Vercel AI SDK middleware, `meridianjs/ai`.

## Problem

LLM providers go down, hit rate limits, and have subtly different request/response shapes. If you're hardcoded to OpenAI and they have an incident, your feature is dead. Handling fallback manually means duplicating request logic for every provider and wiring up error detection by hand.

## Without Meridian

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY! });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY! });

async function complete(prompt: string) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0].message.content;
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      // Manually rewrite for Anthropic's completely different shape
      const res = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return res.content[0].type === "text" ? res.content[0].text : "";
    }
    throw err;
  }
}
```

## With Meridian

Why `meridianjs/ai` rather than Meridian's general `service()` abstraction: OpenAI, Anthropic, and Gemini don't share a request/response shape at the HTTP level, and `service()` only auto-fails-over idempotent methods anyway — a chat completion is a `POST`, and a different provider has no way to know whether the original call already produced output. The [Vercel AI SDK](https://ai-sdk.dev) solves the shape problem by normalizing every provider into one `doGenerate`/`doStream` interface; `meridianjs/ai` wraps that with retries, a circuit breaker, and failover. See [docs/ai-sdk.md](../ai-sdk.md) for the full reference, including why failover is safe here even though it's a write.

```bash
npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5"), google("gemini-2.5-pro")],
    retry: { maxRetries: 2, baseDelay: 200 },
  }),
});

// One call — tries openai, then anthropic, then gemini
const { text, response } = await generateText({
  model,
  prompt: "Summarize this contract.",
});

console.log(response.modelId); // which model actually responded
```

## Production Example

A `/chat` endpoint that stays up even when OpenAI is fully down:

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { AnalyticsCollector } from "meridianjs";
import { meridianReliability } from "meridianjs/ai";

const analytics = new AnalyticsCollector();
const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5"), google("gemini-2.5-pro")],
    observability: [analytics],
  }),
});

// POST /chat
export async function handleChat(req: Request): Promise<Response> {
  const { messages, sessionId } = await req.json();

  const { text, response } = await generateText({ model, messages });

  // If OpenAI's circuit opened, response.modelId reflects anthropic or gemini
  if (!response.modelId?.startsWith("gpt-")) {
    console.warn(`[${sessionId}] LLM failover: used ${response.modelId}`);
  }

  return Response.json({ reply: text, model: response.modelId });
}

// Health dashboard data — call from your monitoring endpoint
export function getLLMHealth() {
  return {
    analytics: analytics.get(),
    // { openai: { requests: 0, errorRate: "100%", avgLatency: 30000 },
    //   anthropic: { requests: 8412, errorRate: "0.2%", avgLatency: 820 } }
    health: analytics.getHealth(),
    // { openai: { status: "down", successRate: "0%" },
    //   anthropic: { status: "healthy", successRate: "99.8%" } }
  };
}
```
