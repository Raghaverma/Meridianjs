/**
 * multi-provider-llm — Run: npx tsx index.ts
 *
 * Demonstrates: LLM failover (OpenAI → Anthropic), cheapest-cost embeddings
 * (Cohere → OpenAI), per-call meta.provider/trace logging, schema drift
 * detection, and meridian.analytics() summary.
 */
import {
  Meridian,
  MeridianError,
  SchemaMonitor,
  type Schema,
  type SchemaMetadata,
  type SchemaStorage,
} from "meridianjs";

// InMemorySchemaStorage is internal; implement the 3-method interface here.
class InMemorySchemaStorage implements SchemaStorage {
  private schemas = new Map<string, Schema>();
  private versions = new Map<string, SchemaMetadata[]>();
  private k = (p: string, e: string) => `${p}::${e}`;

  async save(provider: string, endpoint: string, schema: Schema, version: string) {
    this.schemas.set(this.k(provider, endpoint), schema);
    const list = this.versions.get(provider) ?? [];
    const i = list.findIndex((m) => m.endpoint === endpoint);
    const entry: SchemaMetadata = { endpoint, version, savedAt: new Date().toISOString() };
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
      openai:    { auth: { apiKey: process.env.OPENAI_API_KEY ?? "" } },
      anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY ?? "" } },
      cohere:    { auth: { apiKey: process.env.COHERE_API_KEY ?? "" } },
    },
    services: {
      llm: {
        providers: ["openai", "anthropic"],
        strategy: "failover",
        failoverOn: ["rate_limit", "network", "provider"],
      },
      embeddings: {
        providers: ["cohere", "openai"],
        strategy: "cheapest",
        costs: { cohere: 0.00002, openai: 0.0001 },
      },
    },
  });

  const schemaMonitor = new SchemaMonitor(new InMemorySchemaStorage());

  async function chat(message: string): Promise<string> {
    try {
      const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
        body: { model: "gpt-4o", messages: [{ role: "user", content: message }], max_tokens: 256 },
      });
      console.log(`[chat] provider=${meta.provider}  latency=${meta.trace.latency}ms  retries=${meta.trace.retries}`);

      // alert() snapshots on first call; subsequent calls detect drift and fire the callback.
      const drifts = await schemaMonitor.alert(meta.provider, "/v1/chat/completions", data,
        (d, p, ep) => console.warn(`[schema-drift] ${p} ${ep}:`, d));
      if (drifts.length === 0) console.log("[schema] no drift detected");

      return (data as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content ?? "(no content)";
    } catch (err) {
      if (err instanceof MeridianError) {
        console.error(`[chat] ${err.category} from ${err.provider}: ${err.message}`);
        return `ERROR: ${err.message}`;
      }
      throw err;
    }
  }

  async function embed(text: string): Promise<number[]> {
    try {
      const { data, meta } = await meridian.service("embeddings")!.post("/v1/embeddings", {
        // Cohere uses "texts"+"input_type"; OpenAI uses "input". Send both; each adapter ignores unknown keys.
        body: { model: "embed-english-v3.0", input: text, texts: [text], input_type: "search_query" },
      });
      console.log(`[embed] provider=${meta.provider}  latency=${meta.trace.latency}ms`);
      // Cohere: { embeddings: [[...]] }  /  OpenAI: { data: [{ embedding: [...] }] }
      return (data as { embeddings?: number[][] })?.embeddings?.[0]
        ?? (data as { data?: Array<{ embedding: number[] }> })?.data?.[0]?.embedding
        ?? [];
    } catch (err) {
      if (err instanceof MeridianError) { console.error(`[embed] ${err.category}: ${err.message}`); return []; }
      throw err;
    }
  }

  console.log("=== Chat ===");
  console.log("Reply:", (await chat("What is TypeScript in one sentence?")).slice(0, 120));
  console.log("Reply:", (await chat("Name three benefits of an SDK abstraction layer.")).slice(0, 120));

  console.log("\n=== Embeddings ===");
  for (const text of ["integration reliability", "third-party API failover"]) {
    const vec = await embed(text);
    console.log(`  "${text}" → length=${vec.length}, first=[${vec.slice(0, 3).join(", ")}]`);
  }

  console.log("\n=== Analytics ===");
  for (const [p, s] of Object.entries(meridian.analytics())) {
    console.log(`  ${p}: requests=${s.requests}  successRate=${s.successRate}  avgLatency=${s.avgLatency}ms`);
  }

  console.log("\n=== Health ===");
  console.log(meridian.health());
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
