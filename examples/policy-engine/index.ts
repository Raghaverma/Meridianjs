/**
 * Policy Engine Example
 *
 * Demonstrates how to enforce compliance rules at the SDK layer.
 * Policies run before the request leaves the process — no network round-trip wasted.
 *
 * Run: vite-node examples/policy-engine/index.ts
 */

import {
  Meridian,
  MeridianError,
  allowedProviders,
  blockPII,
  customPolicy,
  readOnly,
} from "../../src/public.js";

async function main() {
  const meridian = await Meridian.create({
    localUnsafe: true,
    providers: {
      openai: { auth: { apiKey: process.env.OPENAI_API_KEY ?? "placeholder" } },
      github: { auth: { token: process.env.GITHUB_TOKEN ?? "placeholder" } },
    },
    policies: [
      // Block requests containing PII to OpenAI
      blockPII(["openai"]),

      // Only these two providers are permitted
      allowedProviders(["openai", "github"]),

      // No writes to GitHub (read-only access)
      readOnly(["github"]),

      // Custom business rule: all OpenAI requests must include a tenantId
      customPolicy("require-tenant-id", (ctx) => {
        if (ctx.provider !== "openai") return { allow: true };
        const body = ctx.body as Record<string, unknown> | undefined;
        return body?.tenantId
          ? { allow: true }
          : { allow: false, reason: "tenantId is required for all OpenAI requests" };
      }),
    ],
  });

  // 1. Clean request — should be allowed (and fail only because of bad API key)
  console.log("--- Clean request (allowed by policy) ---");
  try {
    await meridian.provider("openai")!.post("/v1/chat/completions", {
      body: { tenantId: "tenant_123", messages: [{ role: "user", content: "Hello" }] },
    });
  } catch (err) {
    if (err instanceof MeridianError && err.category !== "validation") {
      console.log("Allowed by policy, failed on network/auth (expected):", err.category);
    } else {
      console.log("Blocked by policy:", (err as MeridianError).message);
    }
  }

  // 2. PII in request body — blocked before hitting network
  console.log("\n--- PII in body (blocked) ---");
  try {
    await meridian.provider("openai")!.post("/v1/chat/completions", {
      body: {
        tenantId: "tenant_123",
        messages: [{ role: "user", content: "My credit card is 4111 1111 1111 1111" }],
      },
    });
  } catch (err) {
    if (err instanceof MeridianError) {
      console.log(`Blocked: [${err.category}] ${err.message}`);
    }
  }

  // 3. Missing tenantId — custom policy blocks it
  console.log("\n--- Missing tenantId (blocked by custom policy) ---");
  try {
    await meridian.provider("openai")!.post("/v1/chat/completions", {
      body: { messages: [{ role: "user", content: "Hello" }] },
    });
  } catch (err) {
    if (err instanceof MeridianError) {
      console.log(`Blocked: [${err.category}] ${err.message}`);
    }
  }

  // 4. Write to GitHub — blocked by readOnly policy
  console.log("\n--- POST to GitHub (blocked by readOnly) ---");
  try {
    await meridian.provider("github")!.post("/repos/owner/repo/issues", {
      body: { title: "Test issue" },
    });
  } catch (err) {
    if (err instanceof MeridianError) {
      console.log(`Blocked: [${err.category}] ${err.message}`);
    }
  }

  // 5. Blocked provider
  console.log("\n--- Request to stripe (not in allowedProviders) ---");
  try {
    await meridian.registerProvider("stripe", {} as any, { auth: {} });
  } catch (err) {
    console.log("Cannot register (expected — no adapter):", (err as Error).message.slice(0, 60));
  }
}

main().catch(console.error);
