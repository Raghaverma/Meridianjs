import { Meridian, MeridianError, blockPII } from "meridianjs";
import { type NextRequest, NextResponse } from "next/server";

// Meridian is initialised once and reused across requests (module-level singleton).
// In production, remove `localUnsafe: true` and provide proper auth via environment.
let meridian: Awaited<ReturnType<typeof Meridian.create>> | null = null;

async function getMeridian() {
  if (meridian) return meridian;

  meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      openai: {
        auth: { apiKey: process.env.OPENAI_API_KEY ?? "" },
      },
      anthropic: {
        auth: { apiKey: process.env.ANTHROPIC_API_KEY ?? "" },
      },
    },
    services: {
      llm: {
        providers: ["openai", "anthropic"],
        strategy: "failover",
        failoverOn: ["rate_limit", "network", "provider"],
      },
    },
    policies: [blockPII(["openai", "anthropic"])],
  });

  return meridian;
}

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

  const m = await getMeridian();
  const llm = m.service("llm");

  if (!llm) {
    return NextResponse.json({ error: "LLM service not configured" }, { status: 500 });
  }

  try {
    const { data, meta } = await llm.post<{
      choices: Array<{ message: { content: string } }>;
    }>("/v1/chat/completions", {
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: message }],
        max_tokens: 512,
      },
    });

    console.log(`[meridian] provider=${meta.provider}  latency=${meta.trace.latency}ms  retries=${meta.trace.retries}`);

    const reply = (data as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";

    return NextResponse.json(
      { reply, provider: meta.provider },
      {
        headers: {
          "x-meridian-provider": meta.provider,
          "x-meridian-latency": String(meta.trace.latency),
        },
      },
    );
  } catch (err) {
    if (err instanceof MeridianError) {
      const status =
        err.category === "auth"
          ? 401
          : err.category === "rate_limit"
            ? 429
            : err.category === "validation"
              ? 422
              : 502;

      return NextResponse.json(
        {
          error: err.message,
          category: err.category,
          provider: err.provider,
          retryable: err.retryable,
        },
        { status },
      );
    }

    console.error("[meridian] unexpected error", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
