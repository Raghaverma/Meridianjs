import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../core/types.js";
import { allowedProviders, blockPII, blockedProviders, customPolicy, readOnly } from "./builtin.js";

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  provider: "openai",
  endpoint: "/v1/chat/completions",
  method: "POST",
  ...overrides,
});

describe("blockPII", () => {
  it("allows clean requests", () => {
    const policy = blockPII();
    expect(policy.evaluate(ctx({ body: { message: "Hello world" } })).allow).toBe(true);
  });

  it("blocks credit card numbers in body", () => {
    const policy = blockPII();
    const result = policy.evaluate(ctx({ body: { card: "4111 1111 1111 1111" } }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("PII");
  });

  it("blocks SSN patterns", () => {
    const policy = blockPII();
    const result = policy.evaluate(ctx({ body: { ssn: "123-45-6789" } }));
    expect(result.allow).toBe(false);
  });

  it("blocks email addresses", () => {
    const policy = blockPII();
    const result = policy.evaluate(ctx({ body: { email: "user@example.com" } }));
    expect(result.allow).toBe(false);
  });

  it("blocks PII in query params", () => {
    const policy = blockPII();
    const result = policy.evaluate(ctx({ query: { email: "user@example.com" } }));
    expect(result.allow).toBe(false);
  });

  it("only blocks specified providers", () => {
    const policy = blockPII(["openai"]);
    // anthropic is not in the block list — should be allowed even with PII
    const result = policy.evaluate(
      ctx({ provider: "anthropic", body: { card: "4111 1111 1111 1111" } }),
    );
    expect(result.allow).toBe(true);
  });

  it("blocks all providers when no list given", () => {
    const policy = blockPII();
    const result = policy.evaluate(
      ctx({ provider: "anthropic", body: { card: "4111 1111 1111 1111" } }),
    );
    expect(result.allow).toBe(false);
  });

  it("allows when specified provider matches but no PII", () => {
    const policy = blockPII(["openai"]);
    expect(policy.evaluate(ctx({ body: { message: "clean" } })).allow).toBe(true);
  });
});

describe("allowedProviders", () => {
  it("allows listed providers", () => {
    const policy = allowedProviders(["openai", "stripe"]);
    expect(policy.evaluate(ctx({ provider: "openai" })).allow).toBe(true);
    expect(policy.evaluate(ctx({ provider: "stripe" })).allow).toBe(true);
  });

  it("blocks unlisted providers", () => {
    const policy = allowedProviders(["openai"]);
    const result = policy.evaluate(ctx({ provider: "anthropic" }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("anthropic");
  });
});

describe("blockedProviders", () => {
  it("blocks listed providers", () => {
    const policy = blockedProviders(["openai"]);
    const result = policy.evaluate(ctx({ provider: "openai" }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("openai");
  });

  it("allows unlisted providers", () => {
    const policy = blockedProviders(["openai"]);
    expect(policy.evaluate(ctx({ provider: "anthropic" })).allow).toBe(true);
  });
});

describe("readOnly", () => {
  it("allows GET requests", () => {
    const policy = readOnly();
    expect(policy.evaluate(ctx({ method: "GET" })).allow).toBe(true);
  });

  it("blocks POST requests", () => {
    const policy = readOnly();
    const result = policy.evaluate(ctx({ method: "POST" }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("POST");
  });

  it("blocks PUT, PATCH, DELETE", () => {
    const policy = readOnly();
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect(policy.evaluate(ctx({ method })).allow).toBe(false);
    }
  });

  it("only applies to specified providers", () => {
    const policy = readOnly(["github"]);
    // POST to openai should be allowed since github-only
    expect(policy.evaluate(ctx({ provider: "openai", method: "POST" })).allow).toBe(true);
    // POST to github should be blocked
    const result = policy.evaluate(ctx({ provider: "github", method: "POST" }));
    expect(result.allow).toBe(false);
  });
});

describe("customPolicy", () => {
  it("evaluates the provided function", () => {
    const policy = customPolicy("require-user-id", (c) =>
      c.body && typeof c.body === "object" && "userId" in c.body
        ? { allow: true }
        : { allow: false, reason: "userId missing" },
    );
    expect(policy.evaluate(ctx({ body: { userId: "u1" } })).allow).toBe(true);
    const result = policy.evaluate(ctx({ body: {} }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toBe("userId missing");
  });

  it("uses the provided name", () => {
    const policy = customPolicy("my-policy", () => ({ allow: true }));
    expect(policy.name).toBe("my-policy");
  });
});
