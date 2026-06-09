import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../core/types.js";
import {
  allowedProviders,
  blockedProviders,
  blockPII,
  customPolicy,
  denyCountries,
  readOnly,
  redact,
  requireFields,
} from "./builtin.js";

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

describe("redact", () => {
  it("allows requests and returns a transform", () => {
    const policy = redact(["ssn"]);
    const result = policy.evaluate(ctx({ body: { name: "Alice", ssn: "123-45-6789" } }));
    expect(result.allow).toBe(true);
  });

  it("transform replaces the field with [REDACTED]", () => {
    const policy = redact(["ssn"]);
    const body = { name: "Alice", ssn: "123-45-6789" };
    const result = policy.evaluate(ctx({ body }));
    if (result.allow && result.transform) {
      const patch = result.transform(ctx({ body }));
      expect((patch.body as { ssn: string }).ssn).toBe("[REDACTED]");
      expect((patch.body as { name: string }).name).toBe("Alice");
    }
  });

  it("supports dot-notation for nested fields", () => {
    const policy = redact(["user.ssn"]);
    const body = { user: { name: "Bob", ssn: "123-45-6789" } };
    const result = policy.evaluate(ctx({ body }));
    if (result.allow && result.transform) {
      const patch = result.transform(ctx({ body }));
      const user = (patch.body as { user: { ssn: string; name: string } }).user;
      expect(user.ssn).toBe("[REDACTED]");
      expect(user.name).toBe("Bob");
    }
  });

  it("only applies to specified providers", () => {
    const policy = redact(["ssn"], ["openai"]);
    const body = { ssn: "123-45-6789" };
    const result = policy.evaluate(ctx({ provider: "stripe", body }));
    expect(result.allow).toBe(true);
    if (result.allow) expect(result.transform).toBeUndefined();
  });

  it("passes through when body is undefined", () => {
    const policy = redact(["ssn"]);
    const result = policy.evaluate(ctx());
    expect(result.allow).toBe(true);
    if (result.allow) expect(result.transform).toBeUndefined();
  });
});

describe("requireFields", () => {
  it("allows when all required fields are present", () => {
    const policy = requireFields(["tenantId", "userId"]);
    expect(policy.evaluate(ctx({ body: { tenantId: "t1", userId: "u1" } })).allow).toBe(true);
  });

  it("blocks when a required field is missing", () => {
    const policy = requireFields(["tenantId"]);
    const result = policy.evaluate(ctx({ body: { userId: "u1" } }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("tenantId");
  });

  it("blocks when body is null", () => {
    const policy = requireFields(["tenantId"]);
    const result = policy.evaluate(ctx({ body: null }));
    expect(result.allow).toBe(false);
  });

  it("blocks when field is explicitly null", () => {
    const policy = requireFields(["tenantId"]);
    const result = policy.evaluate(ctx({ body: { tenantId: null } }));
    expect(result.allow).toBe(false);
  });

  it("skips check for non-targeted providers", () => {
    const policy = requireFields(["tenantId"], ["openai"]);
    expect(policy.evaluate(ctx({ provider: "stripe", body: {} })).allow).toBe(true);
  });
});

describe("denyCountries", () => {
  it("blocks requests matching denied country code", () => {
    const policy = denyCountries(["KP", "IR"]);
    const result = policy.evaluate(ctx({ body: { country: "KP" } }));
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.reason).toContain("KP");
  });

  it("is case-insensitive", () => {
    const policy = denyCountries(["KP"]);
    const result = policy.evaluate(ctx({ body: { country: "kp" } }));
    expect(result.allow).toBe(false);
  });

  it("allows non-denied countries", () => {
    const policy = denyCountries(["KP"]);
    expect(policy.evaluate(ctx({ body: { country: "IN" } })).allow).toBe(true);
  });

  it("checks country_code field as well", () => {
    const policy = denyCountries(["IR"]);
    const result = policy.evaluate(ctx({ body: { country_code: "IR" } }));
    expect(result.allow).toBe(false);
  });

  it("supports custom field name", () => {
    const policy = denyCountries(["KP"], "shipping_country");
    const result = policy.evaluate(ctx({ body: { shipping_country: "KP" } }));
    expect(result.allow).toBe(false);
  });

  it("allows when body has no country field", () => {
    const policy = denyCountries(["KP"]);
    expect(policy.evaluate(ctx({ body: { name: "Alice" } })).allow).toBe(true);
  });
});
