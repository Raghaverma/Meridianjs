/**
 * multi-provider-llm — Run: npx tsx index.ts
 *
 * Demonstrates: LLM failover via meridianjs/ai (OpenAI → Anthropic), cheapest-
 * cost embeddings (Cohere → OpenAI) via Meridian's HTTP service layer, schema
 * drift detection, and analytics across both layers.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import {
  AnalyticsCollector,
  Meridian,
  MeridianError,
  SchemaMonitor,
  type Schema,
  type SchemaMetadata,
  type SchemaStorage,
} from "meridianjs";
import { meridianReliability } from "meridianjs/ai";

// InMemorySchemaStorage is internal; implement the 3-method interface here.
class InMemorySchemaStorage implements SchemaStorage {
  private schemas = new Map<string, Schema>();
  private versions = new Map<string, SchemaMetadata[]>();
  private k = (p: string, e: string) => `${p}::${e}`;

  async save(provider: string, endpoint: string, schema: Schema, version: string) {
    this.schemas.set(this.k(provider, endpoint), schema);
    const list = this.versions.get(provider) ?? [];
    const i = list.findIndex((m) => m.endpoint === endpoint);
    const entry: SchemaMetadata = {
      provider,
      endpoint,
      version,
      checksum: String(JSON.stringify(schema).length),
      createdAt: new Date(),
    };
    i >= 0 ? (list[i] = entry) : list.push(entry);
    this.versions.set(provider, list);
  }
  async load(provider: string, endpoint: string): Promise<Schema | null> {
    return this.schemas.get(this.k(provider, endpoint)) ?? null;
  }
  async list(provider: string): Promise<SchemaMetadata[]> {
    return this.versions.get(provider) ?? [];
  }
}

async function main() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      openai: { auth: { apiKey: process.env.OPENAI_API_KEY ?? "" } },
      cohere: { auth: { apiKey: process.env.COHERE_API_KEY ?? "" } },
    },
    services: {
      // Cost-based routing, not error-failover: each call picks the cheapest
      // provider. Like every Meridian service(), a failed POST surfaces its
      // error rather than retrying on the other provider (see docs/failover).
      embeddings: {
        providers: ["cohere", "openai"],
        strategy: "cheapest",
        costs: { cohere: 0.00002, openai: 0.0001 },
      },
    },
  });

  // Chat goes through meridianjs/ai instead of meridian.service("llm") — the
  // AI SDK already normalizes OpenAI/Anthropic into one interface, so this is
  // the one place real cross-provider failover (including on writes) is both
  // safe and possible without translating request/response shapes by hand.
  // See docs/ai-sdk.md.
  const chatAnalytics = new AnalyticsCollector();
  const chatModel = wrapLanguageModel({
    model: openai("gpt-4o"),
    middleware: meridianReliability({
      fallbacks: [anthropic("claude-opus-4-5")],
      retry: { maxRetries: 2, baseDelay: 200 },
      observability: [chatAnalytics],
    }),
  });

  const schemaMonitor = new SchemaMonitor(new InMemorySchemaStorage());

  async function chat(message: string): Promise<string> {
    try {
      const { text, response } = await generateText({ model: chatModel, prompt: message });
      console.log(`[chat] provider=${response.modelId ?? "unknown"}`);
      return text;
    } catch (err) {
      console.error("[chat] failed on every provider:", err);
      return "ERROR";
    }
  }

  async function embed(text: string): Promise<number[]> {
    try {
      const { data, meta } = await meridian.service("embeddings")!.post("/v1/embeddings", {
        // Cohere uses "texts"+"input_type"; OpenAI uses "input". Send both; each adapter ignores unknown keys.
        body: { model: "embed-english-v3.0", input: text, texts: [text], input_type: "search_query" },
      });
      console.log(`[embed] provider=${meta.provider}  latency=${meta.trace?.latency ?? 0}ms`);

      // alert() snapshots on first call; subsequent calls detect drift and fire the callback.
      const drifts = await schemaMonitor.alert(meta.provider, "/v1/embeddings", data, (d, p, ep) =>
        console.warn(`[schema-drift] ${p} ${ep}:`, d),
      );
      if (drifts.length === 0) console.log("[schema] no drift detected");

      // Cohere: { embeddings: [[...]] }  /  OpenAI: { data: [{ embedding: [...] }] }
      return (
        (data as { embeddings?: number[][] })?.embeddings?.[0] ??
        (data as { data?: Array<{ embedding: number[] }> })?.data?.[0]?.embedding ??
        []
      );
    } catch (err) {
      if (err instanceof MeridianError) {
        console.error(`[embed] ${err.category}: ${err.message}`);
        return [];
      }
      throw err;
    }
  }

  console.log("=== Chat (meridianjs/ai, OpenAI -> Anthropic on failure) ===");
  console.log("Reply:", (await chat("What is TypeScript in one sentence?")).slice(0, 120));
  console.log("Reply:", (await chat("Name three benefits of an SDK abstraction layer.")).slice(0, 120));

  console.log("\n=== Embeddings (meridian.service, cheapest-cost routing) ===");
  for (const text of ["integration reliability", "third-party API failover"]) {
    const vec = await embed(text);
    console.log(`  "${text}" -> length=${vec.length}, first=[${vec.slice(0, 3).join(", ")}]`);
  }

  console.log("\n=== Analytics: HTTP services (embeddings) ===");
  for (const [p, s] of Object.entries(meridian.analytics())) {
    console.log(`  ${p}: requests=${s.requests}  successRate=${s.successRate}  avgLatency=${s.avgLatency}ms`);
  }

  console.log("\n=== Analytics: AI SDK middleware (chat) ===");
  for (const [p, s] of Object.entries(chatAnalytics.get())) {
    console.log(`  ${p}: requests=${s.requests}  successRate=${s.successRate}  avgLatency=${s.avgLatency}ms`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
