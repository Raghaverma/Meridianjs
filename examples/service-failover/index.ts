/**
 * Service Failover Example
 *
 * Demonstrates meridian.service() — your application uses a logical service
 * name ("llm") instead of a vendor name. If OpenAI fails, Anthropic takes
 * over automatically. No code changes, no redeployment.
 *
 * Run: vite-node examples/service-failover/index.ts
 */

import { Meridian } from "../../src/index.js";

async function main() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      openai: {
        auth: { apiKey: process.env.OPENAI_API_KEY ?? "sk-placeholder" },
      },
      anthropic: {
        auth: { apiKey: process.env.ANTHROPIC_API_KEY ?? "sk-placeholder" },
      },
      gemini: {
        auth: { apiKey: process.env.GEMINI_API_KEY ?? "placeholder" },
      },
    },
    services: {
      // Logical service name. Application never touches "openai"/"anthropic"/"gemini".
      llm: {
        providers: ["openai", "anthropic", "gemini"],
        strategy: "failover",
        failoverOn: ["rate_limit", "network", "provider"],
      },
      // Cost-optimised variant
      cheapLlm: {
        providers: ["openai", "anthropic", "gemini"],
        strategy: "cheapest",
        costs: { openai: 0.03, anthropic: 0.01, gemini: 0.002 },
      },
    },
  });

  console.log(
    "Configured providers:",
    meridian.providers().map((p) => p.name),
  );

  console.log("\n--- Failover routing ---");
  try {
    // Application calls "llm" — it doesn't know which vendor responds
    const result = await meridian.service("llm")!.post("/v1/chat/completions", {
      body: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Say hello in one word." }],
      },
    });
    console.log("Response provider:", result.meta.provider);
    console.log("Trace:", result.meta.trace);
  } catch (err) {
    console.log(
      "All providers failed (expected in demo without real keys):",
      (err as Error).message,
    );
  }

  console.log("\n--- Cheapest routing (Gemini, cost $0.002) ---");
  try {
    await meridian.service("cheapLlm")!.post("/v1/generateContent", { body: {} });
  } catch (err) {
    console.log("Expected failure (no real key):", (err as Error).message.slice(0, 80));
  }

  console.log("\n--- Live health after requests ---");
  console.log(meridian.health());

  console.log("\n--- Analytics ---");
  console.log(meridian.analytics());
}

main().catch(console.error);
