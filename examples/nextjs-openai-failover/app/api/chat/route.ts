import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";
import { type NextRequest, NextResponse } from "next/server";

// Built once and reused across requests (module-level singleton). The AI SDK
// already normalizes OpenAI and Anthropic into one doGenerate/doStream
// interface, so meridianReliability() doesn't need to translate anything —
// it just retries, circuit-breaks, and fails over between the two.
const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5")],
    retry: { maxRetries: 2, baseDelay: 200 },
  }),
});

export async function POST(req: NextRequest) {
  let body: { message?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "`message` is required" }, { status: 400 });
  }

  try {
    const { text, response } = await generateText({ model, prompt: message });

    // response.modelId reflects whichever provider actually generated this
    // response — OpenAI's adapter populates it from the real API response, so
    // does Anthropic's. If OpenAI was down, this is Anthropic's model ID.
    return NextResponse.json(
      { reply: text },
      { headers: { "x-meridian-provider": response.modelId ?? "unknown" } },
    );
  } catch (err) {
    // Every fallback failed too — meridianReliability already retried each
    // model per its own circuit breaker before giving up.
    console.error("[meridian] generation failed on every provider", err);
    return NextResponse.json({ error: "All providers failed" }, { status: 502 });
  }
}
