# LLMs

Route completions across OpenAI, Anthropic, and Gemini with automatic failover so a single provider outage doesn't take down your product.

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

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai: {
      baseUrl: "https://api.openai.com",
      auth: { type: "bearer", token: process.env.OPENAI_KEY! },
      retry: { attempts: 2, backoff: "exponential" },
      rateLimit: { requestsPerMinute: 500 },
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      auth: { type: "bearer", token: process.env.ANTHROPIC_KEY! },
      retry: { attempts: 2, backoff: "exponential" },
    },
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com",
      auth: { type: "bearer", token: process.env.GEMINI_KEY! },
      retry: { attempts: 2 },
    },
  },
  services: {
    llm: {
      providers: ["openai", "anthropic", "gemini"],
      strategy: "failover",
    },
  },
});

// One call — Meridian tries openai, then anthropic, then gemini
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Summarize this contract." }],
  },
});

console.log(meta.trace.provider);        // which provider responded
console.log(meta.trace.retries);         // retries taken
console.log(meta.rateLimit.remaining);   // remaining quota on that provider
```

## Production Example

A `/chat` endpoint that stays up even when OpenAI is fully down:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { baseUrl: "https://api.openai.com",                         auth: { type: "bearer", token: process.env.OPENAI_KEY! },    retry: { attempts: 2 } },
    anthropic: { baseUrl: "https://api.anthropic.com",                      auth: { type: "bearer", token: process.env.ANTHROPIC_KEY! }, retry: { attempts: 2 } },
    gemini:    { baseUrl: "https://generativelanguage.googleapis.com",       auth: { type: "bearer", token: process.env.GEMINI_KEY! },    retry: { attempts: 2 } },
  },
  services: {
    llm: { providers: ["openai", "anthropic", "gemini"], strategy: "failover" },
  },
});

// POST /chat
export async function handleChat(req: Request): Promise<Response> {
  const { messages, sessionId } = await req.json();

  const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
    body: { model: "gpt-4o", messages },
  });

  // If OpenAI circuit-broke, meta.trace.provider === "anthropic" or "gemini"
  if (meta.trace.provider !== "openai") {
    console.warn(`[${sessionId}] LLM failover: used ${meta.trace.provider} (latency: ${meta.trace.latency}ms)`);
  }

  return Response.json({
    reply:    data.choices[0].message.content,
    provider: meta.trace.provider,
    latency:  meta.trace.latency,
  });
}

// Health dashboard data — call from your monitoring endpoint
export async function getLLMHealth() {
  return {
    health:    meridian.health(),
    // { openai: { status: "down", circuitBreaker: "OPEN", successRate: "0%" },
    //   anthropic: { status: "healthy", circuitBreaker: "CLOSED", successRate: "99.8%" } }
    analytics: meridian.analytics(),
    // { openai: { requests: 0, errorRate: "100%", avgLatency: 30000 },
    //   anthropic: { requests: 8412, errorRate: "0.2%", avgLatency: 820 } }
  };
}
```
